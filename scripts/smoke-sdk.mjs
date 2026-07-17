import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInThisContext } from "node:vm";

const browserBundle = new URL("../packages/sdk/dist/product-demo.js", import.meta.url);
const moduleBundle = new URL("../packages/sdk/dist/product-demo.mjs", import.meta.url);

runInThisContext(await readFile(browserBundle, "utf8"), {
  filename: "product-demo.js"
});
assert.equal(typeof globalThis.ProductDemo, "function");

const imported = await import(`${moduleBundle.href}?smoke=1`);
assert.equal(typeof imported.default, "function");
assert.deepEqual(Object.keys(imported), ["default"]);

const sdk = new imported.default({ integrationId: "smoke_test" });
assert.ok(sdk instanceof imported.default);

process.stdout.write("SDK CDN and ESM entrypoints passed smoke validation\n");
