import { TERMINAL_SESSION_STATUSES } from "@product/contracts";
import Fastify from "fastify";
import { DemoAgent } from "./agent.js";
import { DemoBrowser } from "./browser.js";
import { loadConfig } from "./config.js";
import { OpenAiCompatibleProvider } from "./model.js";
import { SteelBrowserProvider, type BrowserProvider } from "./steel.js";
import { FirestoreSessionStore, type SessionStore } from "./store.js";

export async function runSession(
  sessionId: string,
  workerId: string,
  store: SessionStore,
  steel: BrowserProvider,
  agentFactory: () => DemoAgent,
  steelApiKey: string
): Promise<"ran" | "skipped"> {
  const leaseUntil = new Date(Date.now() + 45_000).toISOString();
  const session = await store.claimLease(sessionId, workerId, leaseUntil);
  if (!session) return "skipped";
  const integration = await store.getIntegration(session.integrationId);
  if (!integration?.enabled) {
    await fail(store, session.id, "integration_disabled", "This integration is unavailable.");
    return "ran";
  }

  let steelSession: Awaited<ReturnType<BrowserProvider["create"]>> | undefined;
  let browser: DemoBrowser | undefined;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("Session deadline exceeded")),
    integration.maxDurationSeconds * 1_000
  );
  const heartbeat = setInterval(() => {
    void store
      .heartbeat(session.id, workerId, new Date(Date.now() + 45_000).toISOString())
      .then((alive) => {
        if (!alive) controller.abort(new Error("Session lease lost"));
      })
      .catch((error: unknown) => {
        controller.abort(error instanceof Error ? error : new Error("Session heartbeat failed"));
      });
  }, 15_000);

  try {
    const interrupted = await store.interruptRunningToolCalls(session.id);
    if (session.steelSessionId) {
      let previousReleaseSucceeded = true;
      try {
        await steel.release(session.steelSessionId);
      } catch {
        previousReleaseSucceeded = false;
      }
      await store.appendEvent(session.id, "session.recovering", {
        interruptedToolCalls: interrupted,
        previousReleaseSucceeded
      });
    }
    const started = await store.transitionWithEvent({
      sessionId: session.id,
      from: ["accepted", "queued", "starting", "browser_ready", "running"],
      to: "starting",
      eventType: "session.starting"
    });
    if (!started) return "skipped";
    steelSession = await steel.create({
      timeoutMilliseconds: integration.maxDurationSeconds * 1_000,
      ...(integration.steelProfileId ? { profileId: integration.steelProfileId } : {})
    });
    await store.transitionWithEvent({
      sessionId: session.id,
      from: ["starting"],
      to: "browser_ready",
      eventType: "session.viewer_ready",
      patch: { steelSessionId: steelSession.id, viewerUrl: steelSession.viewerUrl }
    });
    browser = await DemoBrowser.connect(steelSession.websocketUrl, steelApiKey, integration);
    await browser.openStartPage();
    await store.transitionWithEvent({
      sessionId: session.id,
      from: ["browser_ready"],
      to: "running",
      eventType: "session.running"
    });
    await agentFactory().run(session, integration, browser, controller.signal);
    const current = await store.getSession(session.id);
    if (current && !TERMINAL_SESSION_STATUSES.has(current.status)) {
      await store.transitionWithEvent({
        sessionId: session.id,
        from: ["running", "completing"],
        to: "completed",
        eventType: "session.completed",
        patch: { completedAt: new Date().toISOString() }
      });
    }
  } catch (error) {
    const current = await store.getSession(session.id);
    if (
      current &&
      current.status !== "cancelled" &&
      !TERMINAL_SESSION_STATUSES.has(current.status)
    ) {
      await fail(
        store,
        session.id,
        error instanceof Error && error.name === "AbortError" ? "cancelled" : "runner_failed",
        "The live demo stopped unexpectedly."
      );
    }
  } finally {
    clearTimeout(timeout);
    clearInterval(heartbeat);
    const cleanupFailures: string[] = [];
    if (browser) {
      try {
        await browser.close();
      } catch {
        cleanupFailures.push("browser_disconnect");
      }
    }
    if (steelSession) {
      try {
        await steel.release(steelSession.id);
      } catch {
        cleanupFailures.push("steel_release");
      }
    }
    if (cleanupFailures.length > 0) {
      await store
        .appendEvent(session.id, "session.cleanup_failed", { failures: cleanupFailures })
        .catch(() => undefined);
    }
  }
  return "ran";
}

export async function sweepExpiredSessions(
  store: SessionStore,
  steel: BrowserProvider,
  now = new Date().toISOString()
): Promise<number> {
  const expired = await store.listExpiredSessions(now, 100);
  let settled = 0;
  for (const session of expired) {
    const transitioned = await store.transitionWithEvent({
      sessionId: session.id,
      from: ["accepted", "queued", "starting", "browser_ready", "running", "completing"],
      to: "expired",
      eventType: "session.expired",
      patch: {
        completedAt: now,
        failureCode: "session_expired",
        failureMessage: "The demo reached its time limit."
      }
    });
    if (!transitioned) continue;
    settled += 1;
    if (session.steelSessionId) {
      try {
        await steel.release(session.steelSessionId);
      } catch {
        await store
          .appendEvent(session.id, "session.cleanup_failed", { failures: ["steel_release"] })
          .catch(() => undefined);
      }
    }
  }
  return settled;
}

async function fail(
  store: SessionStore,
  sessionId: string,
  code: string,
  message: string
): Promise<void> {
  await store.transitionWithEvent({
    sessionId,
    from: ["accepted", "queued", "starting", "browser_ready", "running", "completing"],
    to: "failed",
    eventType: "session.failed",
    eventData: { code, message },
    patch: { failureCode: code, failureMessage: message, completedAt: new Date().toISOString() }
  });
}

if (process.env.NODE_ENV !== "test") {
  const config = loadConfig();
  const store = new FirestoreSessionStore(config.GCP_PROJECT_ID, config.FIRESTORE_DATABASE);
  const steel = new SteelBrowserProvider({ apiKey: config.STEEL_API_KEY });
  const model = new OpenAiCompatibleProvider(
    config.MODEL_BASE_URL,
    config.MODEL_API_KEY,
    config.MODEL_NAME
  );
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    bodyLimit: 4_096,
    requestTimeout: config.PORT * 0 + 1_210_000
  });
  app.get("/healthz", () => ({ ok: true }));
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: "not_found" }));
  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error, requestId: request.id }, "unhandled runner error");
    return reply.code(500).send({ error: "internal_error", requestId: request.id });
  });
  app.post("/internal/run", async (request, reply) => {
    const taskHeader = request.headers["x-cloudtasks-queuename"];
    const sharedSecret = request.headers["x-runner-secret"];
    const allowed =
      config.NODE_ENV !== "production"
        ? sharedSecret === config.RUNNER_SHARED_SECRET
        : typeof taskHeader === "string";
    if (!allowed) return reply.code(403).send({ error: "forbidden" });
    const body = request.body as { sessionId?: unknown };
    if (typeof body?.sessionId !== "string" || !/^ses_[A-Za-z0-9_-]{32}$/.test(body.sessionId))
      return reply.code(400).send({ error: "invalid_request" });
    const outcome = await runSession(
      body.sessionId,
      `${process.env.K_REVISION ?? "local"}:${crypto.randomUUID()}`,
      store,
      steel,
      () => new DemoAgent(store, model),
      config.STEEL_API_KEY
    );
    return { outcome };
  });
  app.post("/internal/sweep", async (request, reply) => {
    const schedulerHeader = request.headers["x-cloudscheduler"];
    const sharedSecret = request.headers["x-runner-secret"];
    const allowed =
      config.NODE_ENV !== "production"
        ? sharedSecret === config.RUNNER_SHARED_SECRET
        : typeof schedulerHeader === "string";
    if (!allowed) return reply.code(403).send({ error: "forbidden" });
    return { expired: await sweepExpiredSessions(store, steel) };
  });
  await app.listen({ host: "0.0.0.0", port: config.PORT });
}
