import { describe, expect, it } from "vitest";
import {
  buildVoteCallbackData,
  formatClosedPollMessage,
  formatDailyWinnersMessage,
  formatOpenPollMessage,
  parseVoteCallbackData
} from "./engagement.messages";

describe("engagement messages", () => {
  it("round-trips callback data under Telegram's 64-byte limit", () => {
    const pollId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const data = buildVoteCallbackData(pollId, 3);
    expect(data.length).toBeLessThan(64);
    expect(parseVoteCallbackData(data)).toEqual({ pollId, optionIndex: 3 });
    expect(parseVoteCallbackData("leaderboard:wheel:spin")).toBeNull();
  });

  it("formats open and closed poll copy without live ranking", () => {
    expect(formatOpenPollMessage("Which would you rather have?")).toContain("WHICH WOULD YOU CHOOSE?");
    const closed = formatClosedPollMessage({
      question: "Which would you rather have?",
      options: ["Dream house", "Travel anywhere", "$1 million cash", "Dream car"],
      counts: [41, 26, 22, 11],
      percentages: [41, 26, 22, 11],
      winningOptionIndex: 0
    });
    expect(closed).toContain("POLL CLOSED");
    expect(closed).toContain("Dream house — 41%");
    expect(closed).toContain("Winning choice: Dream house");
    expect(closed).not.toContain("rank");
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
