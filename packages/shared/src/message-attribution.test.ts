import { describe, expect, it } from "vitest";
import { formatOutboundAttribution, resolveAttributionSource } from "./message-attribution";

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
