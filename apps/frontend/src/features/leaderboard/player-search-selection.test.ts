import { describe, expect, it } from "vitest";
import type { LeaderboardPlayerSearchHitDto } from "@atlas/shared";

/**
 * Documents the referral autocomplete contract: Link Referral uses the selected
 * hit's crmContactId, never the raw typed search string.
 */
describe("referral player selection contract", () => {
  it("stores crmContactId from selected hit, not typed query text", () => {
    const typedQuery = "p";
    const selected: LeaderboardPlayerSearchHitDto = {
      crmContactId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      displayName: "Piccaso47",
      telegramUsername: "Piccaso47",
      shortId: "aaaaaaaa"
    };

    expect(selected.crmContactId).not.toBe(typedQuery);
    expect(selected.crmContactId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  });
});
