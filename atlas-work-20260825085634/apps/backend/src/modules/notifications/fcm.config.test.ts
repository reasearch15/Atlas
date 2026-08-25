import { describe, expect, it } from "vitest";
import {
  getNotificationWebConfig,
  isFcmConfigured,
  isFcmWebClientConfigured,
  normalizeFirebaseVapidKey
} from "./fcm.config";
import type { Env } from "../../config/env";

function env(partial: Partial<Env>): Env {
  return {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://atlas:atlas@localhost:5432/atlas?schema=public",
    REDIS_URL: "redis://localhost:6379",
    S3_ENDPOINT: "http://localhost:9000",
    S3_REGION: "us-east-1",
    S3_BUCKET: "atlas",
    S3_ACCESS_KEY_ID: "atlas",
    S3_SECRET_ACCESS_KEY: "secret",
    TELEGRAM_SESSION_ENCRYPTION_KEY: "x".repeat(64),
    JWT_ACCESS_SECRET: "y".repeat(64),
    JWT_REFRESH_SECRET: "z".repeat(64),
    ACCESS_TOKEN_TTL_SECONDS: 900,
    REFRESH_TOKEN_TTL_SECONDS: 2592000,
    COOKIE_DOMAIN: "localhost",
    COOKIE_SECURE: false,
    FRONTEND_ORIGIN: "http://localhost:3000",
    BACKEND_HOST: "0.0.0.0",
    BACKEND_PORT: 4000,
    ADMIN_VERIFICATION_TTL_SECONDS: 600,
    ADMIN_VERIFICATION_RESEND_COOLDOWN_SECONDS: 60,
    ADMIN_TRUSTED_DEVICE_TTL_SECONDS: 2592000,
    EMAIL_PROVIDER: "resend",
    RESEND_API_KEY: "re_test",
    EMAIL_FROM: "Atlas <a@b.co>",
    ENABLE_DEV_FIXTURES: false,
    FCM_ENABLED: false,
    NOTIFICATION_TTL_HOURS: 168,
    ...partial
  } as Env;
}

describe("FCM web config", () => {
  it("stays disabled until admin + web client fields are complete", () => {
    const incomplete = env({
      FCM_ENABLED: true,
      FIREBASE_PROJECT_ID: "proj",
      FIREBASE_CLIENT_EMAIL: "a@b.com",
      FIREBASE_PRIVATE_KEY: "key",
      FIREBASE_WEB_API_KEY: "api",
      FIREBASE_VAPID_KEY: "vapid"
    });
    expect(isFcmConfigured(incomplete)).toBe(true);
    expect(isFcmWebClientConfigured(incomplete)).toBe(false);
    expect(getNotificationWebConfig(incomplete).enabled).toBe(false);
  });

  it("enables when messaging sender + app id + vapid are present", () => {
    const ready = env({
      FCM_ENABLED: true,
      FIREBASE_PROJECT_ID: "proj",
      FIREBASE_CLIENT_EMAIL: "a@b.com",
      FIREBASE_PRIVATE_KEY: "key",
      FIREBASE_WEB_API_KEY: "api",
      FIREBASE_MESSAGING_SENDER_ID: "123",
      FIREBASE_WEB_APP_ID: "1:123:web:abc",
      FIREBASE_VAPID_KEY: ' "BN key" '
    });
    const config = getNotificationWebConfig(ready);
    expect(config.enabled).toBe(true);
    expect(config.vapidKey).toBe("BNkey");
    expect(config.messagingSenderId).toBe("123");
    expect(config.appId).toBe("1:123:web:abc");
  });

  it("normalizes VAPID keys", () => {
    expect(normalizeFirebaseVapidKey(" BN%2Bxx ")).toBe("BN+xx");
  });
});
