import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../config/env";
import { getFirebaseMessaging, resetFirebaseMessagingForTests } from "./firebase-admin.client";

const initializeApp = vi.fn();
const getApps = vi.fn(() => [] as unknown[]);
const cert = vi.fn((credentials: unknown) => credentials);
const getMessaging = vi.fn(() => ({ send: vi.fn() }));

vi.mock("firebase-admin", () => ({
  initializeApp,
  getApps,
  cert
}));

vi.mock("firebase-admin/messaging", () => ({
  getMessaging
}));

function env(partial: Partial<Env> = {}): Env {
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
    FCM_ENABLED: true,
    FIREBASE_PROJECT_ID: "proj",
    FIREBASE_CLIENT_EMAIL: "svc@proj.iam.gserviceaccount.com",
    FIREBASE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
    NOTIFICATION_TTL_HOURS: 168,
    ...partial
  } as Env;
}

describe("firebase-admin.client", () => {
  afterEach(() => {
    resetFirebaseMessagingForTests();
    vi.clearAllMocks();
    getApps.mockReturnValue([]);
  });

  it("returns not_configured when admin credentials are missing", async () => {
    const result = await getFirebaseMessaging(env({ FCM_ENABLED: false }));
    expect(result.status).toBe("not_configured");
    expect(initializeApp).not.toHaveBeenCalled();
  });

  it("initializes firebase-admin once with cert + getMessaging", async () => {
    const first = await getFirebaseMessaging(env());
    const second = await getFirebaseMessaging(env());

    expect(first.status).toBe("ready");
    expect(second.status).toBe("ready");
    expect(first.messaging).toBe(second.messaging);
    expect(initializeApp).toHaveBeenCalledTimes(1);
    expect(cert).toHaveBeenCalledWith({
      projectId: "proj",
      clientEmail: "svc@proj.iam.gserviceaccount.com",
      privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----"
    });
    expect(getMessaging).toHaveBeenCalledTimes(1);
  });

  it("skips initializeApp when an app already exists", async () => {
    getApps.mockReturnValue([{}]);
    const result = await getFirebaseMessaging(env());

    expect(result.status).toBe("ready");
    expect(initializeApp).not.toHaveBeenCalled();
    expect(getMessaging).toHaveBeenCalledTimes(1);
  });

  it("allows retry after init failure", async () => {
    initializeApp.mockImplementationOnce(() => {
      throw new Error("bad key");
    });

    const failed = await getFirebaseMessaging(env());
    expect(failed.status).toBe("init_failed");

    initializeApp.mockImplementationOnce(() => ({}));
    const recovered = await getFirebaseMessaging(env());
    expect(recovered.status).toBe("ready");
    expect(initializeApp).toHaveBeenCalledTimes(2);
  });
});
