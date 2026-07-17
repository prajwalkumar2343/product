import type { Integration } from "@product/contracts";
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const playwrightMocks = vi.hoisted(() => ({ connectOverCDP: vi.fn() }));
vi.mock("playwright-core", () => ({
  chromium: { connectOverCDP: playwrightMocks.connectOverCDP }
}));

import { DemoBrowser } from "./browser.js";

describe("demo browser cursor integration", () => {
  beforeEach(() => playwrightMocks.connectOverCDP.mockReset());

  it("installs the overlay and moves it before an authorized click", async () => {
    const order: string[] = [];
    const actionLocator = {
      innerText: vi.fn().mockResolvedValue("Apply filter"),
      getAttribute: vi.fn().mockResolvedValue(null),
      scrollIntoViewIfNeeded: vi.fn().mockImplementation(async () => order.push("scroll")),
      boundingBox: vi.fn().mockResolvedValue({ x: 100, y: 40, width: 80, height: 30 }),
      click: vi.fn().mockImplementation(async () => order.push("click"))
    } as unknown as Locator;
    const inspectLocator = {
      evaluateAll: vi.fn().mockResolvedValue([
        {
          index: 0,
          tag: "button",
          role: null,
          name: "Apply filter",
          type: "button",
          actionId: "apply_filter",
          inputKey: null
        }
      ])
    } as unknown as Locator;
    const bodyLocator = {
      innerText: vi.fn().mockResolvedValue("Analytics Apply filter")
    } as unknown as Locator;
    const addInitScript = vi.fn().mockResolvedValue(undefined);
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ width: 1_000, height: 500 });
    const page = {
      url: vi.fn().mockReturnValue("https://demo.example.com/analytics"),
      title: vi.fn().mockResolvedValue("Analytics"),
      locator: vi.fn((selector: string) => {
        if (selector === "body") return bodyLocator;
        if (selector.includes("nth=0")) return actionLocator;
        return inspectLocator;
      }),
      evaluate,
      setDefaultTimeout: vi.fn(),
      setDefaultNavigationTimeout: vi.fn(),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockImplementation(async () => order.push("settle")),
      mouse: {
        move: vi.fn().mockImplementation(async () => order.push("move"))
      }
    } as unknown as Page;
    const context = {
      pages: vi.fn().mockReturnValue([page]),
      newCDPSession: vi.fn().mockResolvedValue({ send: vi.fn().mockResolvedValue(undefined) }),
      addInitScript,
      route: vi.fn().mockResolvedValue(undefined),
      routeWebSocket: vi.fn().mockResolvedValue(undefined)
    } as unknown as BrowserContext;
    const browser = {
      contexts: vi.fn().mockReturnValue([context]),
      close: vi.fn().mockResolvedValue(undefined)
    } as unknown as Browser;
    playwrightMocks.connectOverCDP.mockResolvedValue(browser);

    const demoBrowser = await DemoBrowser.connect(
      "wss://connect.steel.dev/session?id=1",
      "steel-key",
      makeIntegration()
    );
    await demoBrowser.inspect();
    await expect(demoBrowser.focus("e0")).resolves.toEqual({ x: 0.14, y: 0.11, scale: 1.5 });
    await demoBrowser.click("e0");

    expect(addInitScript).toHaveBeenCalledTimes(2);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(order).toEqual(["scroll", "scroll", "move", "settle", "click"]);
  });
});

function makeIntegration(): Integration {
  return {
    schemaVersion: 1,
    id: "acme",
    name: "Acme",
    enabled: true,
    allowedOrigins: ["https://www.example.com"],
    startUrl: "https://demo.example.com",
    allowedHosts: ["demo.example.com"],
    features: [{ id: "analytics", name: "Analytics", description: "Analytics", path: "/" }],
    fixtures: {},
    allowedActionIds: ["apply_filter"],
    forbiddenActionPatterns: ["delete"],
    maxDurationSeconds: 600,
    maxSteps: 5,
    maxConcurrentSessions: 1,
    turnstileRequired: true,
    productGuide: "Guide",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}
