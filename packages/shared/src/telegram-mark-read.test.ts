import { describe, expect, it } from "vitest";
import { isRemoteTelegramMessageId, resolveMarkReadMaxTelegramMessageId } from "./telegram-mark-read";

describe("telegram mark-read boundary", () => {
  it("rejects pending and upload placeholders as remote ids", () => {
    expect(isRemoteTelegramMessageId("pending:send:5476500286:uuid")).toBe(false);
    expect(isRemoteTelegramMessageId("upload:abc")).toBe(false);
    expect(isRemoteTelegramMessageId("981")).toBe(true);
    expect(isRemoteTelegramMessageId("-5")).toBe(true);
  });

  it("never selects pending:send as mark-read max id", () => {
    const maxId = resolveMarkReadMaxTelegramMessageId([
      {
        telegramMessageId: "pending:send:5476500286:uuid",
        direction: "OUTBOUND",
        sendStatus: "QUEUED"
      },
      {
        telegramMessageId: "575",
        direction: "OUTBOUND",
        sendStatus: "DELIVERED"
      },
      {
        telegramMessageId: "574",
        direction: "INBOUND",
        sendStatus: "RECEIVED"
      }
    ]);
    expect(maxId).toBe("574");
  });

  it("falls back to latest remote outbound when no inbound exists", () => {
    const maxId = resolveMarkReadMaxTelegramMessageId([
      { telegramMessageId: "pending:send:x", direction: "OUTBOUND", sendStatus: "SENDING" },
      { telegramMessageId: "900", direction: "OUTBOUND", sendStatus: "SENT" }
    ]);
    expect(maxId).toBe("900");
  });

  it("returns null when only placeholders exist so Telegram read can be skipped", () => {
    expect(
      resolveMarkReadMaxTelegramMessageId([
        { telegramMessageId: "pending:send:a", direction: "OUTBOUND", sendStatus: "QUEUED" },
        { telegramMessageId: "upload:b", direction: "OUTBOUND", sendStatus: "UPLOADING" }
      ])
    ).toBeNull();
  });

  it("skips soft-deleted tombstones", () => {
    expect(
      resolveMarkReadMaxTelegramMessageId([
        { telegramMessageId: "100", direction: "INBOUND", deletedAt: new Date() },
        { telegramMessageId: "99", direction: "INBOUND", deletedAt: null }
      ])
    ).toBe("99");
  });
});
