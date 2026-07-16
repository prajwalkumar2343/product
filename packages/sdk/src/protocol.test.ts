import { describe, expect, it } from "vitest";
import { parseCreateSessionResponse, parseSessionEvent, parseViewResponse } from "./protocol.js";

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
});
