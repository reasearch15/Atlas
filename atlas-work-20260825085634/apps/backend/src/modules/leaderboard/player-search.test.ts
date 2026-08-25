import { describe, expect, it } from "vitest";
import {
  normalizePlayerSearchQuery,
  playerMatchesSearchQuery,
  scorePlayerSearchMatch,
  selectPlayerSearchHits,
  type PlayerSearchFieldSource
} from "./player-search";

function row(
  partial: Partial<PlayerSearchFieldSource> & Pick<PlayerSearchFieldSource, "crmContactId" | "displayName">
): PlayerSearchFieldSource {
  return {
    username: null,
    chatFirstNames: [],
    chatLastNames: [],
    chatUsernames: [],
    ...partial
  };
}

describe("normalizePlayerSearchQuery", () => {
  it("strips @ and whitespace", () => {
    expect(normalizePlayerSearchQuery("  @Piccaso47  ")).toBe("Piccaso47");
    expect(normalizePlayerSearchQuery("Piccaso47")).toBe("Piccaso47");
  });
});

describe("player search matching", () => {
  const piccaso = row({
    crmContactId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    displayName: "Piccaso47",
    username: "Piccaso47"
  });
  const peter = row({
    crmContactId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
    displayName: "Peter",
    chatFirstNames: ["Peter"]
  });
  const amanda = row({
    crmContactId: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
    displayName: "Amanda P",
    chatFirstNames: ["Amanda"],
    chatLastNames: ["P"]
  });
  const playerKing = row({
    crmContactId: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
    displayName: "PlayerKing",
    username: "PlayerKing"
  });
  const channelLike = row({
    crmContactId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1",
    displayName: "News Channel"
  });

  const all = [piccaso, peter, amanda, playerKing, channelLike];

  it("matches 1-character contains queries case-insensitively", () => {
    const lower = selectPlayerSearchHits(all, "p", 50).map((h) => h.displayName);
    const upper = selectPlayerSearchHits(all, "P", 50).map((h) => h.displayName);
    expect(lower).toEqual(expect.arrayContaining(["Piccaso47", "Peter", "Amanda P", "PlayerKing"]));
    expect(upper).toEqual(lower);
  });

  it("matches username substrings and @-prefixed queries the same", () => {
    expect(playerMatchesSearchQuery(piccaso, "cas")).toBe(true);
    expect(playerMatchesSearchQuery(piccaso, "47")).toBe(true);
    expect(playerMatchesSearchQuery(piccaso, "pic")).toBe(true);

    const withAt = selectPlayerSearchHits(all, "@Piccaso47", 10);
    const without = selectPlayerSearchHits(all, "Piccaso47", 10);
    expect(withAt.map((h) => h.crmContactId)).toEqual(without.map((h) => h.crmContactId));
    expect(withAt[0]?.crmContactId).toBe(piccaso.crmContactId);
  });

  it("ranks exact before startsWith before contains", () => {
    expect(scorePlayerSearchMatch(piccaso, "Piccaso47")).toBe(0);
    expect(scorePlayerSearchMatch(piccaso, "Pic")).toBe(1);
    expect(scorePlayerSearchMatch(piccaso, "cas")).toBe(2);
  });

  it("matches combined first + last name", () => {
    const full = row({
      crmContactId: "ffffffff-ffff-4fff-8fff-fffffffffff1",
      displayName: "Other",
      chatFirstNames: ["Peter"],
      chatLastNames: ["Smith"]
    });
    expect(playerMatchesSearchQuery(full, "peter sm")).toBe(true);
    expect(playerMatchesSearchQuery(full, "Smith")).toBe(true);
  });

  it("empty query browses alphabetically without requiring a needle", () => {
    const hits = selectPlayerSearchHits(all, "", 3);
    expect(hits).toHaveLength(3);
    expect(hits.map((h) => h.displayName)).toEqual(["Amanda P", "News Channel", "Peter"]);
  });
});
