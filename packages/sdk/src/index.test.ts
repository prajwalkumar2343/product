// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import "./index.js";

describe("embed session lifecycle", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("validates session events and stops reconnecting after a terminal event", async () => {
    const terminalEvent = {
      schemaVersion: 1,
      id: "0000000002",
      sessionId: "ses_12345678901234567890123456789012",
      sequence: 2,
      type: "session.completed",
      data: {},
      createdAt: "2026-01-01T00:00:00.000Z"
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            sessionId: terminalEvent.sessionId,
            accessToken: "token",
            expiresAt: "2026-01-01T00:10:00.000Z",
            eventsUrl: "https://api.example.com/v1/sessions/id/stream",
            viewUrl: "https://api.example.com/v1/sessions/id/view"
          },
          { status: 202 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          `id: 2\nevent: session.completed\ndata: ${JSON.stringify(terminalEvent)}\n\n`,
          { headers: { "Content-Type": "text/event-stream" } }
        )
      );
    vi.stubGlobal("fetch", fetchMock);
    const element = document.createElement("ai-product-demo") as HTMLElement & {
      start(goal: string): Promise<void>;
    };
    element.setAttribute("integration-id", "acme");
    element.setAttribute("api-url", "https://api.example.com");
    document.body.append(element);
    const events: unknown[] = [];
    element.addEventListener("product-demo:event", (event) =>
      events.push((event as CustomEvent).detail)
    );
    await element.start("Show analytics");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events).toEqual([terminalEvent]);
    expect("session" in element).toBe(false);
    expect("root" in element).toBe(false);
  });
});
