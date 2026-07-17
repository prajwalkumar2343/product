import type { DemoSession, ToolCallRecord } from "@product/contracts";
import { describe, expect, it } from "vitest";
import { MemoryStore } from "./test-memory-store.js";

function session(overrides: Partial<DemoSession> = {}): DemoSession {
  return {
    schemaVersion: 1,
    id: "ses_123",
    integrationId: "acme",
    origin: "https://www.example.com",
    goal: "Show analytics",
    locale: "en",
    status: "accepted",
    tokenHash: "token",
    traceId: "trace",
    idempotencyKeyHash: "key",
    requestHash: "a".repeat(64),
    eventSequence: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:10:00.000Z",
    ...overrides
  };
}

function call(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    schemaVersion: 1,
    id: "call_1",
    sessionId: "ses_123",
    step: 1,
    name: "inspect_page",
    arguments: {},
    status: "pending",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("MemoryStore production semantics", () => {
  it("makes admission idempotent", async () => {
    const store = new MemoryStore();
    expect(await store.admitSession(session(), 1)).toBe("admitted");
    expect(await store.admitSession(session(), 1)).toBe("exists");
  });

  it("enforces integration capacity", async () => {
    const store = new MemoryStore();
    expect(await store.admitSession(session(), 1)).toBe("admitted");
    expect(await store.admitSession(session({ id: "ses_456" }), 1)).toBe("capacity");
  });

  it("releases capacity exactly once on a terminal transition", async () => {
    const store = new MemoryStore();
    await store.admitSession(session(), 1);
    await store.transitionWithEvent({
      sessionId: "ses_123",
      from: ["accepted"],
      to: "cancelled",
      eventType: "session.cancelled"
    });
    expect(
      await store.transitionWithEvent({
        sessionId: "ses_123",
        from: ["accepted"],
        to: "failed",
        eventType: "session.failed"
      })
    ).toBeNull();
    expect(await store.admitSession(session({ id: "ses_456" }), 1)).toBe("admitted");
  });

  it("does not allow an active lease to be stolen", async () => {
    const store = new MemoryStore();
    await store.admitSession(session(), 1);
    await store.claimLease("ses_123", "worker-a", "2999-01-01T00:00:00.000Z");
    await expect(
      store.claimLease("ses_123", "worker-b", "2999-01-01T00:01:00.000Z")
    ).resolves.toBeNull();
  });

  it("allows an expired lease to be reclaimed", async () => {
    const store = new MemoryStore();
    await store.admitSession(session(), 1);
    await store.claimLease("ses_123", "worker-a", "2020-01-01T00:00:00.000Z");
    const reclaimed = await store.claimLease("ses_123", "worker-b", "2999-01-01T00:00:00.000Z");
    expect(reclaimed?.leaseOwner).toBe("worker-b");
  });

  it("rejects a heartbeat from a stale owner", async () => {
    const store = new MemoryStore();
    await store.admitSession(session(), 1);
    await store.claimLease("ses_123", "worker-a", "2999-01-01T00:00:00.000Z");
    await expect(store.heartbeat("ses_123", "worker-b", "2999-01-01T00:01:00.000Z")).resolves.toBe(
      false
    );
  });

  it("guards state transitions by lease owner", async () => {
    const store = new MemoryStore();
    await store.admitSession(session({ leaseOwner: "worker-a" }), 1);
    await expect(
      store.transitionWithEvent({
        sessionId: "ses_123",
        from: ["accepted"],
        to: "starting",
        eventType: "session.starting",
        leaseOwner: "worker-b"
      })
    ).resolves.toBeNull();
  });

  it("lists events after an exclusive sequence", async () => {
    const store = new MemoryStore();
    await store.admitSession(session(), 1);
    await store.appendEvent("ses_123", "visitor.message", { message: "one" });
    await store.appendEvent("ses_123", "visitor.message", { message: "two" });
    const events = await store.listEvents("ses_123", 1, 10);
    expect(events.map((event) => event.sequence)).toEqual([2, 3]);
  });

  it("requires a running session owned by the caller before starting a tool", async () => {
    const store = new MemoryStore();
    await store.admitSession(session({ status: "running", leaseOwner: "worker-a" }), 1);
    await expect(store.startToolCall(call(), "worker-b")).rejects.toThrow("authorized");
  });

  it("settles a tool call exactly once", async () => {
    const store = new MemoryStore();
    await store.admitSession(session({ status: "running", leaseOwner: "worker-a" }), 1);
    await store.startToolCall(call(), "worker-a");
    const options = {
      sessionId: "ses_123",
      callId: "call_1",
      status: "completed" as const,
      eventType: "agent.action_completed" as const,
      eventData: {},
      leaseOwner: "worker-a"
    };
    await expect(store.settleToolCall(options)).resolves.toBe(true);
    await expect(store.settleToolCall(options)).resolves.toBe(false);
  });

  it("prevents a stale owner from settling a tool call", async () => {
    const store = new MemoryStore();
    await store.admitSession(session({ status: "running", leaseOwner: "worker-a" }), 1);
    await store.startToolCall(call(), "worker-a");
    await expect(
      store.settleToolCall({
        sessionId: "ses_123",
        callId: "call_1",
        status: "failed",
        eventType: "agent.action_failed",
        eventData: {},
        leaseOwner: "worker-b"
      })
    ).resolves.toBe(false);
  });

  it("interrupts only unfinished tool calls for the requested session", async () => {
    const store = new MemoryStore();
    store.calls.set("a", call({ id: "a", status: "running" }));
    store.calls.set("b", call({ id: "b", status: "completed" }));
    store.calls.set("c", call({ id: "c", sessionId: "other", status: "pending" }));
    await expect(store.interruptRunningToolCalls("ses_123")).resolves.toBe(1);
    expect(store.calls.get("a")?.status).toBe("interrupted");
    expect(store.calls.get("c")?.status).toBe("pending");
  });

  it("enforces fixed-window distributed limits", async () => {
    const store = new MemoryStore();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const options = { scope: "create", key: "ip", limit: 2, windowSeconds: 60, now };
    await expect(store.consumeRateLimit(options)).resolves.toMatchObject({
      allowed: true,
      remaining: 1
    });
    await expect(store.consumeRateLimit(options)).resolves.toMatchObject({
      allowed: true,
      remaining: 0
    });
    await expect(store.consumeRateLimit(options)).resolves.toMatchObject({
      allowed: false,
      retryAfterSeconds: 60
    });
  });

  it("resets a rate limit in the next window", async () => {
    const store = new MemoryStore();
    const base = { scope: "create", key: "ip", limit: 1, windowSeconds: 60 };
    await store.consumeRateLimit({ ...base, now: new Date("2026-01-01T00:00:00.000Z") });
    await expect(
      store.consumeRateLimit({ ...base, now: new Date("2026-01-01T00:01:00.000Z") })
    ).resolves.toMatchObject({ allowed: true, remaining: 0 });
  });

  it.each([
    { limit: 0, windowSeconds: 60 },
    { limit: 1, windowSeconds: 0 },
    { limit: 1.5, windowSeconds: 60 }
  ])("rejects invalid rate-limit configuration %#", async ({ limit, windowSeconds }) => {
    const store = new MemoryStore();
    await expect(
      store.consumeRateLimit({ scope: "create", key: "ip", limit, windowSeconds })
    ).rejects.toThrow("positive integer");
  });
});
