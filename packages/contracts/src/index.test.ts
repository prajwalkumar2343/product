import { describe, expect, it } from "vitest";
import {
  CreateSessionRequestSchema,
  DemoSessionSchema,
  FeatureRouteSchema,
  IntegrationSchema
} from "./index.js";

describe("shared production contracts", () => {
  it.each(["//evil.example/path", "/feature#fragment", "/feature path", "https://evil.test"])(
    "rejects unsafe feature path %s",
    (path) => {
      expect(() =>
        FeatureRouteSchema.parse({ id: "feature", name: "Feature", description: "Demo", path })
      ).toThrow();
    }
  );

  it("accepts a same-origin feature path with a query", () => {
    expect(
      FeatureRouteSchema.parse({
        id: "feature",
        name: "Feature",
        description: "Demo",
        path: "/feature?mode=demo"
      }).path
    ).toBe("/feature?mode=demo");
  });

  it.each([
    ["duplicate origins", { allowedOrigins: ["https://example.com", "https://example.com"] }],
    ["duplicate hosts", { allowedHosts: ["demo.example.com", "demo.example.com"] }],
    ["duplicate actions", { allowedActionIds: ["show_demo", "show_demo"] }],
    [
      "duplicate features",
      {
        features: [
          { id: "home", name: "Home", description: "Home", path: "/" },
          { id: "home", name: "Home 2", description: "Home 2", path: "/two" }
        ]
      }
    ]
  ])("rejects %s", (_name, patch) => {
    expect(() => IntegrationSchema.parse({ ...integration(), ...patch })).toThrow("unique");
  });

  it.each([
    "http://demo.example.com",
    "https://user:pass@demo.example.com",
    "https://demo.example.com/#fragment"
  ])("rejects unsafe start URL %s", (startUrl) => {
    expect(() => IntegrationSchema.parse({ ...integration(), startUrl })).toThrow();
  });

  it.each(["en", "en-US", "fr-CA", "zh-Hant"])("accepts locale %s", (locale) => {
    expect(CreateSessionRequestSchema.parse({ goal: "Show analytics", locale }).locale).toBe(
      locale
    );
  });

  it.each(["x", "not_a_locale", "en US"])("rejects invalid locale %s", (locale) => {
    expect(() => CreateSessionRequestSchema.parse({ goal: "Show analytics", locale })).toThrow();
  });

  it("loads an existing session without a request hash for migration compatibility", () => {
    expect(DemoSessionSchema.parse(session()).requestHash).toBeUndefined();
  });

  it("rejects malformed request hashes", () => {
    expect(() => DemoSessionSchema.parse({ ...session(), requestHash: "short" })).toThrow();
  });
});

function integration() {
  return {
    schemaVersion: 1,
    id: "acme",
    name: "Acme",
    enabled: true,
    allowedOrigins: ["https://example.com"],
    startUrl: "https://demo.example.com",
    allowedHosts: ["demo.example.com"],
    features: [{ id: "home", name: "Home", description: "Home", path: "/" }],
    fixtures: {},
    allowedActionIds: ["show_demo"],
    forbiddenActionPatterns: ["delete"],
    maxDurationSeconds: 600,
    maxSteps: 20,
    maxConcurrentSessions: 5,
    turnstileRequired: true,
    productGuide: "Guide",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function session() {
  return {
    schemaVersion: 1,
    id: "ses_12345678901234567890123456789012",
    integrationId: "acme",
    origin: "https://example.com",
    goal: "Show analytics",
    locale: "en",
    status: "accepted",
    tokenHash: "token",
    traceId: "trace",
    idempotencyKeyHash: "key",
    eventSequence: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:10:00.000Z"
  };
}
