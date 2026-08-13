import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import { z } from "zod";

const optionalEmail = z.preprocess((value) => (value === "" ? undefined : value), z.string().email().optional());

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    S3_ENDPOINT: z.string().url(),
    S3_REGION: z.string().min(1),
    S3_BUCKET: z.string().min(1),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    TELEGRAM_SESSION_ENCRYPTION_KEY: z.string().min(64),
    JWT_ACCESS_SECRET: z.string().min(64),
    JWT_REFRESH_SECRET: z.string().min(64),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),
    COOKIE_DOMAIN: z.string().default("localhost"),
    COOKIE_SECURE: z.coerce.boolean().default(false),
    FRONTEND_ORIGIN: z.string().url(),
    BACKEND_HOST: z.string().min(1).default("0.0.0.0"),
    BACKEND_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
    ADMIN_VERIFICATION_TTL_SECONDS: z.coerce.number().int().positive().default(600),
    ADMIN_VERIFICATION_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(60),
    ADMIN_TRUSTED_DEVICE_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),
    EMAIL_PROVIDER: z.literal("resend"),
    RESEND_API_KEY: z.string().trim().min(1, "RESEND_API_KEY is required when EMAIL_PROVIDER=resend"),
    EMAIL_FROM: z.string().trim().min(1, "EMAIL_FROM is required"),
    BOOTSTRAP_ADMIN_EMAIL: optionalEmail,
    BOOTSTRAP_ADMIN_PASSWORD: z.preprocess((value) => (value === "" ? undefined : value), z.string().min(12).optional()),
    ENABLE_DEV_FIXTURES: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    /** When false or incomplete, push dispatch no-ops safely (local/test). */
    FCM_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    FIREBASE_PROJECT_ID: z.preprocess((value) => (value === "" ? undefined : value), z.string().min(1).optional()),
    FIREBASE_CLIENT_EMAIL: z.preprocess((value) => (value === "" ? undefined : value), z.string().email().optional()),
    FIREBASE_PRIVATE_KEY: z.preprocess((value) => (value === "" ? undefined : value), z.string().min(1).optional()),
    FIREBASE_WEB_API_KEY: z.preprocess((value) => (value === "" ? undefined : value), z.string().min(1).optional()),
    FIREBASE_WEB_AUTH_DOMAIN: z.preprocess((value) => (value === "" ? undefined : value), z.string().min(1).optional()),
    FIREBASE_MESSAGING_SENDER_ID: z.preprocess((value) => (value === "" ? undefined : value), z.string().min(1).optional()),
    FIREBASE_WEB_APP_ID: z.preprocess((value) => (value === "" ? undefined : value), z.string().min(1).optional()),
    FIREBASE_VAPID_KEY: z.preprocess((value) => (value === "" ? undefined : value), z.string().min(1).optional()),
    /** How long pending customer notifications remain retryable (default 7 days). */
    NOTIFICATION_TTL_HOURS: z.coerce.number().int().positive().default(168),
    /**
     * Public HTTPS origin of atlas-backend for Telegram bot webhooks
     * (e.g. https://api.example.com). When set, leaderboard bots register webhooks.
     */
    LEADERBOARD_BOT_WEBHOOK_BASE_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().url().optional()
    ),
    /** Local/dev only: poll getUpdates when webhook base URL is unset. */
    LEADERBOARD_BOT_POLLING: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true")
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== "production") {
      return;
    }

    if (!env.COOKIE_SECURE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["COOKIE_SECURE"],
        message: "COOKIE_SECURE must be true in production"
      });
    }

    if (env.ENABLE_DEV_FIXTURES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ENABLE_DEV_FIXTURES"],
        message: "ENABLE_DEV_FIXTURES must be false in production"
      });
    }

    if (env.COOKIE_DOMAIN === "localhost") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["COOKIE_DOMAIN"],
        message: "COOKIE_DOMAIN must not be localhost in production"
      });
    }

    if (!/^https:\/\//i.test(env.FRONTEND_ORIGIN)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["FRONTEND_ORIGIN"],
        message: "FRONTEND_ORIGIN must use https in production"
      });
    }

    if (env.FCM_ENABLED) {
      for (const key of [
        "FIREBASE_PROJECT_ID",
        "FIREBASE_CLIENT_EMAIL",
        "FIREBASE_PRIVATE_KEY",
        "FIREBASE_WEB_API_KEY",
        "FIREBASE_MESSAGING_SENDER_ID",
        "FIREBASE_WEB_APP_ID",
        "FIREBASE_VAPID_KEY"
      ] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required when FCM_ENABLED=true`
          });
        }
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Parses and validates process environment configuration at startup.
 */
export function loadEnv(): Env {
  loadRootEnvFile();
  try {
    return envSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const missing = error.issues
        .filter((issue) => issue.code === "invalid_type" && issue.received === "undefined")
        .map((issue) => issue.path.join("."));
      for (const key of missing) {
        console.error(`Missing required environment variable: ${key}`);
      }
    }
    throw error;
  }
}

/**
 * Loads the repository root .env regardless of the package working directory.
 */
function loadRootEnvFile(): void {
  const candidates = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")];
  const envPath = candidates.find((candidate) => existsSync(candidate));
  if (envPath) {
    config({ path: envPath, override: true });
  }
}
