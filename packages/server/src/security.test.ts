import { describe, expect, it } from "vitest";
import {
  SessionTokens,
  assertAllowedUrl,
  assertAllowedWebSocketUrl,
  deterministicSessionId,
  hashValue,
  originAllowed
} from "./security.js";

describe("origin policy", () => {
  it("accepts only exact configured origins", () => {
    expect(originAllowed("https://app.example.com", ["https://app.example.com"])).toBe(true);
    expect(originAllowed("https://evil.example.com", ["https://app.example.com"])).toBe(false);
    expect(originAllowed("https://app.example.com.evil.test", ["https://app.example.com"])).toBe(
      false
    );
    expect(originAllowed("https://app.example.com/path", ["https://app.example.com"])).toBe(false);
  });
});

describe("navigation policy", () => {
  it("blocks subdomain tricks, credentials, and unsafe schemes", () => {
    expect(assertAllowedUrl("https://demo.example.com/a", ["demo.example.com"]).hostname).toBe(
      "demo.example.com"
    );
    expect(() =>
      assertAllowedUrl("https://demo.example.com.evil.test", ["demo.example.com"])
    ).toThrow("Blocked host");
    expect(() => assertAllowedUrl("javascript:alert(1)", ["demo.example.com"])).toThrow(
      "Blocked URL scheme"
    );
    expect(() =>
      assertAllowedUrl("https://user:pass@demo.example.com", ["demo.example.com"])
    ).toThrow("Credentials");
    expect(
      assertAllowedWebSocketUrl("wss://demo.example.com/live", ["demo.example.com"]).hostname
    ).toBe("demo.example.com");
    expect(() =>
      assertAllowedWebSocketUrl("wss://evil.example.com/live", ["demo.example.com"])
    ).toThrow("Blocked WebSocket host");
  });
});

describe("session capabilities", () => {
  it("are deterministic for retries and bound to the session", () => {
    const secret = "s".repeat(32);
    const id = deterministicSessionId(secret, "acme", "1234567890abcdef");
    const token = new SessionTokens(secret).issue(id, "1234567890abcdef");
    expect(new SessionTokens(secret).verify(token, id, hashValue(token))).toBe(true);
    expect(new SessionTokens(secret).verify(token, `${id}x`, hashValue(token))).toBe(false);
    expect(new SessionTokens("x".repeat(32)).verify(token, id, hashValue(token))).toBe(false);
  });
});
