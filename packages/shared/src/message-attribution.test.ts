import { describe, expect, it } from "vitest";
import {
  classifyMessageOrigin,
  formatOutboundAttribution,
  isAtlasPendingTelegramMessageId,
  resolveAttributionSource,
  summarizeOutboundSendDiagnostics
} from "./message-attribution";

describe("message attribution", () => {
  it("attributes Atlas Staff sends by name", () => {
    expect(
      formatOutboundAttribution({
        direction: "OUTBOUND",
        internalSenderUserId: "staff-1",
        internalSenderName: "Sarah",
        attributionSource: "ATLAS"
      })
    ).toBe("Sent by Sarah");
  });

  it("shows You for the viewing sender", () => {
    expect(
      formatOutboundAttribution({
        direction: "OUTBOUND",
        internalSenderUserId: "staff-1",
        internalSenderName: "Sarah",
        viewerUserId: "staff-1"
      })
    ).toBe("You");
  });

  it("labels external Telegram activity without false Staff attribution", () => {
    expect(
      formatOutboundAttribution({
        direction: "OUTBOUND",
        internalSenderUserId: null,
        attributionSource: "TELEGRAM_EXTERNAL"
      })
    ).toBe("Sent from Telegram");
    expect(resolveAttributionSource(null)).toBe("TELEGRAM_EXTERNAL");
    expect(resolveAttributionSource("u1")).toBe("ATLAS");
  });

  it("does not attribute inbound messages", () => {
    expect(
      formatOutboundAttribution({
        direction: "INBOUND",
        internalSenderUserId: "staff-1",
        internalSenderName: "Sarah"
      })
    ).toBeNull();
  });
});

describe("message origin classification", () => {
  it("classifies Atlas pending sends separately from native Telegram outbound ids", () => {
    expect(isAtlasPendingTelegramMessageId("pending:send:5476500286:uuid")).toBe(true);
    expect(isAtlasPendingTelegramMessageId("572")).toBe(false);

    expect(
      classifyMessageOrigin({
        direction: "OUTBOUND",
        internalSenderUserId: "staff-1",
        telegramMessageId: "pending:send:5476500286:uuid"
      })
    ).toBe("OUTBOUND_ATLAS");

    expect(
      classifyMessageOrigin({
        direction: "OUTBOUND",
        internalSenderUserId: null,
        attributionSource: "TELEGRAM_EXTERNAL",
        telegramMessageId: "572"
      })
    ).toBe("OUTBOUND_TELEGRAM_SYNCED");

    expect(
      classifyMessageOrigin({
        direction: "INBOUND",
        telegramMessageId: "100"
      })
    ).toBe("INBOUND_TELEGRAM");
  });

  it("does not count native Telegram outbound sync as Atlas send success", () => {
    const summary = summarizeOutboundSendDiagnostics([
      {
        direction: "OUTBOUND",
        internalSenderUserId: null,
        telegramMessageId: "572",
        sendStatus: "DELIVERED"
      },
      {
        direction: "OUTBOUND",
        internalSenderUserId: null,
        telegramMessageId: "573",
        sendStatus: "DELIVERED"
      },
      {
        direction: "OUTBOUND",
        internalSenderUserId: "staff-1",
        telegramMessageId: "pending:send:5476500286:a",
        sendStatus: "FAILED_PERMANENT"
      },
      {
        direction: "OUTBOUND",
        internalSenderUserId: "staff-1",
        telegramMessageId: "900",
        sendStatus: "DELIVERED"
      },
      {
        direction: "INBOUND",
        telegramMessageId: "901",
        sendStatus: "RECEIVED"
      }
    ]);

    expect(summary).toEqual({
      atlasSendAttempts: 2,
      atlasSendsDelivered: 1,
      atlasSendsFailed: 1,
      telegramAppOutboundSynced: 2
    });
  });
});
