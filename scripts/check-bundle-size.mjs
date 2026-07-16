import { stat } from "node:fs/promises";

const file = new URL("../packages/sdk/dist/product-demo.js", import.meta.url);
const maximumBytes = 15_000;
const { size } = await stat(file);
if (size > maximumBytes) {
  throw new Error(`Embed bundle is ${size} bytes; maximum is ${maximumBytes}`);
}
process.stdout.write(`Embed bundle: ${size}/${maximumBytes} bytes\n`);
