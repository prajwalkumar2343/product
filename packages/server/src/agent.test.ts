import type { DemoSession, Integration } from "@product/contracts";
import { describe, expect, it } from "vitest";
import { DemoAgent } from "./agent.js";
import type { DemoBrowser } from "./browser.js";
import type { ModelDecision, ModelProvider } from "./model.js";
import { MemoryStore } from "./test-memory-store.js";

describe("agent harness", () => {
  it("persists a tool call before execution and completes through a fake provider", async () => {
    const store = new MemoryStore();
    const integration = makeIntegration();
    const session = makeSession();
    await store.putIntegration(integration);
    await store.admitSession(session, 2);
    const decisions: ModelDecision[] = [
      {
        toolCall: { id: "call-1", name: "inspect_page", arguments: {} }
      },
      {
        toolCall: {
          id: "call-2",
          name: "focus_element",
          arguments: { ref: "e0" }
        }
      },
      {
        toolCall: {
          id: "call-3",
          name: "finish_demo",
          arguments: { summary: "Analytics filters are now demonstrated." }
        }
      }
    ];
    const model: ModelProvider = {
      async decide() {
        const decision = decisions.shift();
        if (!decision) throw new Error("Unexpected model turn");
        return decision;
      }
    };
    const browser = {
      async inspect() {
        expect([...store.calls.values()].some((call) => call.status === "running")).toBe(true);
        return {
          url: "https://demo.example.com",
          title: "Demo",
          text: "Analytics",
          elements: [
            {
              ref: "e0",
              tag: "button",
              role: null,
              name: "Filter",
              type: "button",
              actionId: "apply_filter",
              inputKey: null
            }
          ]
        };
      },
      async focus(ref: string) {
        expect(ref).toBe("e0");
        return { x: 0.4, y: 0.3, scale: 1.35 };
      }
    } as unknown as DemoBrowser;

    await new DemoAgent(store, model).run(
      session,
      integration,
      browser,
      new AbortController().signal
    );

    expect([...store.calls.values()].map((call) => call.status)).toEqual([
      "completed",
      "completed",
      "completed"
    ]);
    expect(
      (store.events.get(session.id) ?? []).some((event) => event.type === "agent.narration")
    ).toBe(true);
    expect(
      (store.events.get(session.id) ?? []).find((event) => event.type === "agent.focus")?.data
    ).toEqual({ x: 0.4, y: 0.3, scale: 1.35 });
  });

  it("does not execute a tool when cancellation wins the race after the model turn", async () => {
    const store = new MemoryStore();
    const integration = makeIntegration();
    const session = makeSession();
    await store.putIntegration(integration);
    await store.admitSession(session, 2);
    let browserExecuted = false;
    const model: ModelProvider = {
      async decide() {
        await store.transitionWithEvent({
          sessionId: session.id,
          from: ["running"],
          to: "cancelled",
          eventType: "session.cancelled"
        });
        return { toolCall: { id: "call-1", name: "inspect_page", arguments: {} } };
      }
    };
    const browser = {
      async inspect() {
        browserExecuted = true;
        return { url: "", title: "", text: "", elements: [] };
      }
    } as unknown as DemoBrowser;
    await expect(
      new DemoAgent(store, model).run(session, integration, browser, new AbortController().signal)
    ).rejects.toThrow("no longer authorized");
    expect(browserExecuted).toBe(false);
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
    features: [
      { id: "analytics", name: "Analytics", description: "Analytics", path: "/analytics" }
    ],
    fixtures: {},
    allowedActionIds: [],
    forbiddenActionPatterns: ["delete"],
    maxDurationSeconds: 600,
    maxSteps: 5,
    maxConcurrentSessions: 2,
    turnstileRequired: true,
    productGuide: "Show analytics.",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function makeSession(): DemoSession {
  return {
    schemaVersion: 1,
    id: "ses_12345678901234567890123456789012",
    integrationId: "acme",
    origin: "https://www.example.com",
    goal: "Show analytics",
    locale: "en",
    status: "running",
    leaseOwner: "worker-1",
    tokenHash: "hash",
    traceId: "trace",
    idempotencyKeyHash: "idempotency",
    eventSequence: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z"
  };
}
