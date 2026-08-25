import { describe, expect, it } from "vitest";
import {
  CLOSED_POLL_HEADING,
  CLOSED_POLL_NO_VOTES,
  OPEN_POLL_HEADING,
  OPEN_POLL_VOTE_HINT,
  buildPollInlineKeyboard,
  buildVoteCallbackData,
  formatClosedPollMessage,
  formatDailyWinnersMessage,
  formatOpenPollMessage,
  parseVoteCallbackData
} from "./engagement.messages";
import { votePercentages, winningOptionIndex } from "./engagement.scoring";

const question = "Which sounds most valuable to you?";
const options = ["Buy experiences", "Take a year off", "Fly first class", "Have a home gym"] as const;

describe("engagement messages", () => {
  it("round-trips callback data under Telegram's 64-byte limit", () => {
    const pollId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const data = buildVoteCallbackData(pollId, 3);
    expect(data.length).toBeLessThan(64);
    expect(parseVoteCallbackData(data)).toEqual({ pollId, optionIndex: 3 });
    expect(parseVoteCallbackData("leaderboard:wheel:spin")).toBeNull();
  });

  it("formats an open poll with the question, timed-vote hint, and four buttons", () => {
    const pollId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const text = formatOpenPollMessage(question);
    expect(text).toContain(OPEN_POLL_HEADING);
    expect(text).toContain(question);
    expect(text).toContain(OPEN_POLL_VOTE_HINT);
    expect(text).not.toMatch(/\d+%/);
    expect(text).not.toContain(CLOSED_POLL_HEADING);
    const keyboard = buildPollInlineKeyboard(pollId, options);
    expect(keyboard.inline_keyboard).toHaveLength(4);
    expect(keyboard.inline_keyboard.map((row) => row[0]?.text)).toEqual([...options]);
  });

  it("formats closed results from stored vote counts with a marked winner", () => {
    const closed = formatClosedPollMessage({
      question,
      options,
      counts: [42, 27, 19, 12]
    });
    expect(closed).toContain(CLOSED_POLL_HEADING);
    expect(closed).toContain(question);
    expect(closed).toContain("🥇 Buy experiences — 42%");
    expect(closed).toContain("Take a year off — 27%");
    expect(closed).toContain("Fly first class — 19%");
    expect(closed).toContain("Have a home gym — 12%");
    expect(closed).toContain("🏆 Winning choice: Buy experiences");
    expect(closed).not.toContain(OPEN_POLL_VOTE_HINT);
    expect(closed).not.toContain("POLL CLOSED");
  });

  it("identifies the winner from raw vote counts, not rounded percentages", () => {
    const counts = [3, 2, 2, 2];
    expect(winningOptionIndex(counts)).toBe(0);
    const closed = formatClosedPollMessage({ question, options, counts });
    expect(closed).toContain("🥇 Buy experiences — 34%");
    expect(closed).toContain("Take a year off — 22%");
    expect(closed).toContain("🏆 Winning choice: Buy experiences");
    expect(closed).not.toContain("🥇 Take a year off");
  });

  it("handles a zero-vote close without inventing a winner or percentages", () => {
    const closed = formatClosedPollMessage({
      question,
      options,
      counts: [0, 0, 0, 0]
    });
    expect(closed).toBe(
      [CLOSED_POLL_HEADING, "", question, "", CLOSED_POLL_NO_VOTES].join("\n")
    );
    expect(closed).not.toMatch(/\d+%/);
    expect(closed).not.toContain("Winning choice");
    expect(closed).not.toContain("🥇");
  });

  it("announces only names and Freeplay amounts", () => {
    const text = formatDailyWinnersMessage({
      firstName: "Emily",
      secondName: "John",
      thirdName: "Sarah"
    });
    expect(text).toContain("🥇 Emily — $5 Freeplay");
    expect(text).not.toContain("points");
  });
});

describe("engagement closed-poll percentages", () => {
  it("uses largest-remainder rounding so displayed percentages sum to 100", () => {
    expect(votePercentages([1, 1, 1, 0])).toEqual([34, 33, 33, 0]);
    expect(votePercentages([1, 1, 1, 0]).reduce((sum, n) => sum + n, 0)).toBe(100);
    expect(votePercentages([2, 2, 1, 0])).toEqual([40, 40, 20, 0]);
    expect(votePercentages([1, 1, 1, 1])).toEqual([25, 25, 25, 25]);
    expect(votePercentages([0, 0, 0, 0])).toEqual([0, 0, 0, 0]);
  });

  it("is deterministic for the same vote counts", () => {
    const counts = [5, 3, 2, 1];
    expect(votePercentages(counts)).toEqual(votePercentages(counts));
    expect(votePercentages([1, 1, 1, 0])).toEqual([34, 33, 33, 0]);
  });
});
