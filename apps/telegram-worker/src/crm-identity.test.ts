import { describe, expect, it } from "vitest";
import { buildCrmContactDisplayTitle, shouldIgnoreTelegramDialog } from "@atlas/shared";
import { buildIdentityFillUpdate, identityUpdateImproves, needsIdentityBackfillRow } from "./chat-identity";
import type { NormalizedDialog } from "./telegram-client";

function dialog(partial: Partial<NormalizedDialog> & Pick<NormalizedDialog, "telegramChatId" | "title">): NormalizedDialog {
  return {
    username: null,
    chatType: "PRIVATE",
    unreadCount: 0,
    isPinned: false,
    isBot: false,
    firstName: null,
    lastName: null,
    accessHash: null,
    peerType: "USER",
    phone: null,
    isSelf: false,
    isSupport: false,
    isArchived: false,
    topMessageId: null,
    raw: {},
    ...partial
  };
}

describe("CRM dialog eligibility (worker)", () => {
  it("never imports official Telegram service accounts", () => {
    expect(
      shouldIgnoreTelegramDialog({
        telegramChatId: "777000",
        chatType: "PRIVATE",
        title: "Telegram",
        firstName: "Telegram",
        isSupport: false,
        isSelf: false,
        isArchived: false
      })
    ).toBe(true);
  });

  it("never imports Saved Messages", () => {
    expect(
      shouldIgnoreTelegramDialog({
        telegramChatId: "1001",
        chatType: "PRIVATE",
        isSelf: true
      })
    ).toBe(true);
  });
});

describe("CRM contact display titles (worker)", () => {
  it("resolves username-only contacts", () => {
    expect(buildCrmContactDisplayTitle({ chatType: "PRIVATE", username: "onlyuser", telegramChatId: "9" })).toBe(
      "onlyuser"
    );
  });

  it("resolves phone-only contacts", () => {
    expect(buildCrmContactDisplayTitle({ chatType: "PRIVATE", phone: "+12025550123", telegramChatId: "9" })).toBe(
      "+12025550123"
    );
  });

  it("resolves first+last name contacts", () => {
    expect(
      buildCrmContactDisplayTitle({
        chatType: "PRIVATE",
        firstName: "Ada",
        lastName: "Lovelace",
        telegramChatId: "9"
      })
    ).toBe("Ada Lovelace");
  });
});

describe("identity fill after delayed entity resolution", () => {
  it("updates an Unknown User conversation when the entity arrives later", () => {
    const existing = {
      title: "Unknown User",
      telegramChatId: "555001",
      username: null as string | null,
      firstName: null as string | null,
      lastName: null as string | null,
      chatType: "PRIVATE",
      isBot: false,
      accessHash: null as string | null,
      peerType: "USER" as string | null,
      peerPhone: null as string | null
    };
    expect(needsIdentityBackfillRow(existing)).toBe(true);

    const identity = dialog({
      telegramChatId: "555001",
      title: buildCrmContactDisplayTitle({
        chatType: "PRIVATE",
        firstName: "Joemas020",
        lastName: "Joemas060",
        telegramChatId: "555001"
      }),
      firstName: "Joemas020",
      lastName: "Joemas060",
      username: "joemas",
      accessHash: "999"
    });

    const data = buildIdentityFillUpdate(existing, identity);
    expect(data.title).toBe("Joemas020 Joemas060");
    expect(data.firstName).toBe("Joemas020");
    expect(data.lastName).toBe("Joemas060");
    expect(data.username).toBe("joemas");
    expect(identityUpdateImproves(existing, data)).toBe("updated");
  });
});
