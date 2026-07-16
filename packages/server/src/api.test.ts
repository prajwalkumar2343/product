import type { Integration } from "@product/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApi, verifyTurnstile } from "./api.js";
import type { AppConfig } from "./config.js";
import { MemoryStore } from "./test-memory-store.js";

const config: AppConfig = {
  NODE_ENV: "test",
  SERVICE_ROLE: "api",
  PORT: 8080,
  PUBLIC_API_URL: "https://api.example.com",
  SESSION_HMAC_SECRET: "s".repeat(32),
  FIRESTORE_DATABASE: "(default)",
  GCP_PROJECT_ID: "test",
  GCP_REGION: "us-central1",
  TASK_QUEUE: "demo",
  RUNNER_URL: "https://runner.example.com",
  STEEL_API_KEY: "steel",
  MODEL_BASE_URL: "https://model.example.com/v1",
  MODEL_API_KEY: "model",
  MODEL_NAME: "model",
  LOG_LEVEL: "silent"
};
const integration: Integration = {
  schemaVersion: 1,
  id: "acme",
  name: "Acme",
  enabled: true,
  allowedOrigins: ["https://www.example.com"],
  startUrl: "https://demo.example.com",
  allowedHosts: ["demo.example.com"],
  features: [{ id: "home", name: "Home", description: "Home page", path: "/" }],
  fixtures: {},
  allowedActionIds: [],
  forbiddenActionPatterns: ["delete"],
  maxDurationSeconds: 600,
  maxSteps: 10,
  maxConcurrentSessions: 2,
  turnstileRequired: true,
  productGuide: "Demo guide",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

describe("session API", () => {
  const apps: Array<ReturnType<typeof buildApi>> = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    vi.unstubAllGlobals();
  });

  it("rejects an unregistered browser origin", async () => {
    const store = new MemoryStore();
    await store.putIntegration(integration);
    const app = buildApi({
      config,
      store,
      tasks: { enqueueSession: vi.fn() },
      verifyChallenge: vi.fn().mockResolvedValue(true)
    });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/v1/integrations/acme/sessions",
      headers: { origin: "https://evil.example.com", "idempotency-key": "1234567890abcdef" },
      payload: { goal: "show analytics", turnstileToken: "ok" }
    });
    expect(response.statusCode).toBe(403);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("creates one durable task and safely replays an idempotent request", async () => {
    const store = new MemoryStore();
    await store.putIntegration(integration);
    const enqueueSession = vi.fn().mockResolvedValue(undefined);
    const app = buildApi({
      config,
      store,
      tasks: { enqueueSession },
      verifyChallenge: vi.fn().mockResolvedValue(true)
    });
    apps.push(app);
    const request = {
      method: "POST" as const,
      url: "/v1/integrations/acme/sessions",
      headers: { origin: "https://www.example.com", "idempotency-key": "1234567890abcdef" },
      payload: { goal: "show analytics", turnstileToken: "ok" }
    };
    const first = await app.inject(request);
    const second = await app.inject(request);
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    const firstBody = first.json<{ accessToken: string }>();
    const secondBody = second.json<{ accessToken: string }>();
    expect(firstBody.accessToken).toBe(secondBody.accessToken);
    expect(enqueueSession).toHaveBeenCalledTimes(1);
    expect(first.headers["access-control-allow-origin"]).toBe("https://www.example.com");
  });

  it("admits at most the configured capacity under concurrent requests", async () => {
    const store = new MemoryStore();
    await store.putIntegration({ ...integration, maxConcurrentSessions: 1 });
    const enqueueSession = vi.fn().mockResolvedValue(undefined);
    const app = buildApi({
      config,
      store,
      tasks: { enqueueSession },
      verifyChallenge: vi.fn().mockResolvedValue(true)
    });
    apps.push(app);
    const request = (key: string) =>
      app.inject({
        method: "POST",
        url: "/v1/integrations/acme/sessions",
        headers: { origin: "https://www.example.com", "idempotency-key": key },
        payload: { goal: "show analytics", turnstileToken: "ok" }
      });
    const responses = await Promise.all([request("1234567890abcdef"), request("fedcba0987654321")]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([202, 429]);
    expect(enqueueSession).toHaveBeenCalledTimes(1);
  });
});

describe("Turnstile verification", () => {
  it("binds a successful challenge to the expected host and action", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ success: true, hostname: "www.example.com", action: "product_demo" })
        )
    );
    await expect(
      verifyTurnstile("secret", "token", "203.0.113.1", "www.example.com")
    ).resolves.toBe(true);
    await expect(
      verifyTurnstile("secret", "token", "203.0.113.1", "evil.example.com")
    ).resolves.toBe(false);
  });
});
