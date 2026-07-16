import type Steel from "steel-sdk";
import { describe, expect, it, vi } from "vitest";
import { SteelBrowserProvider } from "./steel.js";

describe("Steel provider adapter", () => {
  it("creates a headful view-only session with a millisecond timeout", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "steel-1",
      websocketUrl: "wss://connect.steel.dev/session?id=1",
      sessionViewerUrl: "https://app.steel.dev/sessions/steel-1"
    });
    const sessions = { create, release: vi.fn() } as unknown as Steel["sessions"];
    const provider = new SteelBrowserProvider({ apiKey: "key", client: { sessions } });
    const session = await provider.create({ timeoutMilliseconds: 600_000, profileId: "profile-1" });
    expect(create).toHaveBeenCalledWith({
      blockAds: true,
      headless: false,
      dimensions: { width: 1440, height: 900 },
      debugConfig: { interactive: false, systemCursor: false },
      timeout: 600_000,
      profileId: "profile-1"
    });
    expect(session.viewerUrl).toBe("https://app.steel.dev/sessions/steel-1");
  });

  it("rejects an endpoint outside Steel's domain", async () => {
    const sessions = {
      create: vi.fn().mockResolvedValue({
        id: "steel-1",
        websocketUrl: "wss://evil.example/ws",
        sessionViewerUrl: "https://app.steel.dev/sessions/1"
      }),
      release: vi.fn()
    } as unknown as Steel["sessions"];
    await expect(
      new SteelBrowserProvider({ apiKey: "key", client: { sessions } }).create({
        timeoutMilliseconds: 60_000
      })
    ).rejects.toThrow("untrusted");
  });
});
