import { describe, expect, it } from "vitest";
import { decidePlayerNotification } from "./player-notification-policy";

describe("decidePlayerNotification", () => {
  it("requires a player link and matching bot owner", () => {
    expect(
      decidePlayerNotification({
        competitionId: "c1",
        crmContactId: "p1",
        kind: "ENTER_TOP_10",
        hasPlayerLink: false,
        ownerCoadminUserId: "a",
        botOwnerCoadminUserId: "a"
      }).shouldNotify
    ).toBe(false);

    expect(
      decidePlayerNotification({
        competitionId: "c1",
        crmContactId: "p1",
        kind: "ENTER_TOP_10",
        hasPlayerLink: true,
        ownerCoadminUserId: "a",
        botOwnerCoadminUserId: "b"
      }).shouldNotify
    ).toBe(false);

    expect(
      decidePlayerNotification({
        competitionId: "c1",
        crmContactId: "p1",
        kind: "ENTER_TOP_3",
        hasPlayerLink: true,
        ownerCoadminUserId: "a",
        botOwnerCoadminUserId: "a"
      }).shouldNotify
    ).toBe(true);
  });

  it("dedupes by competition+player+kind", () => {
    const a = decidePlayerNotification({
      competitionId: "c1",
      crmContactId: "p1",
      kind: "REACHED_NUMBER_1",
      hasPlayerLink: true,
      ownerCoadminUserId: "a",
      botOwnerCoadminUserId: "a"
    });
    const b = decidePlayerNotification({
      competitionId: "c1",
      crmContactId: "p1",
      kind: "REACHED_NUMBER_1",
      hasPlayerLink: true,
      ownerCoadminUserId: "a",
      botOwnerCoadminUserId: "a"
    });
    expect(a.dedupeKey).toBe(b.dedupeKey);
  });
});
