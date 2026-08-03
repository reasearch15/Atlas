import { describe, expect, it } from "vitest";
import {
  buildCrmContactDisplayTitle,
  contactDisplayTitleQuality,
  isOfficialTelegramServicePeer,
  isTemporaryTelegramUserTitle,
  isUsableHumanDisplayTitle,
  shouldIgnoreTelegramDialog
} from "./telegram-crm-identity";

describe("shouldIgnoreTelegramDialog", () => {
  it("ignores official Telegram service accounts by peer id", () => {
    expect(
      shouldIgnoreTelegramDialog({
        telegramChatId: "777000",
        chatType: "PRIVATE",
        title: "Telegram",
        firstName: "Telegram"
      })
    ).toBe(true);
    expect(isOfficialTelegramServicePeer("777000")).toBe(true);
    expect(
      shouldIgnoreTelegramDialog({
        telegramChatId: "42777",
        chatType: "PRIVATE",
        title: "Telegram"
      })
    ).toBe(true);
  });

  it("ignores Saved Messages (self peer)", () => {
    expect(
      shouldIgnoreTelegramDialog({
        telegramChatId: "12345",
        chatType: "PRIVATE",
        title: "Saved Messages",
        isSelf: true
      })
    ).toBe(true);
    expect(
      shouldIgnoreTelegramDialog({
        telegramChatId: "12345",
        chatType: "PRIVATE",
        selfTelegramUserId: "12345"
      })
    ).toBe(true);
  });

  it("ignores archived and support dialogs", () => {
    expect(shouldIgnoreTelegramDialog({ telegramChatId: "99", isArchived: true })).toBe(true);
    expect(shouldIgnoreTelegramDialog({ telegramChatId: "99", isSupport: true })).toBe(true);
  });

  it("ignores service notification labels without known ids", () => {
    for (const title of [
      "Login code",
      "Security alerts",
      "Two-step verification",
      "Verification messages",
      "Telegram Notifications"
    ]) {
      expect(
        shouldIgnoreTelegramDialog({
          telegramChatId: "999001",
          chatType: "PRIVATE",
          title
        })
      ).toBe(true);
    }
  });

  it("allows normal private contacts", () => {
    expect(
      shouldIgnoreTelegramDialog({
        telegramChatId: "7818896100",
        chatType: "PRIVATE",
        title: "Alice Smith",
        firstName: "Alice",
        lastName: "Smith",
        username: "alice"
      })
    ).toBe(false);
  });
});

describe("buildCrmContactDisplayTitle", () => {
  it("uses first + last name when both are present", () => {
    expect(
      buildCrmContactDisplayTitle({
        chatType: "PRIVATE",
        firstName: "Ada",
        lastName: "Lovelace",
        username: "ada",
        phone: "+15551212",
        telegramChatId: "42"
      })
    ).toBe("Ada Lovelace");
  });

  it("uses username-only contact when names are missing", () => {
    expect(
      buildCrmContactDisplayTitle({
        chatType: "PRIVATE",
        username: "joemas020",
        telegramChatId: "42"
      })
    ).toBe("joemas020");
  });

  it("uses phone-only contact when names and username are missing", () => {
    expect(
      buildCrmContactDisplayTitle({
        chatType: "PRIVATE",
        phone: "+15551234567",
        telegramChatId: "42"
      })
    ).toBe("+15551234567");
  });

  it("falls back to Telegram user <peerId>, never a naked numeric id", () => {
    expect(
      buildCrmContactDisplayTitle({
        chatType: "PRIVATE",
        telegramChatId: "7818896100"
      })
    ).toBe("Telegram user 7818896100");
  });

  it("never returns Unknown User when peer id is known", () => {
    expect(
      buildCrmContactDisplayTitle({
        chatType: "PRIVATE",
        telegramChatId: "8291583373"
      })
    ).toBe("Telegram user 8291583373");
  });

  it("returns Unknown User only when every field including peer id is missing", () => {
    expect(buildCrmContactDisplayTitle({ chatType: "PRIVATE" })).toBe("Unknown User");
  });
});

describe("entity resolution title upgrade", () => {
  it("upgrades temporary Telegram user title after entity fields become available", () => {
    const before = buildCrmContactDisplayTitle({
      chatType: "PRIVATE",
      telegramChatId: "555"
    });
    expect(before).toBe("Telegram user 555");
    expect(contactDisplayTitleQuality("Unknown User")).toBe(0);
    expect(contactDisplayTitleQuality(before, "555")).toBe(1);

    const after = buildCrmContactDisplayTitle({
      chatType: "PRIVATE",
      firstName: "Joemas020",
      lastName: "Joemas060",
      telegramChatId: "555"
    });
    expect(after).toBe("Joemas020 Joemas060");
    expect(contactDisplayTitleQuality(after)).toBeGreaterThan(contactDisplayTitleQuality(before, "555"));
    expect(isUsableHumanDisplayTitle(after, "555")).toBe(true);
    expect(isUsableHumanDisplayTitle(before, "555")).toBe(false);
    expect(isUsableHumanDisplayTitle("Unknown User", "555")).toBe(false);
  });
});
