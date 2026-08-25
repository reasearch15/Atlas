import { describe, expect, it } from "vitest";
import type { Env } from "../../config/env";
import { AuthService } from "./auth.service";

const env: Env = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://atlas:atlas@localhost:5432/atlas",
  REDIS_URL: "redis://localhost:6379",
  S3_ENDPOINT: "http://localhost:9000",
  S3_REGION: "us-east-1",
  S3_BUCKET: "atlas",
  S3_ACCESS_KEY_ID: "atlas",
  S3_SECRET_ACCESS_KEY: "atlas-secret",
  TELEGRAM_SESSION_ENCRYPTION_KEY: "a".repeat(64),
  JWT_ACCESS_SECRET: "b".repeat(64),
  JWT_REFRESH_SECRET: "c".repeat(64),
  ACCESS_TOKEN_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_SECONDS: 2_592_000,
  COOKIE_DOMAIN: "localhost",
  COOKIE_SECURE: false,
  FRONTEND_ORIGIN: "http://localhost:3000",
  BACKEND_HOST: "0.0.0.0",
  BACKEND_PORT: 4000,
  ADMIN_VERIFICATION_TTL_SECONDS: 600,
  ADMIN_VERIFICATION_RESEND_COOLDOWN_SECONDS: 60,
  ADMIN_TRUSTED_DEVICE_TTL_SECONDS: 2_592_000,
  EMAIL_PROVIDER: "resend",
  RESEND_API_KEY: "re_test",
  EMAIL_FROM: "Atlas Security <security@example.com>",
  BOOTSTRAP_ADMIN_EMAIL: undefined,
  BOOTSTRAP_ADMIN_PASSWORD: undefined,
  ENABLE_DEV_FIXTURES: false
};

describe("AuthService generic login", () => {
  it("does not allow Platform Admin authentication through the generic login endpoint", async () => {
    const prisma = {
      user: {
        findUnique: async () => ({
          id: "admin-user",
          email: "pokharelayush3@gmail.com",
          username: null,
          name: "Platform Admin",
          role: "PLATFORM_ADMIN",
          status: "ACTIVE",
          workspaceId: null,
          workspace: null,
          platformAdmin: { id: "platform-admin" },
          passwordHash: "not-used"
        })
      }
    };
    const service = new AuthService(prisma as any, env);

    await expect(
      service.login(
        {
          body: { email: "pokharelayush3@gmail.com", password: "CorrectPassword123!" },
          headers: {},
          ip: "127.0.0.1"
        } as any,
        { setCookie: () => undefined } as any
      )
    ).rejects.toMatchObject({ statusCode: 401, code: "UNAUTHORIZED" });
  });
});
