import { describe, expect, it } from "vitest";
import { mapTelegramChatMemberStatus } from "./membership-status";

describe("mapTelegramChatMemberStatus", () => {
  it.each(["creator", "administrator", "member", "restricted", "CREATOR", " Member "])(
    "maps %s → ELIGIBLE",
    (status) => {
      expect(mapTelegramChatMemberStatus(status)).toEqual({
        membershipStatus: "ELIGIBLE",
        ineligibilityReason: null
      });
    }
  );

  it.each(["left", "kicked", "KICKED"])("maps %s → NOT_ELIGIBLE / NOT_SUBSCRIBED", (status) => {
    expect(mapTelegramChatMemberStatus(status)).toEqual({
      membershipStatus: "NOT_ELIGIBLE",
      ineligibilityReason: "NOT_SUBSCRIBED"
    });
  });

  it.each([null, undefined, "", "unknown", "banned", "subscriber"])(
    "maps ambiguous %s → PENDING_REVIEW",
    (status) => {
      expect(mapTelegramChatMemberStatus(status)).toEqual({
        membershipStatus: "PENDING_REVIEW",
        ineligibilityReason: null
      });
    }
  );
});
