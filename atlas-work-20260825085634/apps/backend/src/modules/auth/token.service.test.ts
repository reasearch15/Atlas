import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import type { Env } from "../../config/env";
import { TokenService } from "./token.service";

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

const user = {
  id: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  email: "north.coadmin",
  name: "North Coadmin",
  role: "COADMIN" as const,
  workspaceId: "33333333-3333-4333-8333-333333333333"
};

describe("TokenService access token expiry", () => {
  it("returns 401 ACCESS_TOKEN_EXPIRED when the access JWT exp claim has passed", async () => {
    const tokens = new TokenService(env);
    const expired = await new SignJWT({
      sid: user.sessionId,
      email: user.email,
      name: user.name,
      role: user.role,
      workspaceId: user.workspaceId
    })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(user.id)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 1_800)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(env.JWT_ACCESS_SECRET));

    await expect(tokens.verifyAccessToken(expired)).rejects.toMatchObject({
      statusCode: 401,
      code: "ACCESS_TOKEN_EXPIRED"
    });
  });

  it("verifies a freshly signed access token", async () => {
    const tokens = new TokenService(env);
    const accessToken = await tokens.signAccessToken(user);
    await expect(tokens.verifyAccessToken(accessToken)).resolves.toMatchObject({
      id: user.id,
      sessionId: user.sessionId,
      role: "COADMIN"
    });
  });

  it("maps invalid access tokens to 401 UNAUTHORIZED without throwing jose errors", async () => {
    const tokens = new TokenService(env);
    await expect(tokens.verifyAccessToken("not-a-jwt")).rejects.toMatchObject({
      statusCode: 401,
      code: "UNAUTHORIZED"
    });
  });
});
