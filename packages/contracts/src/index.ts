import { z } from "zod";

export const SESSION_STATUSES = [
  "accepted",
  "queued",
  "starting",
  "browser_ready",
  "running",
  "completing",
  "completed",
  "failed",
  "cancelled",
  "expired",
  "security_blocked"
] as const;

export const SessionStatusSchema = z.enum(SESSION_STATUSES);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const TERMINAL_SESSION_STATUSES: ReadonlySet<SessionStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "expired",
  "security_blocked"
]);

export const FeatureRouteSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9_-]+$/),
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(1_000),
  path: z
    .string()
    .min(1)
    .max(2_000)
    .regex(/^\/(?!\/)[^\s#]*$/, "Expected a same-origin path without a fragment"),
  successHint: z.string().max(500).optional()
});
export type FeatureRoute = z.infer<typeof FeatureRouteSchema>;

const OriginSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.origin === value &&
      !url.username &&
      !url.password &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))
    );
  }, "Expected an HTTPS origin without a path, credentials, query, or fragment");

const HostSchema = z
  .string()
  .min(1)
  .max(253)
  .transform((value) => value.toLowerCase())
  .refine((value) => {
    try {
      const url = new URL(`https://${value}`);
      return url.hostname === value && url.port === "" && url.pathname === "/";
    } catch {
      return false;
    }
  }, "Expected a hostname without scheme, port, path, or credentials");

export const IntegrationSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    id: z
      .string()
      .min(3)
      .max(80)
      .regex(/^[a-zA-Z0-9_-]+$/),
    name: z.string().min(1).max(120),
    enabled: z.boolean().default(true),
    allowedOrigins: z.array(OriginSchema).min(1).max(50),
    startUrl: z.string().url(),
    allowedHosts: z.array(HostSchema).min(1).max(50),
    features: z.array(FeatureRouteSchema).min(1).max(200),
    fixtures: z.record(z.string().min(1).max(80), z.string().max(2_000)).default({}),
    allowedActionIds: z
      .array(
        z
          .string()
          .min(1)
          .max(80)
          .regex(/^[a-z0-9_-]+$/)
      )
      .max(200)
      .default([]),
    forbiddenActionPatterns: z
      .array(z.string().min(1).max(120))
      .max(100)
      .default(["delete", "remove", "purchase", "pay", "invite", "send email"]),
    steelProfileId: z.string().min(1).max(200).optional(),
    maxDurationSeconds: z.number().int().min(60).max(1_200).default(600),
    maxSteps: z.number().int().min(1).max(50).default(20),
    maxConcurrentSessions: z.number().int().min(1).max(1_000).default(5),
    turnstileRequired: z.boolean().default(true),
    productGuide: z.string().min(1).max(30_000),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .superRefine((integration, context) => {
    const startUrl = new URL(integration.startUrl);
    const hostname = startUrl.hostname.toLowerCase();
    if (startUrl.protocol !== "https:" || startUrl.username || startUrl.password || startUrl.hash) {
      context.addIssue({
        code: "custom",
        path: ["startUrl"],
        message: "startUrl must be HTTPS and cannot contain credentials or a fragment"
      });
    }
    if (!integration.allowedHosts.includes(hostname)) {
      context.addIssue({
        code: "custom",
        path: ["startUrl"],
        message: "startUrl hostname must be present in allowedHosts"
      });
    }
    for (const [path, values] of [
      ["allowedOrigins", integration.allowedOrigins],
      ["allowedHosts", integration.allowedHosts],
      ["allowedActionIds", integration.allowedActionIds],
      ["features", integration.features.map((feature) => feature.id)]
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({ code: "custom", path: [path], message: `${path} must be unique` });
      }
    }
  });
export type Integration = z.infer<typeof IntegrationSchema>;

export const CreateSessionRequestSchema = z.object({
  goal: z.string().trim().min(3).max(1_000),
  turnstileToken: z.string().min(1).max(4_096).optional(),
  locale: z
    .string()
    .min(2)
    .max(35)
    .refine((locale) => {
      try {
        return Intl.getCanonicalLocales(locale).length === 1;
      } catch {
        return false;
      }
    }, "Expected a valid BCP 47 locale")
    .default("en")
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

export const CreateSessionResponseSchema = z.object({
  sessionId: z.string(),
  accessToken: z.string(),
  expiresAt: z.string().datetime(),
  eventsUrl: z.string().url(),
  viewUrl: z.string().url()
});
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;

export const AddMessageRequestSchema = z.object({
  message: z.string().trim().min(1).max(1_000)
});
export type AddMessageRequest = z.infer<typeof AddMessageRequestSchema>;

export const SessionEventTypeSchema = z.enum([
  "session.accepted",
  "session.queued",
  "session.starting",
  "session.viewer_ready",
  "session.running",
  "session.completed",
  "session.cancelled",
  "session.failed",
  "session.expired",
  "session.recovering",
  "session.cleanup_failed",
  "visitor.message",
  "agent.narration",
  "agent.action_started",
  "agent.action_completed",
  "agent.action_failed",
  "provider.request_started",
  "provider.request_completed",
  "provider.request_failed",
  "security.blocked"
]);
export type SessionEventType = z.infer<typeof SessionEventTypeSchema>;

export const SessionEventSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  id: z.string(),
  sessionId: z.string(),
  sequence: z.number().int().nonnegative(),
  type: SessionEventTypeSchema,
  data: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime()
});
export type SessionEvent = z.infer<typeof SessionEventSchema>;

export const DemoSessionSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  id: z.string(),
  integrationId: z.string(),
  origin: z.string().url(),
  goal: z.string().min(1).max(1_000),
  locale: z.string(),
  status: SessionStatusSchema,
  tokenHash: z.string(),
  traceId: z.string(),
  idempotencyKeyHash: z.string(),
  requestHash: z.string().length(64).optional(),
  steelSessionId: z.string().optional(),
  viewerUrl: z.string().url().optional(),
  leaseOwner: z.string().optional(),
  leaseExpiresAt: z.string().datetime().optional(),
  lastHeartbeatAt: z.string().datetime().optional(),
  eventSequence: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  failureCode: z.string().max(100).optional(),
  failureMessage: z.string().max(500).optional()
});
export type DemoSession = z.infer<typeof DemoSessionSchema>;

export const ToolNameSchema = z.enum([
  "inspect_page",
  "go_to_feature",
  "click_element",
  "type_demo_value",
  "scroll_page",
  "wait_for_page",
  "narrate",
  "finish_demo"
]);
export type ToolName = z.infer<typeof ToolNameSchema>;

export const ToolCallRecordSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  id: z.string(),
  sessionId: z.string(),
  step: z.number().int().positive(),
  name: ToolNameSchema,
  arguments: z.record(z.string(), z.unknown()),
  status: z.enum(["pending", "running", "completed", "failed", "interrupted", "denied"]),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.string().max(1_000).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type ToolCallRecord = z.infer<typeof ToolCallRecordSchema>;

export interface EventPage {
  events: SessionEvent[];
  nextSequence: number;
}
