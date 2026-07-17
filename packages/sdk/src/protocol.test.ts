import { describe, expect, it } from "vitest";
import {
  parseCreateSessionResponse,
  parseFocusEventData,
  parseSessionEvent,
  parseViewResponse
} from "./protocol.js";

describe("embed protocol validation", () => {
  it("rejects credential-bearing API URLs and unknown event versions", () => {
    expect(() =>
      parseCreateSessionResponse({
        sessionId: "id",
        accessToken: "token",
        expiresAt: "2026-01-01T00:00:00.000Z",
        eventsUrl: "https://user:pass@api.example.com/events",
        viewUrl: "https://api.example.com/view"
      })
    ).toThrow("eventsUrl");
    expect(() =>
      parseSessionEvent({
        schemaVersion: 2,
        id: "1",
        sessionId: "id",
        sequence: 1,
        type: "session.completed",
        data: {},
        createdAt: "2026-01-01T00:00:00.000Z"
      })
    ).toThrow("schema version");
  });

  it("accepts only a trusted Steel viewer URL", () => {
    expect(() =>
      parseViewResponse({
        viewerUrl: "https://evil.example.com/view",
        expiresAt: "2026-01-01T00:00:00.000Z"
      })
    ).toThrow("Untrusted");
    expect(
      parseViewResponse({
        viewerUrl: "https://app.steel.dev/sessions/1",
        expiresAt: "2026-01-01T00:00:00.000Z"
      }).viewerUrl
    ).toBe("https://app.steel.dev/sessions/1");
  });

  it.each([
    ["missing session ID", { sessionId: undefined }],
    ["empty access token", { accessToken: "" }],
    ["invalid expiry", { expiresAt: "tomorrow" }],
    ["non-HTTP event URL", { eventsUrl: "javascript:alert(1)" }],
    ["credential-bearing view URL", { viewUrl: "https://user:pass@api.example.com/view" }]
  ])("rejects a create response with %s", (_label, override) => {
    expect(() =>
      parseCreateSessionResponse({
        sessionId: "id",
        accessToken: "token",
        expiresAt: "2099-01-01T00:00:00.000Z",
        eventsUrl: "https://api.example.com/events",
        viewUrl: "https://api.example.com/view",
        ...override
      })
    ).toThrow();
  });

  it.each([
    ["array root", []],
    ["missing data", { data: undefined }],
    ["fractional sequence", { sequence: 1.5 }],
    ["negative sequence", { sequence: -1 }],
    ["invalid timestamp", { createdAt: "2099" }],
    ["oversized type", { type: "x".repeat(101) }]
  ])("rejects an event with %s", (_label, value) => {
    const base = {
      schemaVersion: 1,
      id: "1",
      sessionId: "id",
      sequence: 1,
      type: "session.completed",
      data: {},
      createdAt: "2099-01-01T00:00:00.000Z"
    };
    expect(() => parseSessionEvent(Array.isArray(value) ? value : { ...base, ...value })).toThrow();
  });

  it("accepts localhost API endpoints for local SDK development", () => {
    expect(
      parseCreateSessionResponse({
        sessionId: "id",
        accessToken: "token",
        expiresAt: "2099-01-01T00:00:00.000Z",
        eventsUrl: "http://localhost:8080/v1/events",
        viewUrl: "http://127.0.0.1:8080/v1/view"
      })
    ).toMatchObject({ sessionId: "id" });
  });

  it("rejects lookalike Steel domains", () => {
    expect(() =>
      parseViewResponse({
        viewerUrl: "https://steel.dev.evil.example/sessions/1",
        expiresAt: "2099-01-01T00:00:00.000Z"
      })
    ).toThrow("Untrusted");
  });

  it("accepts only bounded model-directed focus geometry", () => {
    expect(parseFocusEventData({ x: 0.25, y: 0.8, scale: 1.35 })).toEqual({
      x: 0.25,
      y: 0.8,
      scale: 1.35
    });
    expect(() => parseFocusEventData({ x: -0.1, y: 0.5, scale: 1.2 })).toThrow("focus.x");
    expect(() => parseFocusEventData({ x: 0.5, y: 0.5, scale: 2 })).toThrow("focus.scale");
    expect(() => parseFocusEventData({ x: "0.5", y: 0.5, scale: 1.2 })).toThrow("focus.x");
  });

  it("rejects malformed focus geometry at the session event boundary", () => {
    expect(() =>
      parseSessionEvent({
        schemaVersion: 1,
        id: "1",
        sessionId: "id",
        sequence: 1,
        type: "agent.focus",
        data: { x: 0.5, y: 0.5, scale: 9 },
        createdAt: "2099-01-01T00:00:00.000Z"
      })
    ).toThrow("focus.scale");
  });
});
