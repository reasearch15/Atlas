import { describe, expect, it } from "vitest";
import { VISIBLE_NATIVE_POLL_LIMIT } from "./engagement.constants";
import {
  selectNativePollMessagesToPrune,
  type VisibleNativePollRef
} from "./engagement.poll-visibility";

function ref(
  id: string,
  messageId: string,
  postedAt: string,
  overrides: Partial<VisibleNativePollRef> = {}
): VisibleNativePollRef {
  return {
    id,
    channelId: "-100123",
    telegramMessageId: messageId,
    telegramPollId: `tg-${id}`,
    postedAt: new Date(postedAt),
    ...overrides
  };
}

describe("selectNativePollMessagesToPrune", () => {
  it("deletes nothing while 1–3 native polls are visible", () => {
    expect(selectNativePollMessagesToPrune([])).toEqual([]);
    expect(selectNativePollMessagesToPrune([ref("1", "10", "2026-08-25T10:00:00Z")])).toEqual([]);
    expect(
      selectNativePollMessagesToPrune([
        ref("1", "10", "2026-08-25T06:00:00Z"),
        ref("2", "20", "2026-08-25T10:00:00Z"),
        ref("3", "30", "2026-08-25T14:00:00Z")
      ])
    ).toEqual([]);
  });

  it("deletes the oldest when a 4th native poll would exceed the limit", () => {
    const polls = [
      ref("1", "10", "2026-08-25T06:00:00Z"),
      ref("2", "20", "2026-08-25T10:00:00Z"),
      ref("3", "30", "2026-08-25T14:00:00Z"),
      ref("4", "40", "2026-08-25T18:00:00Z")
    ];
    expect(selectNativePollMessagesToPrune(polls).map((p) => p.id)).toEqual(["1"]);
  });

  it("deletes the next-oldest when a 5th native poll posts", () => {
    const polls = [
      ref("1", "10", "2026-08-25T06:00:00Z"),
      ref("2", "20", "2026-08-25T10:00:00Z"),
      ref("3", "30", "2026-08-25T14:00:00Z"),
      ref("4", "40", "2026-08-25T18:00:00Z"),
      ref("5", "50", "2026-08-25T22:00:00Z")
    ];
    expect(selectNativePollMessagesToPrune(polls).map((p) => p.id)).toEqual(["1", "2"]);
  });

  it("keeps only the newest three tracked message ids", () => {
    const polls = [
      ref("1", "10", "2026-08-25T06:00:00Z"),
      ref("2", "20", "2026-08-25T10:00:00Z"),
      ref("3", "30", "2026-08-25T14:00:00Z"),
      ref("4", "40", "2026-08-25T18:00:00Z"),
      ref("5", "50", "2026-08-25T22:00:00Z"),
      ref("6", "60", "2026-08-26T06:00:00Z")
    ];
    const pruned = new Set(selectNativePollMessagesToPrune(polls).map((p) => p.telegramMessageId));
    const remaining = polls
      .filter((p) => !pruned.has(p.telegramMessageId))
      .map((p) => p.telegramMessageId);
    expect(remaining).toEqual(["40", "50", "60"]);
    expect(VISIBLE_NATIVE_POLL_LIMIT).toBe(3);
  });

  it("never selects rows that lack native poll identity or message ids", () => {
    const polls: VisibleNativePollRef[] = [
      ref("legacy", "99", "2026-08-25T05:00:00Z", { telegramPollId: "" }),
      ref("1", "10", "2026-08-25T06:00:00Z"),
      ref("2", "20", "2026-08-25T10:00:00Z"),
      ref("3", "30", "2026-08-25T14:00:00Z"),
      ref("4", "40", "2026-08-25T18:00:00Z")
    ];
    const pruned = selectNativePollMessagesToPrune(polls);
    expect(pruned.map((p) => p.id)).toEqual(["1"]);
    expect(pruned.every((p) => p.telegramPollId && p.telegramMessageId)).toBe(true);
  });

  it("ignores unrelated channel content by only returning engagement poll refs", () => {
    // Caller never passes leaderboard/draw/manual messages — only engagement_polls rows.
    const polls = [
      ref("1", "10", "2026-08-25T06:00:00Z"),
      ref("2", "20", "2026-08-25T10:00:00Z"),
      ref("3", "30", "2026-08-25T14:00:00Z"),
      ref("4", "40", "2026-08-25T18:00:00Z")
    ];
    expect(selectNativePollMessagesToPrune(polls).every((p) => p.id.startsWith("leaderboard"))).toBe(
      false
    );
    expect(selectNativePollMessagesToPrune(polls).map((p) => p.telegramMessageId)).toEqual(["10"]);
  });
});
