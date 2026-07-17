import { parseCreateSessionResponse, parseViewResponse, type CreateResponse } from "./protocol.js";
import { ProductDemoApiError, ProductDemoError } from "./errors.js";

export interface ProductDemoClientOptions {
  apiUrl: string;
  integrationId: string;
  fetch?: typeof globalThis.fetch;
  timeoutMilliseconds?: number;
  maxRetries?: number;
}

export interface CreateDemoOptions {
  goal: string;
  locale?: string;
  turnstileToken?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export class ProductDemoClient {
  readonly #apiUrl: string;
  readonly #integrationId: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMilliseconds: number;
  readonly #maxRetries: number;

  public constructor(options: ProductDemoClientOptions) {
    this.#apiUrl = normalizeApiUrl(options.apiUrl);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(options.integrationId))
      throw new ProductDemoError("Invalid integrationId", { code: "configuration_error" });
    if (options.timeoutMilliseconds !== undefined && options.timeoutMilliseconds < 1)
      throw new ProductDemoError("timeoutMilliseconds must be positive", {
        code: "configuration_error"
      });
    if (
      options.maxRetries !== undefined &&
      (!Number.isSafeInteger(options.maxRetries) ||
        options.maxRetries < 0 ||
        options.maxRetries > 5)
    )
      throw new ProductDemoError("maxRetries must be an integer between 0 and 5", {
        code: "configuration_error"
      });
    this.#integrationId = options.integrationId;
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (!this.#fetch)
      throw new ProductDemoError("A Fetch API implementation is required", {
        code: "configuration_error"
      });
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? 15_000;
    this.#maxRetries = options.maxRetries ?? 2;
  }

  public async create(options: CreateDemoOptions): Promise<CreateResponse> {
    const idempotencyKey = options.idempotencyKey ?? crypto.randomUUID();
    const response = await this.request(
      `/v1/integrations/${encodeURIComponent(this.#integrationId)}/sessions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey
        },
        body: JSON.stringify({
          goal: options.goal,
          ...(options.locale ? { locale: options.locale } : {}),
          ...(options.turnstileToken ? { turnstileToken: options.turnstileToken } : {})
        }),
        ...(options.signal ? { signal: options.signal } : {})
      },
      true
    );
    const session = parseCreateSessionResponse(await readJson(response));
    assertApiEndpoint(session.eventsUrl, this.#apiUrl, "eventsUrl");
    assertApiEndpoint(session.viewUrl, this.#apiUrl, "viewUrl");
    return session;
  }

  public eventStream(session: CreateResponse, lastEventId: number, signal: AbortSignal) {
    return this.request(session.eventsUrl, {
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${session.accessToken}`,
        "Last-Event-ID": String(lastEventId)
      },
      signal
    });
  }

  public async getViewer(session: CreateResponse, signal?: AbortSignal): Promise<string> {
    const response = await this.request(session.viewUrl, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
      ...(signal ? { signal } : {})
    });
    return parseViewResponse(await readJson(response)).viewerUrl;
  }

  public async sendMessage(
    session: CreateResponse,
    message: string,
    signal?: AbortSignal
  ): Promise<void> {
    await this.request(`/v1/sessions/${session.sessionId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ message }),
      ...(signal ? { signal } : {})
    });
  }

  public async cancel(session: CreateResponse, keepalive = false): Promise<void> {
    await this.request(`/v1/sessions/${session.sessionId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${session.accessToken}` },
      keepalive
    });
  }

  async request(pathOrUrl: string, init: RequestInit, retryable = false): Promise<Response> {
    const url = new URL(pathOrUrl, `${this.#apiUrl}/`);
    assertApiEndpoint(url.href, this.#apiUrl, "request URL");
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      const timeout = new AbortController();
      const timer = setTimeout(
        () => timeout.abort(new ProductDemoError("Request timed out", { code: "timeout" })),
        this.#timeoutMilliseconds
      );
      const combined = combineSignals(init.signal, timeout.signal);
      try {
        const response = await this.#fetch(url, {
          ...init,
          headers: { Accept: "application/json", ...init.headers },
          signal: combined.signal,
          credentials: "omit",
          mode: "cors",
          redirect: "error"
        });
        if (response.ok) return response;
        const error = await apiError(response);
        if (!retryable || !isRetryableStatus(response.status) || attempt === this.#maxRetries)
          throw error;
        lastError = error;
        await wait(retryDelay(attempt, error.retryAfterSeconds), init.signal);
      } catch (error) {
        if (init.signal?.aborted)
          throw new ProductDemoError("Request aborted", { code: "aborted", cause: error });
        if (timeout.signal.aborted && timeout.signal.reason instanceof ProductDemoError)
          throw timeout.signal.reason;
        if (error instanceof ProductDemoApiError || error instanceof ProductDemoError) {
          if (!retryable || error.code !== "connection_error" || attempt === this.#maxRetries)
            throw error;
        } else {
          lastError = new ProductDemoError("Could not connect to the demo service", {
            code: "connection_error",
            cause: error
          });
          if (!retryable || attempt === this.#maxRetries) throw lastError;
        }
        await wait(retryDelay(attempt), init.signal);
      } finally {
        combined.cleanup();
        clearTimeout(timer);
      }
    }
    throw lastError;
  }
}

const MAX_RESPONSE_BYTES = 65_536;

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES)
    throw new ProductDemoError("API response is too large", { code: "invalid_response" });
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new ProductDemoError("API returned invalid JSON", {
      code: "invalid_response",
      cause
    });
  }
}

async function apiError(response: Response): Promise<ProductDemoApiError> {
  let errorCode = "request_failed";
  try {
    const body = await readJson(response);
    if (body && typeof body === "object" && "error" in body && typeof body.error === "string")
      errorCode = body.error;
  } catch {
    // Status and request ID still provide a useful, bounded error.
  }
  const retryAfter = Number(response.headers.get("retry-after"));
  const requestId = response.headers.get("x-request-id");
  return new ProductDemoApiError(errorCode.replaceAll("_", " "), {
    status: response.status,
    ...(requestId ? { requestId } : {}),
    ...(Number.isFinite(retryAfter) && retryAfter >= 0 ? { retryAfterSeconds: retryAfter } : {})
  });
}

function normalizeApiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new ProductDemoError("apiUrl must be an absolute URL", {
      code: "configuration_error",
      cause
    });
  }
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new ProductDemoError("apiUrl must be a secure origin without credentials or a query", {
      code: "configuration_error"
    });
  return url.href.replace(/\/$/, "");
}

function assertApiEndpoint(value: string, apiUrl: string, field: string): void {
  const endpoint = new URL(value, `${apiUrl}/`);
  const base = new URL(apiUrl);
  if (endpoint.origin !== base.origin || !endpoint.pathname.startsWith("/v1/"))
    throw new ProductDemoError(`${field} is outside the configured API origin`, {
      code: "invalid_response"
    });
}

function combineSignals(
  left: AbortSignal | null | undefined,
  right: AbortSignal
): { signal: AbortSignal; cleanup: () => void } {
  if (!left) return { signal: right, cleanup: () => undefined };
  const controller = new AbortController();
  const forward = (signal: AbortSignal) => controller.abort(signal.reason);
  const forwardLeft = () => forward(left);
  const forwardRight = () => forward(right);
  if (left.aborted) forwardLeft();
  else left.addEventListener("abort", forwardLeft, { once: true });
  if (right.aborted) forwardRight();
  else right.addEventListener("abort", forwardRight, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      left.removeEventListener("abort", forwardLeft);
      right.removeEventListener("abort", forwardRight);
    }
  };
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function retryDelay(attempt: number, retryAfterSeconds?: number): number {
  if (retryAfterSeconds !== undefined) return Math.min(10_000, retryAfterSeconds * 1_000);
  return Math.min(4_000, 250 * 2 ** attempt) + Math.floor(Math.random() * 100);
}

function wait(milliseconds: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error("Request aborted"));
      },
      { once: true }
    );
  });
}
