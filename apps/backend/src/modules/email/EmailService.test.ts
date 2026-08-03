import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import { Resend } from "resend";
import { EmailService } from "./EmailService";
import { adminVerificationEmail } from "./email.templates";

vi.mock("resend", () => ({
  Resend: vi.fn()
}));

const env = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://atlas:atlas@localhost:5432/atlas",
  REDIS_URL: "redis://localhost:6379",
  S3_ENDPOINT: "http://localhost:9000",
  S3_REGION: "us-east-1",
  S3_BUCKET: "atlas",
  S3_ACCESS_KEY_ID: "atlas",
  S3_SECRET_ACCESS_KEY: "secret",
  TELEGRAM_SESSION_ENCRYPTION_KEY: "x".repeat(64),
  JWT_ACCESS_SECRET: "a".repeat(64),
  JWT_REFRESH_SECRET: "r".repeat(64),
  ACCESS_TOKEN_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_SECONDS: 2_592_000,
  COOKIE_DOMAIN: "localhost",
  COOKIE_SECURE: true,
  FRONTEND_ORIGIN: "http://localhost:3000",
  BACKEND_HOST: "0.0.0.0",
  BACKEND_PORT: 4000,
  ADMIN_VERIFICATION_TTL_SECONDS: 600,
  ADMIN_VERIFICATION_RESEND_COOLDOWN_SECONDS: 60,
  ADMIN_TRUSTED_DEVICE_TTL_SECONDS: 2_592_000,
  EMAIL_PROVIDER: "resend",
  RESEND_API_KEY: "re_test",
  EMAIL_FROM: "Atlas Security <security@atlasapp.io>",
  ENABLE_DEV_FIXTURES: false
} as const;

const emailsSend = vi.fn();

function logger() {
  return {
    info: vi.fn(),
    error: vi.fn()
  } as unknown as FastifyBaseLogger & { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
}

describe("EmailService", () => {
  beforeEach(() => {
    emailsSend.mockReset().mockResolvedValue({ data: { id: "email-id" }, error: null });
    vi.mocked(Resend).mockReset().mockImplementation(
      (key) =>
        ({
          key,
          emails: { send: emailsSend }
        }) as never
    );
  });

  it("uses a sending-only Resend key and performs no management API request at startup", async () => {
    const log = logger();
    const service = new EmailService(env, log);

    await service.verify();

    expect(Resend).toHaveBeenCalledWith("re_test");
    expect(emailsSend).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith("Email Provider: Resend");
    expect(log.info).toHaveBeenCalledWith("Provider ready.");
    expect(JSON.stringify(log.info.mock.calls)).not.toContain("re_test");
  });

  it("rejects locally invalid API key prefixes without a network request", async () => {
    const service = new EmailService({ ...env, RESEND_API_KEY: "invalid" }, logger());

    await expect(service.verify()).rejects.toThrow('RESEND_API_KEY must start with "re_"');
    expect(emailsSend).not.toHaveBeenCalled();
  });

  it("sends the Atlas verification template through Resend", async () => {
    const service = new EmailService(env, logger());

    await service.sendVerificationCode("admin@example.com", "123456");

    const template = adminVerificationEmail("123456", 10);
    expect(emailsSend).toHaveBeenCalledWith({
      from: "Atlas Security <security@atlasapp.io>",
      to: "admin@example.com",
      subject: "Atlas Security Verification Code",
      html: template.html,
      text: template.text,
      tags: [{ name: "category", value: "admin-verification" }]
    });
  });

  it("handles invalid API keys cleanly from the email-send endpoint", async () => {
    emailsSend.mockResolvedValue({ data: null, error: { name: "invalid_api_key", message: "Invalid API key", statusCode: 401 } });
    const service = new EmailService(env, logger());

    await expect(service.sendVerificationCode("admin@example.com", "123456")).rejects.toThrow("Resend authentication failed: Invalid API key");
  });

  it("handles restricted API key errors cleanly from the email-send endpoint", async () => {
    emailsSend.mockResolvedValue({
      data: null,
      error: { name: "restricted_api_key", message: "Key is not allowed to send emails", statusCode: 403 }
    });
    const service = new EmailService(env, logger());

    await expect(service.sendVerificationCode("admin@example.com", "123456")).rejects.toThrow("Resend API key restrictions");
  });

  it("handles unverified sender or domain errors cleanly", async () => {
    emailsSend.mockResolvedValue({
      data: null,
      error: { name: "validation_error", message: "Domain is not verified", statusCode: 400 }
    });
    const service = new EmailService(env, logger());

    await expect(service.sendVerificationCode("admin@example.com", "123456")).rejects.toThrow("Resend sender configuration failed: Domain is not verified");
  });

  it("retries transient send failures and then succeeds", async () => {
    emailsSend
      .mockResolvedValueOnce({ data: null, error: { name: "rate_limit_exceeded", message: "Rate limited", statusCode: 429 } })
      .mockResolvedValueOnce({ data: { id: "email-id" }, error: null });
    const service = new EmailService(env, logger());

    await service.sendVerificationCode("admin@example.com", "123456");

    expect(emailsSend).toHaveBeenCalledTimes(2);
  });

  it("logs and surfaces final provider send failures", async () => {
    const log = logger();
    emailsSend.mockResolvedValue({ data: null, error: { name: "invalid_from_address", message: "Invalid sender", statusCode: 400 } });
    const service = new EmailService(env, log);

    await expect(service.sendVerificationCode("admin@example.com", "123456")).rejects.toThrow("Resend sender configuration failed: Invalid sender");
    expect(log.error).toHaveBeenCalledWith(
      { to: "admin@example.com", subject: "Atlas Security Verification Code", providerError: "Invalid sender" },
      "email failed"
    );
    expect(JSON.stringify(log.error.mock.calls)).not.toContain("re_test");
  });
});
