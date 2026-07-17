import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

const apiUrl = process.env.PRODUCT_DEMO_API_URL;
if (!apiUrl) throw new Error("PRODUCT_DEMO_API_URL is required to build the SDK");
const parsedApiUrl = new URL(apiUrl);
const localDevelopment = ["localhost", "127.0.0.1"].includes(parsedApiUrl.hostname);
if (
  (parsedApiUrl.protocol !== "https:" &&
    !(localDevelopment && parsedApiUrl.protocol === "http:")) ||
  parsedApiUrl.username ||
  parsedApiUrl.password ||
  parsedApiUrl.pathname !== "/" ||
  parsedApiUrl.search ||
  parsedApiUrl.hash
)
  throw new Error(
    "PRODUCT_DEMO_API_URL must be HTTPS (or local HTTP) without credentials or a query"
  );

rmSync("dist", { recursive: true, force: true });
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
  legalComments: "none",
  define: { __PRODUCT_DEMO_API_URL__: JSON.stringify(parsedApiUrl.href.replace(/\/$/, "")) }
};

await Promise.all([
  build({
    ...shared,
    entryPoints: ["src/browser.ts"],
    format: "iife",
    outfile: "dist/product-demo.js"
  }),
  build({
    ...shared,
    format: "esm",
    outfile: "dist/product-demo.mjs"
  })
]);
