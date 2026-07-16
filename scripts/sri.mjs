import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const file = new URL("../packages/sdk/dist/product-demo.js", import.meta.url);
const digest = createHash("sha384")
  .update(await readFile(file))
  .digest("base64");
process.stdout.write(`sha384-${digest}\n`);
