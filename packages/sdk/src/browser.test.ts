// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import ProductDemo from "./index.js";

describe("CDN entry", () => {
  it("exposes the constructor directly as window.ProductDemo", async () => {
    await import("./browser.js");
    expect(globalThis.ProductDemo).toBe(ProductDemo);
    expect(typeof globalThis.ProductDemo).toBe("function");
  });
});
