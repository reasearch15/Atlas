import { describe, expect, it } from "vitest";
import { buildCallerDisplayName, parseIncomingPhoneCallRequested } from "./phone-call";

describe("parseIncomingPhoneCallRequested", () => {
  it("parses UpdatePhoneCall + PhoneCallRequested safely", () => {
    const parsed = parseIncomingPhoneCallRequested({
      className: "UpdatePhoneCall",
      phoneCall: {
        className: "PhoneCallRequested",
        id: "9876543210",
        adminId: "111",
        participantId: "222",
        video: true,
        date: 1_700_000_000,
        accessHash: "SECRET_HASH",
        gAHash: Buffer.from("secret-dh")
      }
    });
    expect(parsed).toEqual({
      callId: "9876543210",
      callerTelegramUserId: "111",
      participantTelegramUserId: "222",
      video: true,
      dateUnix: 1_700_000_000
    });
  });

  it("ignores signaling updates and non-requested call states", () => {
    expect(
      parseIncomingPhoneCallRequested({
        className: "UpdatePhoneCallSignalingData",
        phoneCallId: "1",
        data: Buffer.from("opaque")
      })
    ).toBeNull();

    expect(
      parseIncomingPhoneCallRequested({
        className: "UpdatePhoneCall",
        phoneCall: { className: "PhoneCallDiscarded", id: "1", reason: { className: "PhoneCallDiscardReasonMissed" } }
      })
    ).toBeNull();

    expect(
      parseIncomingPhoneCallRequested({
        className: "UpdateDeleteMessages",
        messages: [1, 2]
      })
    ).toBeNull();
  });
});

describe("buildCallerDisplayName", () => {
  it("prefers first+last over title", () => {
    expect(buildCallerDisplayName({ firstName: "John", lastName: "Smith", title: "Fallback" })).toBe("John Smith");
    expect(buildCallerDisplayName({ firstName: null, lastName: null, title: "Ada" })).toBe("Ada");
    expect(buildCallerDisplayName({})).toBeNull();
  });
});
