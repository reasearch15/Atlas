import { describe, expect, it } from "vitest";
import {
  PUBLIC_LEADERBOARD_USERNAME_FALLBACK_ALLOWED,
  resolvePublicLeaderboardDisplayName,
  toPublicLeaderboardDisplayName
} from "./public-display-name";

describe("toPublicLeaderboardDisplayName", () => {
  it("preserves safe full names and initials", () => {
    expect(toPublicLeaderboardDisplayName("L. J.")).toBe("L. J.");
    expect(toPublicLeaderboardDisplayName("S F")).toBe("S F");
    expect(toPublicLeaderboardDisplayName("Amanda")).toBe("Amanda");
    expect(toPublicLeaderboardDisplayName("O'Neil")).toBe("O'Neil");
    expect(toPublicLeaderboardDisplayName("Mary-Jane")).toBe("Mary-Jane");
    expect(toPublicLeaderboardDisplayName("Sarah Connor")).toBe("Sarah Connor");
    expect(toPublicLeaderboardDisplayName("John")).toBe("John");
  });

  it("collapses whitespace", () => {
    expect(toPublicLeaderboardDisplayName("  L.   J.  ")).toBe("L. J.");
  });

  it("rejects usernames, phones, peer ids, and Telegram user labels", () => {
    expect(toPublicLeaderboardDisplayName("@sarah")).toBe("Player");
    expect(toPublicLeaderboardDisplayName("sarah@mail.com")).toBe("Player");
    expect(toPublicLeaderboardDisplayName("+1 (555) 123-4567")).toBe("Player");
    expect(toPublicLeaderboardDisplayName("+1 555 123 4567")).toBe("Player");
    expect(toPublicLeaderboardDisplayName("15551234567")).toBe("Player");
    expect(toPublicLeaderboardDisplayName("8201130943")).toBe("Player");
    expect(toPublicLeaderboardDisplayName("123456789")).toBe("Player");
    expect(toPublicLeaderboardDisplayName("-1001234567890")).toBe("Player");
    expect(toPublicLeaderboardDisplayName("Telegram user 42")).toBe("Player");
    expect(toPublicLeaderboardDisplayName("Telegram user -99")).toBe("Player");
    expect(toPublicLeaderboardDisplayName("580.1a")).toBe("Player");
  });

  it("falls back to Player for empty or unsafe values", () => {
    expect(toPublicLeaderboardDisplayName(null)).toBe("Player");
    expect(toPublicLeaderboardDisplayName(undefined)).toBe("Player");
    expect(toPublicLeaderboardDisplayName("")).toBe("Player");
    expect(toPublicLeaderboardDisplayName("   ")).toBe("Player");
    expect(toPublicLeaderboardDisplayName("A")).toBe("Player");
    expect(toPublicLeaderboardDisplayName("Unknown User")).toBe("Player");
  });
});

describe("resolvePublicLeaderboardDisplayName", () => {
  it("prefers CRM display name when safe", () => {
    expect(
      resolvePublicLeaderboardDisplayName({
        displayName: "L. J.",
        firstName: "Other",
        lastName: "Name"
      })
    ).toBe("L. J.");
  });

  it("falls back to first + last when display name is unusable", () => {
    expect(
      resolvePublicLeaderboardDisplayName({
        displayName: "8201130943",
        firstName: "S",
        lastName: "F"
      })
    ).toBe("S F");
  });

  it("does not use username while public username fallback is blocked", () => {
    expect(PUBLIC_LEADERBOARD_USERNAME_FALLBACK_ALLOWED).toBe(false);
    expect(
      resolvePublicLeaderboardDisplayName({
        displayName: "580.1a",
        firstName: "580.1a",
        lastName: null,
        username: "Zombiez4"
      })
    ).toBe("Player");
    expect(
      resolvePublicLeaderboardDisplayName({
        displayName: "A.",
        firstName: "A.",
        username: "AdyXen"
      })
    ).toBe("A.");
  });
});
