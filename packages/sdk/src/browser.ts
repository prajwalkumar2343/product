import ProductDemoSDK from "./index.js";

declare global {
  var ProductDemo: typeof ProductDemoSDK | undefined;
}

if (globalThis.ProductDemo && globalThis.ProductDemo !== ProductDemoSDK)
  throw new Error("ProductDemo SDK is already loaded");

Object.defineProperty(globalThis, "ProductDemo", {
  value: ProductDemoSDK,
  configurable: false,
  enumerable: false,
  writable: false
});
