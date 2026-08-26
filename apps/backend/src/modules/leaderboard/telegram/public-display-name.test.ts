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
    expect(toPublicLeaderboardDisplayName("Redface")).toBe("Redface");
  });

  it("preserves human-readable CRM names that contain digits", () => {
    expect(toPublicLeaderboardDisplayName("Kapnocap85")).toBe("Kapnocap85");
    expect(toPublicLeaderboardDisplayName("Player2")).toBe("Player2");
    expect(toPublicLeaderboardDisplayName("John23")).toBe("John23");
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

  it("does not leak the production peer id, phone, telegram-user label, @username, or URL", () => {
    expect(toPublicLeaderboardDisplayName("8687540231")).toBe("Player");
    expect(toPublicLeaderboardDisplayName("+1 555 123 4567")).toBe("Player");
    expect(toPublicLeaderboardDisplayName("Telegram user 8687540231")).toBe("Player");
    expect(toPublicLeaderboardDisplayName("@privateusername")).toBe("Player");
    expect(toPublicLeaderboardDisplayName("https://example.com")).toBe("Player");
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

  it("publishes digit-containing CRM names consistently with toPublicLeaderboardDisplayName", () => {
    expect(toPublicLeaderboardDisplayName("Kapnocap85")).toBe("Kapnocap85");
    expect(
      resolvePublicLeaderboardDisplayName({
        displayName: "Kapnocap85",
        firstName: "Other",
        lastName: "Name",
        username: "privateusername"
      })
    ).toBe("Kapnocap85");
    expect(resolvePublicLeaderboardDisplayName({ displayName: "Player2" })).toBe("Player2");
    expect(resolvePublicLeaderboardDisplayName({ displayName: "John23" })).toBe("John23");
    expect(resolvePublicLeaderboardDisplayName({ displayName: "Redface" })).toBe("Redface");
    expect(resolvePublicLeaderboardDisplayName({ displayName: "L. J." })).toBe("L. J.");
    expect(resolvePublicLeaderboardDisplayName({ displayName: "S F" })).toBe("S F");
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

  it("does not leak unsafe identifiers when no safe first/last fallback exists", () => {
    const unsafe = [
      "8687540231",
      "+1 555 123 4567",
      "Telegram user 8687540231",
      "@privateusername",
      "https://example.com"
    ];
    for (const displayName of unsafe) {
      expect(toPublicLeaderboardDisplayName(displayName)).toBe("Player");
      expect(resolvePublicLeaderboardDisplayName({ displayName })).toBe("Player");
    }
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
