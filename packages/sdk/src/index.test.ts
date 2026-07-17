// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductDemoClient } from "./client.js";
import { ProductDemoElement } from "./element.js";
import ProductDemo from "./index.js";

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
      createdAt: "2099-01-01T00:00:00.000Z"
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            sessionId: terminalEvent.sessionId,
            accessToken: "token",
            expiresAt: "2099-01-01T00:10:00.000Z",
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
    const element = new ProductDemoElement();
    element.setAttribute("integration-id", "acme");
    element.setAttribute("api-url", "https://api.example.com");
    document.body.append(element);
    const events: unknown[] = [];
    element.addEventListener("product-demo:event", (event) =>
      events.push((event as CustomEvent).detail)
    );
    await element.start("Show analytics");
    await vi.waitFor(() => expect(events).toEqual([terminalEvent]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect("session" in element).toBe(false);
    expect("root" in element).toBe(false);
  });

  it("mounts onto an existing product button with one call", async () => {
    const button = document.createElement("button");
    button.id = "demo";
    document.body.append(button);
    const demo = new ProductDemo({
      integrationId: "acme",
      baseURL: "https://api.example.com",
      fetch: vi.fn()
    });
    expect(demo.mount("#demo")).toBe(demo);
    expect(demo).toBeInstanceOf(ProductDemo);
    const opened = vi.fn();
    demo.on("open", opened);
    button.click();
    expect(opened).toHaveBeenCalledOnce();
    await demo.destroy();
    button.click();
    expect(opened).toHaveBeenCalledOnce();
  });

  it("fails clearly when the configured trigger does not exist", () => {
    expect(() =>
      new ProductDemo({
        integrationId: "acme",
        baseURL: "https://api.example.com",
        fetch: vi.fn()
      }).mount("#missing")
    ).toThrow(ProductDemo.Error);
  });

  it("deduplicates concurrent start calls", async () => {
    const terminalEvent = {
      schemaVersion: 1,
      id: "2",
      sessionId: "ses_12345678901234567890123456789012",
      sequence: 2,
      type: "session.completed",
      data: {},
      createdAt: "2099-01-01T00:00:00.000Z"
    };
    let resolveCreate!: (response: Response) => void;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (resolveCreate = resolve)))
      .mockResolvedValueOnce(new Response(`data: ${JSON.stringify(terminalEvent)}\n\n`));
    const element = configuredElement(fetchMock);
    const first = element.start("Show analytics");
    const second = element.start("Show another workflow");
    expect(second).toBe(first);
    await vi.waitFor(() => expect(resolveCreate).toBeTypeOf("function"));
    resolveCreate(Response.json(responseFor(terminalEvent.sessionId), { status: 202 }));
    await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const requestBody = (fetchMock.mock.calls[0]?.[1] as RequestInit).body;
    expect(typeof requestBody).toBe("string");
    expect(JSON.parse(requestBody as string) as unknown).toMatchObject({ goal: "Show analytics" });
  });

  it("ignores duplicate and out-of-order stream events", async () => {
    const sessionId = "ses_12345678901234567890123456789012";
    const event = (sequence: number, type = "agent.narration") => ({
      schemaVersion: 1,
      id: String(sequence),
      sessionId,
      sequence,
      type,
      data: { message: String(sequence) },
      createdAt: "2099-01-01T00:00:00.000Z"
    });
    const stream = [event(1), event(1), event(0), event(2, "session.completed")]
      .map((value) => `data: ${JSON.stringify(value)}\n\n`)
      .join("");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(responseFor(sessionId), { status: 202 }))
      .mockResolvedValueOnce(new Response(stream));
    const element = configuredElement(fetchMock);
    const received: number[] = [];
    element.addEventListener("product-demo:event", (value) =>
      received.push((value as CustomEvent<{ sequence: number }>).detail.sequence)
    );
    await element.start("Show analytics");
    await vi.waitFor(() => expect(received).toEqual([1, 2]));
  });

  it("rejects an event that belongs to another session", async () => {
    const sessionId = "ses_12345678901234567890123456789012";
    const foreign = {
      schemaVersion: 1,
      id: "1",
      sessionId: "ses_abcdefghijklmnopqrstuvwxyz123456",
      sequence: 1,
      type: "session.completed",
      data: {},
      createdAt: "2099-01-01T00:00:00.000Z"
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(responseFor(sessionId), { status: 202 }))
      .mockResolvedValueOnce(new Response(`data: ${JSON.stringify(foreign)}\n\n`));
    const element = configuredElement(fetchMock);
    const errors: unknown[] = [];
    element.addEventListener("product-demo:error", (value) =>
      errors.push((value as CustomEvent).detail)
    );
    await element.start("Show analytics");
    await vi.waitFor(() =>
      expect(errors).toEqual([
        expect.objectContaining({
          code: "invalid_response",
          message: "Event belongs to another session"
        })
      ])
    );
  });

  it("cancels the server session when the host closes the modal", async () => {
    const sessionId = "ses_12345678901234567890123456789012";
    const pendingStream = new ReadableStream<Uint8Array>({ start() {} });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(responseFor(sessionId), { status: 202 }))
      .mockResolvedValueOnce(new Response(pendingStream))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    const element = configuredElement(fetchMock);
    const start = element.start("Show analytics");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await element.close();
    await start;
    const cancel = fetchMock.mock.calls.find(
      (call) => (call[1] as RequestInit).method === "DELETE"
    );
    expect(cancel?.[1]).toMatchObject({ method: "DELETE", keepalive: true });
  });

  it("restores page scroll state and focus after close", async () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    document.documentElement.style.overflow = "clip";
    const element = configuredElement(vi.fn());
    element.open();
    expect(document.documentElement.style.overflow).toBe("hidden");
    await element.close();
    expect(document.documentElement.style.overflow).toBe("clip");
    expect(document.activeElement).toBe(trigger);
  });
});

function responseFor(sessionId: string) {
  return {
    sessionId,
    accessToken: "token",
    expiresAt: "2099-01-01T00:10:00.000Z",
    eventsUrl: "https://api.example.com/v1/sessions/id/stream",
    viewUrl: "https://api.example.com/v1/sessions/id/view"
  };
}

function configuredElement(fetch: typeof globalThis.fetch) {
  const element = new ProductDemoElement();
  element.configure({
    integrationId: "acme",
    client: new ProductDemoClient({
      integrationId: "acme",
      apiUrl: "https://api.example.com",
      fetch
    })
  });
  document.body.append(element);
  return element;
}
