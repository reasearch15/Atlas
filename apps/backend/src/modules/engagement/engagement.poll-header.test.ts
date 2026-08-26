import { describe, expect, it } from "vitest";
import {
  POLL_HEADER_THEMES,
  formatPollHeaderMessage,
  pollHeaderRepeatsQuestion,
  selectPollHeaderTheme
} from "./engagement.poll-header";

describe("engagement poll header themes", () => {
  it("ships 8–12 compact reusable themes", () => {
    expect(POLL_HEADER_THEMES.length).toBeGreaterThanOrEqual(8);
    expect(POLL_HEADER_THEMES.length).toBeLessThanOrEqual(12);
    expect(new Set(POLL_HEADER_THEMES.map((theme) => theme.id)).size).toBe(POLL_HEADER_THEMES.length);
    for (const theme of POLL_HEADER_THEMES) {
      const text = formatPollHeaderMessage(theme);
      expect(text.length).toBeGreaterThan(10);
      expect(text.length).toBeLessThan(180);
      expect(text.split("\n").length).toBeLessThanOrEqual(3);
      expect(text).toMatch(/👇/);
      expect(pollHeaderRepeatsQuestion(text, "🏆🔥 Which would you choose for a challenge?")).toBe(false);
      expect(text.toLowerCase()).not.toContain("which would you choose");
    }
  });

  it("rotates away from recently used themes", () => {
    const first = selectPollHeaderTheme("poll-a");
    const second = selectPollHeaderTheme("poll-b", [first.id]);
    const third = selectPollHeaderTheme("poll-c", [first.id, second.id]);
    expect(second.id).not.toBe(first.id);
    expect(third.id).not.toBe(second.id);
    expect(third.id).not.toBe(first.id);
  });

  it("is deterministic for the same seed and recents", () => {
    const recents = ["jackpot", "lucky"];
    expect(selectPollHeaderTheme("slot-2026-08-25T10:00", recents)).toEqual(
      selectPollHeaderTheme("slot-2026-08-25T10:00", recents)
    );
  });

  it("still returns a theme when every id was used recently", () => {
    const all = POLL_HEADER_THEMES.map((theme) => theme.id);
    const picked = selectPollHeaderTheme("wrap", all);
    expect(POLL_HEADER_THEMES.some((theme) => theme.id === picked.id)).toBe(true);
    expect(picked.id).not.toBe(all[all.length - 1]);
  });
});
