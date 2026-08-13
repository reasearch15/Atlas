import { describe, expect, it } from "vitest";
import { toPublicLeaderboardDisplayName } from "./public-display-name";

describe("toPublicLeaderboardDisplayName", () => {
  it("returns first-name token from a normal display name", () => {
    expect(toPublicLeaderboardDisplayName("Sarah Connor")).toBe("Sarah");
    expect(toPublicLeaderboardDisplayName("John")).toBe("John");
  });

  it("rejects usernames, phones, peer ids, and Telegram user labels", () => {
    expect(toPublicLeaderboardDisplayName("@sarah")).toBe("Player");
    expect(toPublicLeaderboardDisplayName("sarah@mail.com")).toBe("Player");
    expect(toPublicLeaderboardDisplayName("+1 (555) 123-4567")).toBe("Player");
    expect(toPublicLeaderboardDisplayName("15551234567")).toBe("Player");
    expect(toPublicLeaderboardDisplayName("123456789")).toBe("Player");
    expect(toPublicLeaderboardDisplayName("-1001234567890")).toBe("Player");
    expect(toPublicLeaderboardDisplayName("Telegram user 42")).toBe("Player");
    expect(toPublicLeaderboardDisplayName("Telegram user -99")).toBe("Player");
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
