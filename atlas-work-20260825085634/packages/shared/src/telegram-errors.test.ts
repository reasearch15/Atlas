import { describe, expect, it } from "vitest";
import { classifyTelegramFailure, sanitizeTelegramError } from "./telegram-errors";

describe("Telegram safe error handling", () => {
  it("sanitizes circular GramJS-like objects without walking connection internals", () => {
    const connection: Record<string, unknown> = {};
    const packet = { _conn: connection };
    connection.packet = packet;
    const error = Object.assign(new Error("Connection failed for +15551234567 with code 123456"), {
      code: "ECONNRESET",
      connection
    });

    const safe = sanitizeTelegramError(error, false);

    expect(safe).toMatchObject({
      name: "Error",
      code: "ECONNRESET"
    });
    expect(safe.message).not.toContain("+15551234567");
    expect(safe.message).not.toContain("123456");
    expect(JSON.stringify(safe)).not.toContain("_conn");
  });

  it("redacts Telegram secrets from selected scalar fields", () => {
    const safe = sanitizeTelegramError(
      {
        name: "RPCError",
        message: "api_hash=abcdef session=secret AUTH_KEY +9779812345678 654321",
        errorMessage: "password=hunter2 phoneCodeHash=abc123"
      },
      false
    );

    const encoded = JSON.stringify(safe);
    expect(encoded).not.toContain("abcdef");
    expect(encoded).not.toContain("secret");
    expect(encoded).not.toContain("+9779812345678");
    expect(encoded).not.toContain("654321");
    expect(encoded).not.toContain("hunter2");
    expect(encoded).not.toContain("abc123");
  });

  it("does not classify new authorization failures as reauthorization-required", () => {
    const failure = classifyTelegramFailure(new Error("Converting circular structure to JSON"), "CODE_REQUESTED", false);

    expect(failure).toMatchObject({
      nextAuthorizationState: "CODE_REQUESTED",
      nextStatus: "WAITING_FOR_CODE",
      safeErrorCode: "TELEGRAM_INTERNAL_SERIALIZATION_ERROR",
      retryable: true
    });
  });

  it("classifies confirmed revoked stored sessions as reauthorization-required", () => {
    const failure = classifyTelegramFailure(new Error("AUTH_KEY_UNREGISTERED"), "AUTHORIZED", true);

    expect(failure).toMatchObject({
      nextAuthorizationState: "REAUTH_REQUIRED",
      nextStatus: "REAUTH_REQUIRED",
      nextSyncState: "PAUSED",
      safeErrorCode: "TELEGRAM_AUTH_KEY_INVALID",
      retryable: false
    });
  });

  it("classifies missing auth context as terminal restart-required setup failure", () => {
    const failure = classifyTelegramFailure(new Error("TELEGRAM_AUTH_CONTEXT_MISSING"), "CODE_REQUESTED", false);

    expect(failure).toMatchObject({
      nextAuthorizationState: "PHONE_REQUESTED",
      nextStatus: "FAILED",
      nextSyncState: "FAILED",
      safeErrorCode: "TELEGRAM_AUTH_CONTEXT_MISSING",
      retryable: false
    });
  });

  it("classifies wrong Telegram OTP without treating it as an internal error", () => {
    const failure = classifyTelegramFailure(new Error("PHONE_CODE_INVALID"), "CODE_REQUESTED", false);

    expect(failure).toMatchObject({
      nextAuthorizationState: "CODE_REQUESTED",
      nextStatus: "WAITING_FOR_CODE",
      safeErrorCode: "PHONE_CODE_INVALID",
      retryable: true
    });
  });

  it("classifies expired OTP as restart-from-phone", () => {
    const failure = classifyTelegramFailure(new Error("PHONE_CODE_EXPIRED"), "CODE_REQUESTED", false);

    expect(failure).toMatchObject({
      nextAuthorizationState: "PHONE_REQUESTED",
      nextStatus: "WAITING_FOR_PHONE",
      safeErrorCode: "PHONE_CODE_EXPIRED",
      retryable: false
    });
  });

  it("classifies auth RPC timeout as retryable WAITING_FOR_CODE", () => {
    const failure = classifyTelegramFailure(new Error("TELEGRAM_AUTH_NETWORK_TIMEOUT"), "CODE_REQUESTED", false);

    expect(failure).toMatchObject({
      nextAuthorizationState: "CODE_REQUESTED",
      nextStatus: "WAITING_FOR_CODE",
      safeErrorCode: "TELEGRAM_AUTH_NETWORK_TIMEOUT",
      retryable: true
    });
  });

  it("classifies account lease busy without forcing reauthorization", () => {
    const failure = classifyTelegramFailure(new Error("TELEGRAM_ACCOUNT_LEASE_BUSY"), "AUTHORIZED", true);

    expect(failure).toMatchObject({
      nextAuthorizationState: "AUTHORIZED",
      nextStatus: "CONNECTED",
      nextSyncState: "LIVE",
      safeErrorCode: "TELEGRAM_ACCOUNT_LEASE_BUSY",
      retryable: false
    });
  });
});
