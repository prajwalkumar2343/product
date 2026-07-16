import type { Integration } from "@product/contracts";
import type { Browser, Page, Route } from "playwright-core";
import { chromium } from "playwright-core";
import { assertAllowedUrl, assertAllowedWebSocketUrl } from "./security.js";
import { authorizeClick, authorizeFixtureInput } from "./browser-policy.js";
import { BrandedCursor, installBrandedCursorOverlay } from "./cursor-overlay.js";

export interface PageElement {
  ref: string;
  tag: string;
  role: string | null;
  name: string;
  type: string | null;
  actionId: string | null;
  inputKey: string | null;
}

export class DemoBrowser {
  private readonly refs = new Map<
    string,
    { selector: string; actionId: string | null; inputKey: string | null }
  >();

  private constructor(
    private readonly browser: Browser,
    private readonly page: Page,
    private readonly integration: Integration
  ) {
    this.cursor = new BrandedCursor(page);
  }

  private readonly cursor: BrandedCursor;

  public static async connect(
    websocketUrl: string,
    apiKey: string,
    integration: Integration
  ): Promise<DemoBrowser> {
    const separator = websocketUrl.includes("?") ? "&" : "?";
    const browser = await chromium.connectOverCDP(
      `${websocketUrl}${separator}apiKey=${encodeURIComponent(apiKey)}`,
      { timeout: 20_000 }
    );
    const context = browser.contexts()[0];
    const page = context?.pages()[0];
    if (!context || !page) throw new Error("Steel session did not provide a page");
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.setBypassServiceWorker", { bypass: true });
    await context.addInitScript(() => {
      if ("serviceWorker" in navigator) {
        Object.defineProperty(navigator, "serviceWorker", { value: undefined });
      }
    });
    await context.addInitScript(installBrandedCursorOverlay);
    await page.evaluate(installBrandedCursorOverlay);
    await context.route("**/*", async (route) =>
      DemoBrowser.guardRoute(route, integration.allowedHosts)
    );
    await context.routeWebSocket("**/*", (route) => {
      try {
        assertAllowedWebSocketUrl(route.url(), integration.allowedHosts);
        route.connectToServer();
      } catch {
        return route.close({ code: 1008, reason: "Blocked by demo policy" });
      }
    });
    page.setDefaultTimeout(8_000);
    page.setDefaultNavigationTimeout(15_000);
    return new DemoBrowser(browser, page, integration);
  }

  public async openStartPage(): Promise<void> {
    await this.page.goto(
      assertAllowedUrl(this.integration.startUrl, this.integration.allowedHosts).href,
      { waitUntil: "domcontentloaded" }
    );
  }

  public async inspect(): Promise<{
    url: string;
    title: string;
    text: string;
    elements: PageElement[];
  }> {
    assertAllowedUrl(this.page.url(), this.integration.allowedHosts);
    const raw = await this.page
      .locator("a,button,input,textarea,select,[role=button],[role=link]")
      .evaluateAll((nodes) =>
        nodes.slice(0, 80).map((node, index) => {
          const element = node as HTMLElement;
          const input = node as HTMLInputElement;
          return {
            index,
            tag: element.tagName.toLowerCase(),
            role: element.getAttribute("role"),
            name: (
              element.getAttribute("aria-label") ||
              element.innerText ||
              input.placeholder ||
              input.value ||
              ""
            )
              .trim()
              .slice(0, 160),
            type: element.getAttribute("type"),
            actionId: element.getAttribute("data-ai-demo-action"),
            inputKey: element.getAttribute("data-ai-demo-input")
          };
        })
      );
    this.refs.clear();
    const elements = raw.map((element) => {
      const ref = `e${element.index}`;
      this.refs.set(ref, {
        selector: `a,button,input,textarea,select,[role=button],[role=link] >> nth=${element.index}`,
        actionId: element.actionId,
        inputKey: element.inputKey
      });
      return {
        ref,
        tag: element.tag,
        role: element.role,
        name: element.name,
        type: element.type,
        actionId: element.actionId,
        inputKey: element.inputKey
      };
    });
    const text = (await this.page.locator("body").innerText())
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 8_000);
    return { url: this.page.url(), title: await this.page.title(), text, elements };
  }

  public async goToFeature(featureId: string): Promise<{ url: string }> {
    const feature = this.integration.features.find((candidate) => candidate.id === featureId);
    if (!feature) throw new Error("Unknown feature");
    const destination = new URL(feature.path, this.integration.startUrl);
    assertAllowedUrl(destination.href, this.integration.allowedHosts);
    await this.page.goto(destination.href, { waitUntil: "domcontentloaded" });
    return { url: this.page.url() };
  }

  public async click(ref: string): Promise<{ url: string }> {
    const reference = this.requireRef(ref);
    authorizeClick(reference, this.integration);
    const locator = this.page.locator(reference.selector);
    const label =
      `${await locator.innerText().catch(() => "")} ${(await locator.getAttribute("aria-label")) ?? ""}`.toLowerCase();
    if (
      this.integration.forbiddenActionPatterns.some((pattern) =>
        label.includes(pattern.toLowerCase())
      )
    )
      throw new Error("Action denied by integration policy");
    await this.cursor.moveTo(locator);
    await locator.click();
    await this.page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);
    assertAllowedUrl(this.page.url(), this.integration.allowedHosts);
    return { url: this.page.url() };
  }

  public async typeFixture(ref: string, fixtureKey: string): Promise<{ typed: true }> {
    const value = this.integration.fixtures[fixtureKey];
    if (value === undefined) throw new Error("Unknown demo fixture");
    const reference = this.requireRef(ref);
    authorizeFixtureInput(reference, fixtureKey);
    const locator = this.page.locator(reference.selector);
    await this.cursor.moveTo(locator);
    await locator.fill(value);
    return { typed: true };
  }

  public async scroll(direction: "up" | "down"): Promise<{ scrolled: true }> {
    await this.page.mouse.wheel(0, direction === "down" ? 600 : -600);
    return { scrolled: true };
  }

  public async wait(milliseconds: number): Promise<{ waited: number }> {
    const bounded = Math.min(5_000, Math.max(100, milliseconds));
    await this.page.waitForTimeout(bounded);
    return { waited: bounded };
  }

  public async close(): Promise<void> {
    await this.browser.close();
  }

  private requireRef(ref: string): {
    selector: string;
    actionId: string | null;
    inputKey: string | null;
  } {
    const reference = this.refs.get(ref);
    if (!reference) throw new Error("Unknown or stale element reference; inspect the page again");
    return reference;
  }

  private static async guardRoute(route: Route, allowedHosts: readonly string[]): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    if (["data:", "blob:"].includes(url.protocol)) {
      await route.continue();
      return;
    }
    try {
      assertAllowedUrl(url.href, allowedHosts);
    } catch {
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  }
}
