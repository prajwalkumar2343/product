import type { DemoSession, Integration } from "@product/contracts";
import { describe, expect, it, vi } from "vitest";
import { sweepExpiredSessions } from "./runner.js";
import type { BrowserProvider } from "./steel.js";
import { MemoryStore } from "./test-memory-store.js";

describe("session recovery", () => {
  it("expires stale sessions, releases Steel, and restores capacity", async () => {
    const store = new MemoryStore();
    const integration = makeIntegration();
    await store.putIntegration(integration);
    await store.admitSession(makeSession("old", "2025-01-01T00:00:00.000Z"), 1);
    const release = vi.fn().mockResolvedValue(undefined);
    const provider = { release, create: vi.fn() } as unknown as BrowserProvider;
    expect(await sweepExpiredSessions(store, provider, "2026-01-01T00:00:00.000Z")).toBe(1);
    expect(release).toHaveBeenCalledWith("steel-old");
    expect((await store.getSession("old"))?.status).toBe("expired");
    expect(await store.admitSession(makeSession("new", "2027-01-01T00:00:00.000Z"), 1)).toBe(
      "admitted"
    );
  });
});

function makeIntegration(): Integration {
  return {
    schemaVersion: 1,
    id: "acme",
    name: "Acme",
    enabled: true,
    allowedOrigins: ["https://www.example.com"],
    startUrl: "https://demo.example.com",
    allowedHosts: ["demo.example.com"],
    features: [{ id: "home", name: "Home", description: "Home", path: "/" }],
    fixtures: {},
    allowedActionIds: [],
    forbiddenActionPatterns: ["delete"],
    maxDurationSeconds: 600,
    maxSteps: 5,
    maxConcurrentSessions: 1,
    turnstileRequired: true,
    productGuide: "Guide",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function makeSession(id: string, expiresAt: string): DemoSession {
  return {
    schemaVersion: 1,
    id,
    integrationId: "acme",
    origin: "https://www.example.com",
    goal: "Show demo",
    locale: "en",
    status: "running",
    tokenHash: "hash",
    traceId: "trace",
    idempotencyKeyHash: id,
    steelSessionId: `steel-${id}`,
    eventSequence: 0,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    expiresAt
  };
}
