import { describe, expect, it } from "vitest";
import type { Role, TelegramChatDto, TelegramMessageDto, TelegramWorkspaceRealtimeEvent } from "@atlas/shared";
import {
  CUSTOMER_PRIVACY_NOTICE,
  customerPrivacyCapabilities,
  findForbiddenCustomerIdentifierKeys,
  hasPermission,
  STAFF_CUSTOMER_EXPORT_COLUMNS
} from "@atlas/shared";
import {
  applyAccountPrivacy,
  applyChatPrivacy,
  applyContactPrivacy,
  applyMessagePrivacy,
  applyRealtimeEventPrivacy
} from "./customer-privacy-mapper";
import { buildCustomerExportRows, staffExportContainsDirectContactColumns } from "./customer-export";

const privilegedChat: TelegramChatDto = {
  id: "chat-db-1",
  telegramAccountId: "acc-1",
  telegramChatId: "7818896100",
  chatType: "PRIVATE",
  title: "Ada Lovelace",
  username: "ada_lovelace",
  firstName: "Ada",
  lastName: "Lovelace",
  phone: "+15551234567",
  lastMessagePreview: "Hello",
  lastMessageAt: new Date().toISOString(),
  lastMessageDirection: "INBOUND",
  unreadCount: 1,
  isPinned: false,
  isBot: false,
  identityResolved: true,
  crmStatus: "OPEN",
  assignedUserId: null,
  assignedUserName: null,
  assignedAt: null,
  claimedAt: null,
  needsCrmAttention: false,
  tags: []
};

const privilegedMessage: TelegramMessageDto = {
  id: "msg-1",
  telegramAccountId: "acc-1",
  chatId: "chat-db-1",
  telegramMessageId: "42",
  direction: "INBOUND",
  contentType: "CONTACT",
  mediaType: "CONTACT",
  text: "",
  caption: null,
  mimeType: null,
  fileName: null,
  fileSizeBytes: null,
  width: null,
  height: null,
  durationSeconds: null,
  waveform: null,
  mediaMetadata: {
    phoneNumber: "+15559876543",
    firstName: "Bob",
    username: "bob_user",
    userId: "999"
  },
  mediaUrl: null,
  thumbnailUrl: null,
  mediaDownloadState: "NONE",
  mediaUploadState: "NONE",
  mediaError: null,
  sentAt: new Date().toISOString(),
  editedAt: null,
  isEdited: false,
  isDeleted: false,
  senderTelegramUserId: "7818896100",
  senderDisplayName: "Ada Lovelace",
  replyToTelegramMessageId: null,
  replyPreview: null,
  webPreview: { url: "https://t.me/ada_lovelace", title: "Ada", description: null },
  internalSenderUserId: null,
  sendStatus: "RECEIVED"
};

describe("customer privacy permissions", () => {
  it("denies all direct-contact permissions to Staff", () => {
    const caps = customerPrivacyCapabilities("STAFF");
    expect(caps.canViewCustomerPhone).toBe(false);
    expect(caps.canViewTelegramUsername).toBe(false);
    expect(caps.canViewExternalContactIds).toBe(false);
    expect(caps.canViewCustomerEmail).toBe(false);
    expect(caps.canExportCustomerContactData).toBe(false);
    expect(caps.canSearchByExternalIdentifier).toBe(false);
    expect(hasPermission("STAFF", "customer:phone:view")).toBe(false);
  });

  it("grants direct-contact permissions to Coadmin and Platform Admin", () => {
    for (const role of ["COADMIN", "PLATFORM_ADMIN"] as const) {
      const caps = customerPrivacyCapabilities(role);
      expect(caps.canViewCustomerPhone).toBe(true);
      expect(caps.canViewTelegramUsername).toBe(true);
      expect(caps.canViewExternalContactIds).toBe(true);
      expect(caps.canExportCustomerContactData).toBe(true);
      expect(caps.canSearchByExternalIdentifier).toBe(true);
    }
  });
});

describe("Staff DTO privacy", () => {
  it("Staff inbox chat DTO contains no phone, username, or telegram chat id", () => {
    const staffChat = applyChatPrivacy(privilegedChat, "STAFF");
    expect(Object.prototype.hasOwnProperty.call(staffChat, "phone")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(staffChat, "username")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(staffChat, "telegramChatId")).toBe(false);
    expect(staffChat.privacyNotice).toBe(CUSTOMER_PRIVACY_NOTICE);
    expect(findForbiddenCustomerIdentifierKeys(staffChat)).toEqual([]);
  });

  it("Staff contact DTO contains no telegram username or phone", () => {
    const staffContact = applyContactPrivacy(
      {
        id: "contact-1",
        kind: "TELEGRAM_USER",
        displayName: "Ada Lovelace",
        username: "ada_lovelace",
        phoneMasked: "+155***4567",
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        conversationCount: 2
      },
      "STAFF"
    );
    expect(Object.prototype.hasOwnProperty.call(staffContact, "username")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(staffContact, "phoneMasked")).toBe(false);
    expect(staffContact.kind).toBe("Customer");
    expect(findForbiddenCustomerIdentifierKeys(staffContact)).toEqual([]);
  });

  it("Staff message DTO strips sender telegram id and contact metadata", () => {
    const staffMessage = applyMessagePrivacy(privilegedMessage, "STAFF");
    expect(Object.prototype.hasOwnProperty.call(staffMessage, "senderTelegramUserId")).toBe(false);
    expect(staffMessage.mediaMetadata?.phoneNumber).toBeUndefined();
    expect(staffMessage.mediaMetadata?.username).toBeUndefined();
    expect(staffMessage.webPreview).toBeNull();
    expect(findForbiddenCustomerIdentifierKeys(staffMessage)).toEqual([]);
  });

  it("Staff WebSocket events contain no external identifiers", () => {
    const event: TelegramWorkspaceRealtimeEvent = {
      type: "telegram.message.created",
      eventId: "evt-1",
      workspaceId: "ws-1",
      telegramAccountId: "acc-1",
      chatId: "chat-db-1",
      chatDbId: "chat-db-1",
      message: privilegedMessage
    };
    const staffEvent = applyRealtimeEventPrivacy(event, "STAFF");
    expect(findForbiddenCustomerIdentifierKeys(staffEvent)).toEqual([]);
  });

  it("Staff chat.updated events redact username/phone and never expose naked peer ids", () => {
    const event: TelegramWorkspaceRealtimeEvent = {
      type: "telegram.chat.updated",
      eventId: "evt-2",
      workspaceId: "ws-1",
      telegramAccountId: "acc-1",
      chatId: "chat-db-1",
      lastMessagePreview: "hi",
      lastMessageAt: new Date().toISOString(),
      lastMessageDirection: "INBOUND",
      unreadCount: 1,
      title: "Ada Lovelace",
      firstName: "Ada",
      lastName: "Lovelace",
      username: "ada_lovelace",
      phone: "+15551234567",
      telegramChatId: "8291583373",
      chatType: "PRIVATE",
      isBot: false
    };
    const staffEvent = applyRealtimeEventPrivacy(event, "STAFF");
    expect(staffEvent.type).toBe("telegram.chat.updated");
    if (staffEvent.type !== "telegram.chat.updated") return;
    expect(staffEvent.username).toBeNull();
    expect(staffEvent.phone).toBeNull();
    expect(staffEvent.telegramChatId).toBeUndefined();
    expect(staffEvent.title).toBe("Ada Lovelace");
    expect(JSON.stringify(staffEvent)).not.toContain("8291583373");
    expect(JSON.stringify(staffEvent)).not.toContain("ada_lovelace");
  });

  it("Staff export schema contains no contact identifier columns", () => {
    expect(staffExportContainsDirectContactColumns("STAFF")).toBe(false);
    const exported = buildCustomerExportRows({ role: "STAFF" }, [
      {
        atlasContactId: "c1",
        atlasConversationId: "chat-db-1",
        displayName: "Ada",
        neutralTypeLabel: "Customer",
        crmStatus: "OPEN",
        assignedUserName: null,
        tags: "vip",
        lastMessageAt: null,
        phone: "+15551234567",
        username: "ada",
        telegramUserId: "1",
        telegramChatId: "7818896100",
        email: "ada@example.com"
      }
    ]);
    expect(exported.columns).toEqual([...STAFF_CUSTOMER_EXPORT_COLUMNS]);
    expect(exported.columns).not.toContain("phone");
    expect(exported.columns).not.toContain("username");
    expect(exported.rows[0]).not.toHaveProperty("phone");
    expect(JSON.stringify(exported.rows)).not.toContain("15551234567");
  });

  it("Coadmin retains authorized contact fields", () => {
    const coadminChat = applyChatPrivacy(privilegedChat, "COADMIN");
    expect(coadminChat.phone).toBe("+15551234567");
    expect(coadminChat.username).toBe("ada_lovelace");
    expect(coadminChat.telegramChatId).toBe("7818896100");
  });

  it("Platform Admin retains authorized account fields", () => {
    const adminAccount = applyAccountPrivacy(
      {
        id: "acc-1",
        workspaceId: "ws-1",
        developerAppId: "app-1",
        displayName: "Ops line",
        maskedPhoneNumber: "+155***0000",
        telegramUserId: "100",
        telegramUsername: "ops_line",
        status: "CONNECTED",
        authorizationState: "AUTHORIZED",
        syncState: "LIVE",
        lastConnectedAt: null,
        lastUpdateAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        createdAt: new Date().toISOString()
      },
      "PLATFORM_ADMIN"
    );
    expect(adminAccount.maskedPhoneNumber).toBe("+155***0000");
    expect(adminAccount.telegramUsername).toBe("ops_line");
  });

  it("Staff account DTO omits workspace telegram identifiers", () => {
    const staffAccount = applyAccountPrivacy(
      {
        id: "acc-1",
        workspaceId: "ws-1",
        developerAppId: "app-1",
        displayName: "Ops line",
        maskedPhoneNumber: "+155***0000",
        telegramUserId: "100",
        telegramUsername: "ops_line",
        status: "CONNECTED",
        authorizationState: "AUTHORIZED",
        syncState: "LIVE",
        lastConnectedAt: null,
        lastUpdateAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        createdAt: new Date().toISOString()
      },
      "STAFF"
    );
    expect(Object.prototype.hasOwnProperty.call(staffAccount, "maskedPhoneNumber")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(staffAccount, "telegramUserId")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(staffAccount, "telegramUsername")).toBe(false);
  });
});

describe("Staff search privacy (client index contract)", () => {
  it("Staff chat payloads cannot seed phone or username search matches", () => {
    const staffChat = applyChatPrivacy(privilegedChat, "STAFF");
    const haystack = JSON.stringify(staffChat).toLowerCase();
    expect(haystack).not.toContain("15551234567");
    expect(haystack).not.toContain("ada_lovelace");
    expect(haystack).not.toContain("7818896100");
  });
});

describe("cross-role notification safety", () => {
  it("Staff-safe chat title never embeds phone or username", () => {
    const phoneTitleChat = applyChatPrivacy(
      { ...privilegedChat, title: "+15551234567", firstName: null, lastName: null, username: null },
      "STAFF"
    );
    expect(phoneTitleChat.title).not.toContain("1555");
    expect(phoneTitleChat.title).toMatch(/unknown|customer/i);
  });
});

describe("messaging without destination metadata", () => {
  it("keeps internal chat id and message id for Staff replies", () => {
    const staffMessage = applyMessagePrivacy(privilegedMessage, "STAFF");
    expect(staffMessage.chatId).toBe("chat-db-1");
    expect(staffMessage.telegramMessageId).toBe("42");
    expect(staffMessage.id).toBe("msg-1");
  });
});

function assertRole(role: Role): Role {
  return role;
}

void assertRole;
