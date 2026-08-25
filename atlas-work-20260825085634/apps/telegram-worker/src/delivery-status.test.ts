import { describe, expect, it } from "vitest";
import { isRemoteTelegramMessageId } from "./delivery-status";

describe("delivery status helpers", () => {
  it("accepts real Telegram numeric message ids", () => {
    expect(isRemoteTelegramMessageId("42")).toBe(true);
    expect(isRemoteTelegramMessageId("1001")).toBe(true);
  });

  it("rejects pending placeholders and empty ids", () => {
    expect(isRemoteTelegramMessageId("pending:abc")).toBe(false);
    expect(isRemoteTelegramMessageId("upload:abc")).toBe(false);
    expect(isRemoteTelegramMessageId("")).toBe(false);
    expect(isRemoteTelegramMessageId(null)).toBe(false);
    expect(isRemoteTelegramMessageId(undefined)).toBe(false);
  });
});
