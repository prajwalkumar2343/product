import { readFile } from "node:fs/promises";
import { IntegrationSchema } from "@product/contracts";
import { loadConfig } from "../config.js";
import { FirestoreSessionStore } from "../store.js";

const file = process.argv[2];
if (!file) throw new Error("Usage: npm run admin:seed -- /path/to/integration.json");
const integration = IntegrationSchema.parse(JSON.parse(await readFile(file, "utf8")));
const config = loadConfig();
await new FirestoreSessionStore(config.GCP_PROJECT_ID, config.FIRESTORE_DATABASE).putIntegration(
  integration
);
process.stdout.write(`Seeded integration ${integration.id}\n`);
