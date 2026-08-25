import { describe, expect, it } from "vitest";
import {
  buildCrmContactDisplayTitle,
  contactDisplayTitleQuality,
  isOfficialTelegramServicePeer,
  isPlaceholderCrmDisplayName,
  isTemporaryTelegramUserTitle,
  isUsableHumanDisplayTitle,
  planLinkedCrmContactIdentityRepair,
  shouldIgnoreTelegramDialog,
  telegramChatHasRepairableIdentity
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

describe("planLinkedCrmContactIdentityRepair", () => {
  const workspaceA = "workspace-a";
  const workspaceB = "workspace-b";

  function contact(partial: { displayName?: string | null; username?: string | null; workspaceId?: string }) {
    return {
      workspaceId: partial.workspaceId ?? workspaceA,
      displayName: partial.displayName ?? "Unknown",
      username: partial.username ?? null
    };
  }

  function privateChat(
    partial: Partial<{
      telegramChatId: string;
      firstName: string | null;
      lastName: string | null;
      username: string | null;
      title: string | null;
      chatType: string;
      isBot: boolean;
      workspaceId: string;
    }> = {}
  ) {
    return {
      workspaceId: partial.workspaceId ?? workspaceA,
      telegramChatId: partial.telegramChatId ?? "8771801870",
      chatType: partial.chatType ?? "PRIVATE",
      firstName: partial.firstName ?? null,
      lastName: partial.lastName ?? null,
      username: partial.username ?? null,
      title: partial.title ?? null,
      isBot: partial.isBot ?? false
    };
  }

  it("upgrades Unknown to first + last name (Joe Mashburn)", () => {
    expect(
      planLinkedCrmContactIdentityRepair({
        contact: contact({ displayName: "Unknown" }),
        chat: privateChat({
          firstName: "Joe",
          lastName: "Mashburn",
          username: "waylon_rivers85",
          title: "Joe Mashburn"
        })
      })
    ).toEqual({ displayName: "Joe Mashburn", username: "waylon_rivers85" });
  });

  it("fills a blank CRM username from Telegram", () => {
    expect(
      planLinkedCrmContactIdentityRepair({
        contact: contact({ displayName: "Joe Mashburn", username: "  " }),
        chat: privateChat({
          firstName: "Joe",
          lastName: "Mashburn",
          username: "waylon_rivers85"
        })
      })
    ).toEqual({ username: "waylon_rivers85" });
  });

  it("heals after delayed Telegram identity arrival", () => {
    const chatId = "555001";
    const first = planLinkedCrmContactIdentityRepair({
      contact: contact({ displayName: "Unknown" }),
      chat: privateChat({ telegramChatId: chatId })
    });
    expect(first).toBeNull();
    expect(telegramChatHasRepairableIdentity(privateChat({ telegramChatId: chatId }))).toBe(false);

    const later = planLinkedCrmContactIdentityRepair({
      contact: contact({ displayName: "Unknown User" }),
      chat: privateChat({
        telegramChatId: chatId,
        firstName: "Joe",
        lastName: "Mashburn",
        title: "Joe Mashburn"
      })
    });
    expect(later).toEqual({ displayName: "Joe Mashburn" });
  });

  it("preserves a legitimate custom CRM display name", () => {
    expect(
      planLinkedCrmContactIdentityRepair({
        contact: contact({ displayName: "Custom Player Name", username: "kept_user" }),
        chat: privateChat({
          firstName: "Joe",
          lastName: "Mashburn",
          username: "waylon_rivers85"
        })
      })
    ).toBeNull();
  });

  it("never downgrades a real CRM name when Telegram fields go blank", () => {
    expect(
      planLinkedCrmContactIdentityRepair({
        contact: contact({ displayName: "Joe Mashburn", username: "waylon_rivers85" }),
        chat: privateChat({
          firstName: null,
          lastName: null,
          username: null,
          title: null
        })
      })
    ).toBeNull();
  });

  it("excludes official Telegram service peers such as 777000", () => {
    expect(
      planLinkedCrmContactIdentityRepair({
        contact: contact({ displayName: "Unknown" }),
        chat: privateChat({
          telegramChatId: "777000",
          firstName: "Telegram",
          title: "Telegram"
        })
      })
    ).toBeNull();
    expect(
      telegramChatHasRepairableIdentity(
        privateChat({ telegramChatId: "777000", firstName: "Telegram", title: "Telegram" })
      )
    ).toBe(false);
  });

  it("does not apply PRIVATE-player naming to groups or bots", () => {
    expect(
      planLinkedCrmContactIdentityRepair({
        contact: contact({ displayName: "Unknown" }),
        chat: privateChat({
          chatType: "GROUP",
          title: "Staff Room",
          firstName: "Joe",
          lastName: "Mashburn"
        })
      })
    ).toBeNull();
    expect(
      planLinkedCrmContactIdentityRepair({
        contact: contact({ displayName: "Unknown" }),
        chat: privateChat({
          isBot: true,
          firstName: "Helper",
          username: "helper_bot"
        })
      })
    ).toBeNull();
  });

  it("never repairs a contact using a chat from another workspace", () => {
    expect(
      planLinkedCrmContactIdentityRepair({
        contact: contact({ workspaceId: workspaceA, displayName: "Unknown" }),
        chat: privateChat({
          workspaceId: workspaceB,
          firstName: "Jonah",
          lastName: "Leal",
          username: "Jhood69"
        })
      })
    ).toBeNull();
  });

  it("repairs an existing Unknown row from already-persisted Telegram fields (Jonah Leal)", () => {
    expect(
      planLinkedCrmContactIdentityRepair({
        contact: contact({ displayName: "Unknown", username: "" }),
        chat: privateChat({
          telegramChatId: "1002",
          firstName: "Jonah",
          lastName: "Leal",
          username: "Jhood69",
          title: "Jonah Leal"
        })
      })
    ).toEqual({ displayName: "Jonah Leal", username: "Jhood69" });
  });

  it("is idempotent once CRM already matches the Telegram identity", () => {
    expect(
      planLinkedCrmContactIdentityRepair({
        contact: contact({ displayName: "Joe Mashburn", username: "waylon_rivers85" }),
        chat: privateChat({
          firstName: "Joe",
          lastName: "Mashburn",
          username: "waylon_rivers85",
          title: "Joe Mashburn"
        })
      })
    ).toBeNull();
  });

  it("uses username as display name when names are missing", () => {
    expect(
      planLinkedCrmContactIdentityRepair({
        contact: contact({ displayName: "Unknown" }),
        chat: privateChat({ username: "waylon_rivers85" })
      })
    ).toEqual({ displayName: "waylon_rivers85", username: "waylon_rivers85" });
  });

  it("treats Unknown / Unknown User / empty / Telegram user fallback as placeholders", () => {
    expect(isPlaceholderCrmDisplayName("Unknown")).toBe(true);
    expect(isPlaceholderCrmDisplayName("Unknown User")).toBe(true);
    expect(isPlaceholderCrmDisplayName("  ")).toBe(true);
    expect(isPlaceholderCrmDisplayName("Telegram user 8771801870", "8771801870")).toBe(true);
    expect(isPlaceholderCrmDisplayName("Joe Mashburn")).toBe(false);
  });
});
