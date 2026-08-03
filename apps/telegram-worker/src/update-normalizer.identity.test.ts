import { describe, expect, it } from "vitest";
import { buildCrmContactDisplayTitle, isUsableHumanDisplayTitle } from "@atlas/shared";
import { chatUpdatedEvent, chatUpdatedFieldsFromRow } from "./update-normalizer";

describe("realtime chat.updated identity payload", () => {
  it("includes full identity fields for a brand-new named user", () => {
    const title = buildCrmContactDisplayTitle({
      chatType: "PRIVATE",
      firstName: "John",
      lastName: "Smith",
      telegramChatId: "8291583373"
    });
    expect(title).toBe("John Smith");

    const event = chatUpdatedEvent(
      "ws",
      chatUpdatedFieldsFromRow({
        id: "chat-db-1",
        telegramAccountId: "acc-1",
        telegramChatId: "8291583373",
        title,
        firstName: "John",
        lastName: "Smith",
        username: null,
        peerPhone: null,
        chatType: "PRIVATE",
        isBot: false,
        isPinned: false,
        unreadCount: 1,
        needsCrmAttention: true,
        lastMessagePreview: "hello",
        lastMessageAt: new Date("2026-08-03T12:00:00.000Z"),
        lastMessageDirection: "INBOUND",
        crmStatus: "NEW",
        assignedUserId: null,
        assignedUserName: null,
        assignedAt: null,
        claimedAt: null
      })
    );

    expect(event.title).toBe("John Smith");
    expect(event.firstName).toBe("John");
    expect(event.lastName).toBe("Smith");
    expect(event.identityResolved).toBe(true);
    expect(event.telegramChatId).toBe("8291583373");
    expect(event.crmStatus).toBe("NEW");
    expect(event.title).not.toMatch(/^\d+$/);
  });

  it("marks username-only contacts as resolved immediately", () => {
    const title = buildCrmContactDisplayTitle({
      chatType: "PRIVATE",
      username: "joemas020",
      telegramChatId: "42"
    });
    const fields = chatUpdatedFieldsFromRow({
      id: "c",
      telegramAccountId: "a",
      telegramChatId: "42",
      title,
      firstName: null,
      lastName: null,
      username: "joemas020",
      chatType: "PRIVATE",
      isBot: false,
      isPinned: false,
      unreadCount: 0,
      needsCrmAttention: false,
      lastMessagePreview: null,
      lastMessageAt: null
    });
    expect(fields.title).toBe("joemas020");
    expect(fields.identityResolved).toBe(true);
  });

  it("uses temporary Telegram user title when entity lookup fails", () => {
    const title = buildCrmContactDisplayTitle({
      chatType: "PRIVATE",
      telegramChatId: "8291583373"
    });
    expect(title).toBe("Telegram user 8291583373");
    expect(isUsableHumanDisplayTitle(title, "8291583373")).toBe(false);

    const fields = chatUpdatedFieldsFromRow({
      id: "c",
      telegramAccountId: "a",
      telegramChatId: "8291583373",
      title,
      firstName: null,
      lastName: null,
      username: null,
      chatType: "PRIVATE",
      isBot: false,
      isPinned: false,
      unreadCount: 1,
      needsCrmAttention: true,
      lastMessagePreview: "hi",
      lastMessageAt: new Date()
    });
    expect(fields.identityResolved).toBe(false);
    expect(fields.title).not.toBe("8291583373");
  });

  it("keeps group titles without private-user fallback", () => {
    const title = buildCrmContactDisplayTitle({
      chatType: "GROUP",
      groupTitle: "Ops Team",
      telegramChatId: "-100123"
    });
    expect(title).toBe("Ops Team");
  });
});
