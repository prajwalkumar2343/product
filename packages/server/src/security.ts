import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("Invalid origin");
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))
  ) {
    throw new Error("Insecure origin");
  }
  return url.origin;
}

export function originAllowed(origin: string, allowlist: readonly string[]): boolean {
  try {
    const normalized = normalizeOrigin(origin);
    return allowlist.some((allowed) => normalizeOrigin(allowed) === normalized);
  } catch {
    return false;
  }
}

export function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class SessionTokens {
  public constructor(private readonly secret: string) {}

  public issue(sessionId: string, stableNonce: string = crypto.randomUUID()): string {
    const nonce = hashValue(stableNonce);
    const body = Buffer.from(`${sessionId}.${nonce}`).toString("base64url");
    return `${body}.${this.sign(body)}`;
  }

  public verify(token: string, sessionId: string, expectedHash: string): boolean {
    const [body, signature, extra] = token.split(".");
    if (!body || !signature || extra || !safeEqual(signature, this.sign(body))) return false;
    let decoded: string;
    try {
      decoded = Buffer.from(body, "base64url").toString("utf8");
    } catch {
      return false;
    }
    return decoded.startsWith(`${sessionId}.`) && safeEqual(hashValue(token), expectedHash);
  }

  private sign(body: string): string {
    return createHmac("sha256", this.secret).update(body).digest("base64url");
  }
}

export function deterministicSessionId(
  secret: string,
  integrationId: string,
  idempotencyKey: string
): string {
  return `ses_${createHmac("sha256", secret).update(`${integrationId}\0${idempotencyKey}`).digest("base64url").slice(0, 32)}`;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function assertAllowedUrl(rawUrl: string, allowedHosts: readonly string[]): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) {
    throw new Error("Blocked URL scheme");
  }
  const host = url.hostname.toLowerCase();
  if (!allowedHosts.some((allowed) => host === allowed.toLowerCase()))
    throw new Error("Blocked host");
  if (url.username || url.password) throw new Error("Credentials in URL are forbidden");
  return url;
}

export function assertAllowedWebSocketUrl(rawUrl: string, allowedHosts: readonly string[]): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== "wss:") throw new Error("Blocked WebSocket scheme");
  const host = url.hostname.toLowerCase();
  if (!allowedHosts.some((allowed) => host === allowed.toLowerCase()))
    throw new Error("Blocked WebSocket host");
  if (url.username || url.password) throw new Error("Credentials in URL are forbidden");
  return url;
}
