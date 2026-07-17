import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductDemoClient } from "./client.js";
import { ProductDemoApiError, ProductDemoError } from "./errors.js";

const session = {
  sessionId: "ses_12345678901234567890123456789012",
  accessToken: "secret-token",
  expiresAt: "2099-01-01T00:10:00.000Z",
  eventsUrl: "https://api.example.com/v1/sessions/id/stream",
  viewUrl: "https://api.example.com/v1/sessions/id/view"
};

function client(fetch: typeof globalThis.fetch, overrides = {}) {
  return new ProductDemoClient({
    apiUrl: "https://api.example.com",
    integrationId: "acme",
    fetch,
    ...overrides
  });
}

describe("ProductDemoClient", () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    "not-a-url",
    "http://api.example.com",
    "https://user:pass@api.example.com",
    "https://api.example.com/base",
    "https://api.example.com?secret=value",
    "ftp://api.example.com"
  ])("rejects unsafe API URL %s", (apiUrl) => {
    expect(() => new ProductDemoClient({ apiUrl, integrationId: "acme", fetch: vi.fn() })).toThrow(
      ProductDemoError
    );
  });

  it.each(["", "/acme", "acme!", "a".repeat(81)])(
    "rejects invalid integration ID %j",
    (integrationId) => {
      expect(
        () =>
          new ProductDemoClient({
            apiUrl: "https://api.example.com",
            integrationId,
            fetch: vi.fn()
          })
      ).toThrow("integrationId");
    }
  );

  it("accepts HTTP only for local development", () => {
    expect(
      () =>
        new ProductDemoClient({
          apiUrl: "http://localhost:8080",
          integrationId: "acme",
          fetch: vi.fn()
        })
    ).not.toThrow();
  });

  it.each([{ timeoutMilliseconds: 0 }, { maxRetries: -1 }, { maxRetries: 1.5 }, { maxRetries: 6 }])(
    "rejects invalid transport options %#",
    (options) => {
      expect(
        () =>
          new ProductDemoClient({
            apiUrl: "https://api.example.com",
            integrationId: "acme",
            fetch: vi.fn(),
            ...options
          })
      ).toThrow(ProductDemoError);
    }
  );

  it("creates a session with a stable idempotency key and no browser credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(session, { status: 202 }));
    await client(fetchMock).create({
      goal: "Show analytics",
      locale: "en-IN",
      turnstileToken: "challenge",
      idempotencyKey: "fixed-key"
    });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.href).toBe("https://api.example.com/v1/integrations/acme/sessions");
    expect(init.credentials).toBe("omit");
    expect(init.redirect).toBe("error");
    expect(init.headers).toMatchObject({
      "Idempotency-Key": "fixed-key",
      "Content-Type": "application/json"
    });
    expect(typeof init.body).toBe("string");
    const body = JSON.parse(init.body as string) as unknown;
    expect(body).toEqual({
      goal: "Show analytics",
      locale: "en-IN",
      turnstileToken: "challenge"
    });
  });

  it("rejects session endpoints on a different origin", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ ...session, eventsUrl: "https://evil.example/events" }));
    await expect(client(fetchMock).create({ goal: "Show analytics" })).rejects.toMatchObject({
      code: "invalid_response"
    });
  });

  it("rejects session endpoints outside the versioned API path", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ ...session, viewUrl: "https://api.example.com/admin" }));
    await expect(client(fetchMock).create({ goal: "Show analytics" })).rejects.toMatchObject({
      code: "invalid_response"
    });
  });

  it("returns typed API errors with operational metadata", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { error: "integration_at_capacity" },
          { status: 429, headers: { "Retry-After": "10", "X-Request-Id": "req_1" } }
        )
      );
    const error = await client(fetchMock, { maxRetries: 0 })
      .create({ goal: "Show analytics" })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ProductDemoApiError);
    expect(error).toMatchObject({
      status: 429,
      retryAfterSeconds: 10,
      requestId: "req_1",
      message: "integration at capacity"
    });
  });

  it("retries idempotent creation after a server failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ error: "temporary" }, { status: 503, headers: { "Retry-After": "0" } })
      )
      .mockResolvedValueOnce(Response.json(session, { status: 202 }));
    await expect(client(fetchMock).create({ goal: "Show analytics" })).resolves.toEqual(session);
    const keys = fetchMock.mock.calls.map(
      (call) => (call[1] as RequestInit).headers as Record<string, string>
    );
    expect(keys[0]?.["Idempotency-Key"]).toBe(keys[1]?.["Idempotency-Key"]);
  });

  it("does not retry a validation error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ error: "invalid_request" }, { status: 400 }));
    await expect(client(fetchMock).create({ goal: "x" })).rejects.toBeInstanceOf(
      ProductDemoApiError
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("bounds JSON responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(`"${"x".repeat(70_000)}"`));
    await expect(client(fetchMock).create({ goal: "Show analytics" })).rejects.toMatchObject({
      code: "invalid_response"
    });
  });

  it("rejects malformed JSON responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{"));
    await expect(client(fetchMock).create({ goal: "Show analytics" })).rejects.toMatchObject({
      code: "invalid_response"
    });
  });

  it("authenticates viewer, message, stream, and cancellation requests", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          viewerUrl: "https://app.steel.dev/sessions/1",
          expiresAt: session.expiresAt
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(new Response("data: ok\n\n"))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    const sdk = client(fetchMock);
    await sdk.getViewer(session);
    await sdk.sendMessage(session, "Show billing");
    await sdk.eventStream(session, 12, new AbortController().signal);
    await sdk.cancel(session, true);
    const calls = fetchMock.mock.calls.map((call) => call[1] as RequestInit);
    expect(calls.every((init) => JSON.stringify(init.headers).includes("secret-token"))).toBe(true);
    expect(calls[2]?.headers).toMatchObject({ "Last-Event-ID": "12" });
    expect(calls[3]?.keepalive).toBe(true);
  });

  it("turns transport failures into connection errors", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("offline"));
    await expect(
      client(fetchMock, { maxRetries: 0 }).create({ goal: "Show analytics" })
    ).rejects.toMatchObject({ code: "connection_error" });
  });

  it("honors caller cancellation", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted")), {
          once: true
        });
      });
    });
    const promise = client(fetchMock).create({ goal: "Show analytics", signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: "aborted" });
  });

  it("times out a stalled request", async () => {
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted")), {
          once: true
        });
      });
    });
    await expect(
      client(fetchMock, { timeoutMilliseconds: 1, maxRetries: 0 }).create({
        goal: "Show analytics"
      })
    ).rejects.toMatchObject({ code: "timeout" });
  });
});
