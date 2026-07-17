import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

rmSync("dist-types", { recursive: true, force: true });
execFileSync(
  process.execPath,
  ["../../node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"],
  {
    stdio: "inherit"
  }
);

const shared = {
  entryPoints: ["src/index.ts"],
  bundle: true,
  minify: true,
  sourcemap: true,
  target: "es2022",
  legalComments: "none"
};

await Promise.all([
  build({
    ...shared,
    format: "iife",
    globalName: "ProductDemo",
    outfile: "dist/product-demo.js"
  }),
  build({
    ...shared,
    format: "esm",
    outfile: "dist/product-demo.mjs"
  }),
  build({
    ...shared,
    entryPoints: ["src/client.ts"],
    format: "esm",
    outfile: "dist/client.mjs"
  })
]);
