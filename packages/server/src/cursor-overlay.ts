import type { Locator, Page } from "playwright-core";

const CURSOR_TRAVEL_MILLISECONDS = 280;

/**
 * Installs the presentation-only cursor inside the page being streamed by Steel.
 * This function must remain self-contained because Playwright serializes it into
 * each new document through BrowserContext.addInitScript.
 */
export function installBrandedCursorOverlay(): void {
  const controllerKey = "__productDemoCursorOverlayV1";
  const cursorWindow = window as Window & {
    [controllerKey]?: Readonly<{ mount: () => void }>;
  };
  const existingController = cursorWindow[controllerKey];
  if (existingController) {
    existingController.mount();
    return;
  }

  let cursorHost: HTMLElement | undefined;
  let pulseTimer: number | undefined;
  let cursorX = Math.min(72, Math.max(12, window.innerWidth - 4));
  let cursorY = Math.min(64, Math.max(12, window.innerHeight - 4));

  const positionCursor = (): void => {
    if (!cursorHost) return;
    // The right-facing point is the cursor hotspot.
    cursorHost.style.setProperty(
      "transform",
      `translate3d(${Math.round(cursorX - 40)}px, ${Math.round(cursorY - 21)}px, 0)`,
      "important"
    );
  };

  const createCursor = (): HTMLElement => {
    const host = document.createElement("div");
    host.setAttribute("data-ai-demo-cursor-layer", "");
    host.setAttribute("aria-hidden", "true");
    host.tabIndex = -1;
    host.style.cssText = [
      "display:block!important",
      "position:fixed!important",
      "inset:0 auto auto 0!important",
      "width:44px!important",
      "height:48px!important",
      "margin:0!important",
      "padding:0!important",
      "border:0!important",
      "background:transparent!important",
      "pointer-events:none!important",
      "user-select:none!important",
      "visibility:visible!important",
      "opacity:1!important",
      "overflow:visible!important",
      "z-index:2147483647!important",
      "transition:transform 260ms cubic-bezier(.22,1,.36,1)!important",
      "transform-origin:40px 21px!important",
      "will-change:transform!important"
    ].join(";");

    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        :host{all:initial}
        svg{display:block;width:44px;height:48px;overflow:visible;filter:drop-shadow(0 2px 2px rgba(2,72,160,.35)) drop-shadow(0 0 11px rgba(24,137,255,.65));transform-origin:40px 21px}
        path{fill:#1689ff;stroke:#d9efff;stroke-width:1.1;stroke-linejoin:round}
        :host([data-click-pulse]) svg{animation:ai-demo-cursor-click 180ms ease-out}
        :host([data-click-pulse]) .pulse{animation:ai-demo-cursor-ring 180ms ease-out}
        .pulse{fill:none;stroke:#1689ff;stroke-width:2;opacity:0;transform-origin:40px 21px}
        @keyframes ai-demo-cursor-click{50%{transform:scale(.84)}100%{transform:scale(1)}}
        @keyframes ai-demo-cursor-ring{0%{opacity:.8;transform:scale(.25)}100%{opacity:0;transform:scale(1.4)}}
        @media (prefers-reduced-motion:reduce){svg,.pulse{animation:none!important}}
      </style>
      <svg viewBox="0 0 44 48" aria-hidden="true" focusable="false">
        <circle class="pulse" cx="40" cy="21" r="10" />
        <path d="M3 2.5 40 21 6 44.5Z" />
      </svg>`;
    return host;
  };

  const mount = (): void => {
    cursorHost ??= createCursor();
    if (cursorHost.parentElement !== document.documentElement) {
      document.documentElement.append(cursorHost);
    }
    positionCursor();
  };

  const controller = Object.freeze({ mount });
  Object.defineProperty(cursorWindow, controllerKey, {
    value: controller,
    configurable: false,
    enumerable: false,
    writable: false
  });

  document.addEventListener(
    "mousemove",
    (event) => {
      cursorX = event.clientX;
      cursorY = event.clientY;
      mount();
    },
    true
  );
  document.addEventListener(
    "mousedown",
    () => {
      mount();
      cursorHost?.setAttribute("data-click-pulse", "");
      if (pulseTimer !== undefined) window.clearTimeout(pulseTimer);
      pulseTimer = window.setTimeout(() => cursorHost?.removeAttribute("data-click-pulse"), 180);
    },
    true
  );

  const observer = new MutationObserver(mount);
  observer.observe(document.documentElement, { childList: true });
  mount();
}

export class BrandedCursor {
  public constructor(private readonly page: Page) {}

  public async moveTo(locator: Locator): Promise<void> {
    await locator.scrollIntoViewIfNeeded();
    const bounds = await locator.boundingBox();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
      throw new Error("Cannot position the demo cursor over a hidden target");
    }
    await this.page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, {
      steps: 12
    });
    await this.page.waitForTimeout(CURSOR_TRAVEL_MILLISECONDS);
  }
}
