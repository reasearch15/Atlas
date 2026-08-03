import { describe, expect, it } from "vitest";
import { areEquivalentTelegramChatIds, normalizeMarkedTelegramChatId } from "./telegram-peer-id";

describe("normalizeMarkedTelegramChatId", () => {
  it("marks channel and supergroup ids with -100 prefix", () => {
    expect(normalizeMarkedTelegramChatId("1974352571", "CHANNEL")).toBe("-1001974352571");
    expect(normalizeMarkedTelegramChatId("1974352571", "SUPERGROUP")).toBe("-1001974352571");
    expect(normalizeMarkedTelegramChatId("-1001974352571", "CHANNEL")).toBe("-1001974352571");
  });

  it("marks basic groups with a leading minus", () => {
    expect(normalizeMarkedTelegramChatId("5467746352", "GROUP")).toBe("-5467746352");
    expect(normalizeMarkedTelegramChatId("-5467746352", "GROUP")).toBe("-5467746352");
  });

  it("keeps private user ids positive", () => {
    expect(normalizeMarkedTelegramChatId("8021407920", "PRIVATE")).toBe("8021407920");
  });

  it("treats unmarked and marked forms as equivalent", () => {
    expect(areEquivalentTelegramChatIds("1940447210", "-1001940447210", "CHANNEL")).toBe(true);
    expect(areEquivalentTelegramChatIds("5350880041", "-5350880041", "GROUP")).toBe(true);
    expect(areEquivalentTelegramChatIds("1", "2", "PRIVATE")).toBe(false);
  });
});
