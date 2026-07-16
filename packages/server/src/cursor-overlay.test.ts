// @vitest-environment happy-dom

import type { Locator, Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrandedCursor, installBrandedCursorOverlay } from "./cursor-overlay.js";

describe("branded demo cursor", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.documentElement
      .querySelectorAll("[data-ai-demo-cursor-layer]")
      .forEach((element) => element.remove());
  });

  it("is visible, isolated, non-interactive, and follows mouse movement", () => {
    installBrandedCursorOverlay();
    const cursor = requireCursor();

    expect(cursor.getAttribute("aria-hidden")).toBe("true");
    expect(cursor.tabIndex).toBe(-1);
    expect(cursor.shadowRoot).toBeNull();
    expect(cursor.style.getPropertyValue("pointer-events")).toBe("none");
    expect(cursor.style.getPropertyPriority("pointer-events")).toBe("important");
    expect(cursor.style.getPropertyValue("visibility")).toBe("visible");

    document.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 140, clientY: 90 })
    );
    expect(cursor.style.getPropertyValue("transform")).toBe("translate3d(100px, 69px, 0)");
  });

  it("pulses on click and remounts if page code removes it", async () => {
    vi.useFakeTimers();
    installBrandedCursorOverlay();
    const cursor = requireCursor();

    document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(cursor.hasAttribute("data-click-pulse")).toBe(true);
    await vi.advanceTimersByTimeAsync(180);
    expect(cursor.hasAttribute("data-click-pulse")).toBe(false);

    cursor.remove();
    await Promise.resolve();
    expect(cursor.parentElement).toBe(document.documentElement);
  });

  it("moves to the actionable target before the browser interaction", async () => {
    const scrollIntoViewIfNeeded = vi.fn().mockResolvedValue(undefined);
    const boundingBox = vi.fn().mockResolvedValue({ x: 100, y: 40, width: 80, height: 30 });
    const move = vi.fn().mockResolvedValue(undefined);
    const waitForTimeout = vi.fn().mockResolvedValue(undefined);
    const page = { mouse: { move }, waitForTimeout } as unknown as Page;
    const locator = { scrollIntoViewIfNeeded, boundingBox } as unknown as Locator;

    await new BrandedCursor(page).moveTo(locator);

    expect(scrollIntoViewIfNeeded).toHaveBeenCalledOnce();
    expect(move).toHaveBeenCalledWith(140, 55, { steps: 12 });
    expect(waitForTimeout).toHaveBeenCalledWith(280);
  });

  it("fails before interaction when a target cannot be positioned", async () => {
    const move = vi.fn();
    const page = {
      mouse: { move },
      waitForTimeout: vi.fn()
    } as unknown as Page;
    const locator = {
      scrollIntoViewIfNeeded: vi.fn().mockResolvedValue(undefined),
      boundingBox: vi.fn().mockResolvedValue(null)
    } as unknown as Locator;

    await expect(new BrandedCursor(page).moveTo(locator)).rejects.toThrow("hidden target");
    expect(move).not.toHaveBeenCalled();
  });
});

function requireCursor(): HTMLElement {
  const cursor = document.documentElement.querySelector<HTMLElement>("[data-ai-demo-cursor-layer]");
  if (!cursor) throw new Error("Cursor was not installed");
  return cursor;
}
