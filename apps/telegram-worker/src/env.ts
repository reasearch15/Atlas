import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  TELEGRAM_SESSION_ENCRYPTION_KEY: z.string().min(64),
  TELEGRAM_WORKER_ID: z.string().min(1).default("telegram-worker-local"),
  TELEGRAM_LEASE_SECONDS: z.coerce.number().int().min(15).default(45),
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1)
});

export type WorkerEnv = z.infer<typeof envSchema>;

/**
 * Parses Telegram worker configuration from the environment.
 */
export function loadWorkerEnv(): WorkerEnv {
  loadRootEnvFile();
  try {
    return envSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error("Telegram worker configuration error:");
      for (const issue of error.issues) {
        const key = issue.path.join(".") || "(root)";
        if (issue.code === "invalid_type" && issue.received === "undefined") {
          console.error(`Missing required environment variable: ${key}`);
        } else {
          console.error(`Invalid configuration: ${key}: ${issue.message}`);
        }
      }
    }
    throw error;
  }
}

/**
 * Loads the repository root .env regardless of package execution directory.
 */
function loadRootEnvFile(): void {
  const candidates = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")];
  const envPath = candidates.find((candidate) => existsSync(candidate));
  if (envPath) {
    config({ path: envPath, override: false });
  }
}
