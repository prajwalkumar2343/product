import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import {
  CreateSessionRequestSchema,
  AddMessageRequestSchema,
  TERMINAL_SESSION_STATUSES,
  type DemoSession
} from "@product/contracts";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { loadConfig, type AppConfig } from "./config.js";
import { SessionTokens, deterministicSessionId, hashValue, originAllowed } from "./security.js";
import { FirestoreSessionStore, type SessionStore } from "./store.js";
import { CloudTaskDispatcher, type TaskDispatcher } from "./tasks.js";

interface ApiDependencies {
  config: AppConfig;
  store: SessionStore;
  tasks: TaskDispatcher;
  verifyChallenge(
    token: string | undefined,
    remoteIp: string,
    expectedHostname: string
  ): Promise<boolean>;
}

interface SessionParams {
  sessionId: string;
}
interface IntegrationParams {
  integrationId: string;
}

const TurnstileResponseSchema = z.object({
  success: z.boolean(),
  hostname: z.string().optional(),
  action: z.string().optional()
});

export function buildApi(dependencies: ApiDependencies) {
  const { config, store, tasks } = dependencies;
  const tokens = new SessionTokens(config.SESSION_HMAC_SECRET);
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    trustProxy: 1,
    bodyLimit: 16_384,
    requestTimeout: 15_000
  });

  void app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" }
  });
  void app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
    keyGenerator: (request) => `${request.ip}:${request.headers.origin ?? "none"}`
  });

  app.addHook("onRequest", (_request, reply, done) => {
    reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer");
    done();
  });

  app.get("/healthz", () => ({ ok: true }));
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: "not_found" }));
  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error, requestId: request.id }, "unhandled API error");
    return reply.code(500).send({ error: "internal_error", requestId: request.id });
  });

  app.options<{ Params: IntegrationParams }>(
    "/v1/integrations/:integrationId/sessions",
    async (request, reply) => {
      const integration = await store.getIntegration(request.params.integrationId);
      const origin = readOrigin(request);
      if (!integration || !origin || !originAllowed(origin, integration.allowedOrigins))
        return reply.code(403).send({ error: "origin_not_allowed" });
      applyCors(reply, origin, "POST, OPTIONS");
      return reply.code(204).send();
    }
  );

  app.post<{ Params: IntegrationParams }>(
    "/v1/integrations/:integrationId/sessions",
    { config: { rateLimit: { max: 12, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const integration = await store.getIntegration(request.params.integrationId);
      const origin = readOrigin(request);
      if (!integration?.enabled || !origin || !originAllowed(origin, integration.allowedOrigins))
        return reply.code(403).send({ error: "origin_not_allowed" });
      applyCors(reply, origin, "POST, OPTIONS");
      const parsed = CreateSessionRequestSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
      const idempotencyKey = readSingleHeader(request, "idempotency-key");
      if (!idempotencyKey || idempotencyKey.length < 16 || idempotencyKey.length > 200)
        return reply.code(400).send({ error: "invalid_idempotency_key" });
      if (
        integration.turnstileRequired &&
        !(await dependencies.verifyChallenge(
          parsed.data.turnstileToken,
          request.ip,
          new URL(origin).hostname
        ))
      )
        return reply.code(403).send({ error: "challenge_failed" });

      const sessionId = deterministicSessionId(
        config.SESSION_HMAC_SECRET,
        integration.id,
        idempotencyKey
      );
      const accessToken = tokens.issue(sessionId, idempotencyKey);
      const existing = await store.getSession(sessionId);
      if (existing) {
        if (existing.origin !== origin || existing.idempotencyKeyHash !== hashValue(idempotencyKey))
          return reply.code(409).send({ error: "idempotency_conflict" });
        return reply.code(200).send(responseFor(config, existing, accessToken));
      }
      const now = new Date();
      const expiresAt = new Date(
        now.getTime() + integration.maxDurationSeconds * 1_000
      ).toISOString();
      const session: DemoSession = {
        schemaVersion: 1,
        id: sessionId,
        integrationId: integration.id,
        origin,
        goal: parsed.data.goal,
        locale: parsed.data.locale,
        status: "accepted",
        tokenHash: hashValue(accessToken),
        traceId: crypto.randomUUID(),
        idempotencyKeyHash: hashValue(idempotencyKey),
        eventSequence: 0,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        expiresAt
      };
      const admission = await store.admitSession(session, integration.maxConcurrentSessions);
      if (admission === "capacity")
        return reply.code(429).send({ error: "integration_at_capacity", retryAfterSeconds: 10 });
      if (admission === "admitted") {
        try {
          await tasks.enqueueSession(session.id);
          await store.transitionWithEvent({
            sessionId: session.id,
            from: ["accepted"],
            to: "queued",
            eventType: "session.queued"
          });
        } catch (error) {
          request.log.error({ err: error, sessionId }, "task enqueue failed");
          await store.transitionWithEvent({
            sessionId: session.id,
            from: ["accepted"],
            to: "failed",
            eventType: "session.failed",
            eventData: { code: "enqueue_failed" },
            patch: {
              failureCode: "enqueue_failed",
              failureMessage: "The demo could not be scheduled.",
              completedAt: new Date().toISOString()
            }
          });
          return reply.code(503).send({ error: "temporarily_unavailable" });
        }
      }
      return reply.code(202).send(responseFor(config, session, accessToken));
    }
  );

  app.options<{ Params: SessionParams }>("/v1/sessions/:sessionId/*", async (request, reply) => {
    const session = await store.getSession(request.params.sessionId);
    const origin = readOrigin(request);
    if (!session || !origin || session.origin !== origin) return reply.code(403).send();
    applyCors(reply, origin, "GET, POST, DELETE, OPTIONS");
    return reply.code(204).send();
  });

  app.get<{ Params: SessionParams }>("/v1/sessions/:sessionId/events", async (request, reply) => {
    const session = await authorizeSession(request, reply, store, tokens);
    if (!session) return;
    applyCors(reply, session.origin, "GET, OPTIONS");
    const after = Math.max(0, Number((request.query as { after?: string }).after ?? 0) || 0);
    return { events: await store.listEvents(session.id, after, 100) };
  });

  app.get<{ Params: SessionParams }>("/v1/sessions/:sessionId/stream", async (request, reply) => {
    const session = await authorizeSession(request, reply, store, tokens);
    if (!session) return;
    applyCors(reply, session.origin, "GET, OPTIONS");
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": session.origin,
      Vary: "Origin"
    });
    let sequence = Math.max(0, Number(request.headers["last-event-id"] ?? 0) || 0);
    const deadline = Date.now() + 55_000;
    while (!reply.raw.destroyed && Date.now() < deadline) {
      const events = await store.listEvents(session.id, sequence, 100);
      for (const event of events) {
        sequence = event.sequence;
        reply.raw.write(
          `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
        );
      }
      const current = await store.getSession(session.id);
      if (!current || TERMINAL_SESSION_STATUSES.has(current.status)) break;
      reply.raw.write(": keepalive\n\n");
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    reply.raw.end();
  });

  app.get<{ Params: SessionParams }>("/v1/sessions/:sessionId/view", async (request, reply) => {
    const session = await authorizeSession(request, reply, store, tokens);
    if (!session) return;
    applyCors(reply, session.origin, "GET, OPTIONS");
    if (!session.viewerUrl) return reply.code(404).send({ error: "viewer_not_ready" });
    return { viewerUrl: session.viewerUrl, expiresAt: session.expiresAt };
  });

  app.post<{ Params: SessionParams }>(
    "/v1/sessions/:sessionId/messages",
    async (request, reply) => {
      const session = await authorizeSession(request, reply, store, tokens);
      if (!session) return;
      applyCors(reply, session.origin, "POST, OPTIONS");
      const parsed = AddMessageRequestSchema.safeParse(request.body);
      if (!parsed.success || TERMINAL_SESSION_STATUSES.has(session.status))
        return reply.code(409).send({ error: "session_not_active" });
      await store.appendEvent(session.id, "visitor.message", { message: parsed.data.message });
      return reply.code(202).send({ accepted: true });
    }
  );

  app.delete<{ Params: SessionParams }>("/v1/sessions/:sessionId", async (request, reply) => {
    const session = await authorizeSession(request, reply, store, tokens);
    if (!session) return;
    applyCors(reply, session.origin, "DELETE, OPTIONS");
    const cancelled = await store.transitionWithEvent({
      sessionId: session.id,
      from: ["accepted", "queued", "starting", "browser_ready", "running", "completing"],
      to: "cancelled",
      eventType: "session.cancelled",
      patch: { completedAt: new Date().toISOString() }
    });
    return reply.code(202).send({ cancelled: Boolean(cancelled) });
  });

  return app;
}

function readOrigin(request: FastifyRequest): string | null {
  const value = request.headers.origin;
  return typeof value === "string" ? value : null;
}

function readSingleHeader(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  return typeof value === "string" ? value : null;
}

function applyCors(reply: FastifyReply, origin: string, methods: string): void {
  reply
    .header("Access-Control-Allow-Origin", origin)
    .header("Access-Control-Allow-Methods", methods)
    .header(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, Idempotency-Key, Last-Event-ID"
    )
    .header("Access-Control-Max-Age", "600")
    .header("Vary", "Origin");
}

async function authorizeSession(
  request: FastifyRequest<{ Params: SessionParams }>,
  reply: FastifyReply,
  store: SessionStore,
  tokens: SessionTokens
): Promise<DemoSession | null> {
  const session = await store.getSession(request.params.sessionId);
  const origin = readOrigin(request);
  const authorization = request.headers.authorization;
  if (
    !session ||
    session.expiresAt <= new Date().toISOString() ||
    !origin ||
    session.origin !== origin ||
    !authorization?.startsWith("Bearer ") ||
    !tokens.verify(authorization.slice(7), session.id, session.tokenHash)
  ) {
    await reply.code(401).send({ error: "unauthorized" });
    return null;
  }
  return session;
}

function responseFor(config: AppConfig, session: DemoSession, accessToken: string) {
  const base = config.PUBLIC_API_URL.replace(/\/$/, "");
  return {
    sessionId: session.id,
    accessToken,
    expiresAt: session.expiresAt,
    eventsUrl: `${base}/v1/sessions/${session.id}/stream`,
    viewUrl: `${base}/v1/sessions/${session.id}/view`
  };
}

export async function verifyTurnstile(
  secret: string | undefined,
  token: string | undefined,
  remoteIp: string,
  expectedHostname: string
): Promise<boolean> {
  if (!secret) return false;
  if (!token) return false;
  const body = new URLSearchParams({ secret, response: token, remoteip: remoteIp });
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) return false;
    const result = TurnstileResponseSchema.parse(await response.json());
    return Boolean(
      result.success && result.hostname === expectedHostname && result.action === "product_demo"
    );
  } catch {
    return false;
  }
}

if (process.env.NODE_ENV !== "test") {
  const config = loadConfig();
  const store = new FirestoreSessionStore(config.GCP_PROJECT_ID, config.FIRESTORE_DATABASE);
  const tasks = new CloudTaskDispatcher({
    projectId: config.GCP_PROJECT_ID,
    region: config.GCP_REGION,
    queue: config.TASK_QUEUE,
    runnerUrl: config.RUNNER_URL,
    ...(config.TASK_INVOKER_SERVICE_ACCOUNT
      ? { serviceAccountEmail: config.TASK_INVOKER_SERVICE_ACCOUNT }
      : {})
  });
  const app = buildApi({
    config,
    store,
    tasks,
    verifyChallenge: (token, ip, hostname) =>
      verifyTurnstile(config.TURNSTILE_SECRET, token, ip, hostname)
  });
  await app.listen({ host: "0.0.0.0", port: config.PORT });
}
