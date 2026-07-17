import { stat } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const file = new URL("../packages/sdk/dist/product-demo.js", import.meta.url);
const maximumBytes = 20_000;
const maximumGzipBytes = 7_000;
const { size } = await stat(file);
const gzipSize = gzipSync(await readFile(file), { level: 9 }).byteLength;
if (size > maximumBytes) {
  throw new Error(`Embed bundle is ${size} bytes; maximum is ${maximumBytes}`);
}
if (gzipSize > maximumGzipBytes) {
  throw new Error(`Gzipped embed bundle is ${gzipSize} bytes; maximum is ${maximumGzipBytes}`);
}
process.stdout.write(
  `Embed bundle: ${size}/${maximumBytes} bytes (${gzipSize}/${maximumGzipBytes} gzip)\n`
);
