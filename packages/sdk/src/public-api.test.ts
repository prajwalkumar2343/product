// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import ProductDemo from "./index.js";

const sessionId = "ses_12345678901234567890123456789012";

describe("ProductDemo public API", () => {
  afterEach(() => {
    document.body.replaceChildren();
    document.documentElement.style.overflow = "";
  });

  it("uses one constructor and one mount call", () => {
    const trigger = document.createElement("button");
    trigger.id = "demo";
    document.body.append(trigger);
    const demo = createDemo(vi.fn());
    expect(demo.mount("#demo")).toBe(demo);
    expect(document.querySelectorAll("ai-product-demo")).toHaveLength(1);
  });

  it("requires a configured hosted endpoint when baseURL is omitted", () => {
    expect(() => new ProductDemo({ integrationId: "acme" })).toThrow("no hosted API configured");
  });

  it("validates the integration during construction", () => {
    expect(
      () =>
        new ProductDemo({
          integrationId: "invalid integration",
          baseURL: "https://api.example.com"
        })
    ).toThrow("integrationId");
  });

  it("does not mutate the DOM when trigger validation fails", () => {
    const demo = createDemo(vi.fn());
    expect(() => demo.mount("#missing")).toThrow("trigger was not found");
    expect(document.querySelector("ai-product-demo")).toBeNull();
  });

  it("accepts buttons, links, and explicit button roles only", () => {
    const div = document.createElement("div");
    document.body.append(div);
    expect(() => createDemo(vi.fn()).mount(div)).toThrow("button or link");
    div.setAttribute("role", "button");
    expect(() => createDemo(vi.fn()).mount(div)).not.toThrow();
  });

  it("makes repeated mounting to the same trigger idempotent", () => {
    const first = document.createElement("button");
    const second = document.createElement("button");
    document.body.append(first, second);
    const demo = createDemo(vi.fn());
    expect(demo.mount(first).mount(first)).toBe(demo);
    expect(() => demo.mount(second)).toThrow("already mounted");
    expect(document.querySelectorAll("ai-product-demo")).toHaveLength(1);
  });

  it("prevents navigation when a link opens the demo", () => {
    const link = document.createElement("a");
    link.href = "/demo";
    document.body.append(link);
    const demo = createDemo(vi.fn()).mount(link);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    void demo.destroy();
  });

  it("returns the accepted session ID from start", async () => {
    const terminal = event(1, "session.completed");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(session(), { status: 202 }))
      .mockResolvedValueOnce(new Response(`data: ${JSON.stringify(terminal)}\n\n`));
    const demo = createDemo(fetchMock);
    await expect(demo.start("Show analytics")).resolves.toEqual({ sessionId });
  });

  it("normalizes lifecycle events for application code", async () => {
    const terminal = event(1, "session.completed");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(session(), { status: 202 }))
      .mockResolvedValueOnce(new Response(`data: ${JSON.stringify(terminal)}\n\n`));
    const demo = createDemo(fetchMock);
    const started = vi.fn();
    const events = vi.fn();
    const unsubscribe = demo.on("started", started);
    demo.on("event", events);
    await demo.start("Show analytics");
    await vi.waitFor(() => expect(events).toHaveBeenCalledWith(terminal));
    expect(started).toHaveBeenCalledWith({ sessionId });
    unsubscribe();
  });

  it("sends messages only while a demo is active", async () => {
    const pending = new ReadableStream<Uint8Array>({ start() {} });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(session(), { status: 202 }))
      .mockResolvedValueOnce(new Response(pending))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    const demo = createDemo(fetchMock);
    await expect(demo.send("hello")).rejects.toThrow("Start a demo");
    await demo.start("Show analytics");
    await demo.send("Show billing next");
    const messageRequest = fetchMock.mock.calls[2]?.[1] as RequestInit;
    expect(messageRequest.method).toBe("POST");
    expect(messageRequest.body).toBe(JSON.stringify({ message: "Show billing next" }));
    await demo.close();
  });

  it("rejects invalid start input instead of hiding the error", async () => {
    await expect(createDemo(vi.fn()).start("x")).rejects.toMatchObject({
      code: "configuration_error"
    });
  });

  it("destroys idempotently and can be mounted again", async () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    const demo = createDemo(vi.fn()).mount(trigger);
    await demo.destroy();
    await demo.destroy();
    expect(document.querySelector("ai-product-demo")).toBeNull();
    expect(demo.mount(trigger)).toBe(demo);
  });

  it("exposes stable error classes without additional imports", () => {
    const error = new ProductDemo.Error("Invalid", { code: "configuration_error" });
    expect(error).toBeInstanceOf(Error);
    expect(ProductDemo.APIError.prototype).toBeInstanceOf(ProductDemo.Error);
  });
});

function createDemo(fetch: typeof globalThis.fetch): ProductDemo {
  return new ProductDemo({
    integrationId: "acme",
    baseURL: "https://api.example.com",
    fetch
  });
}

function session() {
  return {
    sessionId,
    accessToken: "token",
    expiresAt: "2099-01-01T00:10:00.000Z",
    eventsUrl: "https://api.example.com/v1/sessions/id/stream",
    viewUrl: "https://api.example.com/v1/sessions/id/view"
  };
}

function event(sequence: number, type: string) {
  return {
    schemaVersion: 1,
    id: String(sequence),
    sessionId,
    sequence,
    type,
    data: {},
    createdAt: "2099-01-01T00:00:00.000Z"
  };
}
