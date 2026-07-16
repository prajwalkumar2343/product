import { z } from "zod";

const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    SERVICE_ROLE: z.enum(["api", "runner"]).default("api"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
    PUBLIC_API_URL: z.string().url(),
    SESSION_HMAC_SECRET: z.string().min(32),
    FIRESTORE_DATABASE: z.string().default("(default)"),
    GCP_PROJECT_ID: z.string().min(1),
    GCP_REGION: z.string().min(1).default("us-central1"),
    TASK_QUEUE: z.string().default("demo-sessions"),
    RUNNER_URL: z.string().url(),
    RUNNER_SHARED_SECRET: z.string().min(32).optional(),
    STEEL_API_KEY: z.string().min(1),
    MODEL_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
    MODEL_API_KEY: z.string().min(1),
    MODEL_NAME: z.string().min(1),
    TURNSTILE_SECRET: z.string().min(1).optional(),
    TASK_INVOKER_SERVICE_ACCOUNT: z.string().email().optional(),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info")
  })
  .superRefine((config, context) => {
    if (config.NODE_ENV !== "production") return;
    if (config.SERVICE_ROLE === "api" && !config.TURNSTILE_SECRET)
      context.addIssue({
        code: "custom",
        path: ["TURNSTILE_SECRET"],
        message: "Required in production"
      });
    if (config.SERVICE_ROLE === "api" && !config.TASK_INVOKER_SERVICE_ACCOUNT)
      context.addIssue({
        code: "custom",
        path: ["TASK_INVOKER_SERVICE_ACCOUNT"],
        message: "Required in production"
      });
  });

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  return ConfigSchema.parse(environment);
}
