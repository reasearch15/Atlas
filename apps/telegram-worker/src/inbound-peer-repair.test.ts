import { describe, expect, it, vi } from "vitest";
import {
  buildCrmContactDisplayTitle,
  contactDisplayTitleQuality,
  formatTelegramUserFallbackTitle
} from "@atlas/shared";
import { buildIdentityFillUpdate, needsIdentityBackfillRow } from "./chat-identity";
import {
  coalescePeerPersistenceFields,
  isIncompletePrivatePeer,
  isPrivatePeerMetadataComplete,
  isUnusablePrivatePeerTitle
} from "./entity-resolution";
import { chatUpdatedEvent, chatUpdatedFieldsFromRow, messageCreatedEvent } from "./update-normalizer";
import type { NormalizedDialog } from "./telegram-client";

const PEER_ID = "5476500286";
const ACCESS_HASH = "8949449174917549431";

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

/**
 * Simulates the inbound upsert identity merge: coalesce + title + fill update.
 * Same chat row key (telegramChatId) — never invents a second conversation.
 */
function repairPrivatePeerFromLive(
  existing: {
    id: string;
    title: string;
    telegramChatId: string;
    chatType: string;
    peerType: string | null;
    accessHash: string | null;
    firstName: string | null;
    lastName: string | null;
    username: string | null;
    peerPhone: string | null;
    unreadCount: number;
    assignedToUserId?: string | null;
  },
  live: NormalizedDialog
) {
  const metadataCompleteBefore = isPrivatePeerMetadataComplete({
    chatType: existing.chatType,
    peerType: existing.peerType,
    accessHash: existing.accessHash,
    telegramChatId: existing.telegramChatId,
    title: existing.title,
    firstName: existing.firstName,
    lastName: existing.lastName,
    username: existing.username
  });

  const peerFields = coalescePeerPersistenceFields(
    {
      accessHash: existing.accessHash,
      peerType: existing.peerType,
      firstName: existing.firstName,
      lastName: existing.lastName,
      username: existing.username,
      peerPhone: existing.peerPhone,
      chatType: existing.chatType
    },
    {
      accessHash: live.accessHash,
      peerType: live.peerType,
      firstName: live.firstName,
      lastName: live.lastName,
      username: live.username,
      phone: live.phone,
      chatType: live.chatType
    }
  );

  const createTitle = buildCrmContactDisplayTitle({
    firstName: peerFields.firstName,
    lastName: peerFields.lastName,
    username: peerFields.username,
    phone: peerFields.peerPhone,
    telegramChatId: existing.telegramChatId,
    groupTitle: live.title,
    chatType: peerFields.chatType
  });

  const fill = buildIdentityFillUpdate(
    {
      title: existing.title,
      telegramChatId: existing.telegramChatId,
      username: existing.username,
      firstName: existing.firstName,
      lastName: existing.lastName,
      chatType: existing.chatType,
      accessHash: existing.accessHash,
      peerType: existing.peerType,
      peerPhone: existing.peerPhone
    },
    {
      ...live,
      accessHash: peerFields.accessHash,
      peerType: (peerFields.peerType as NormalizedDialog["peerType"]) ?? live.peerType,
      firstName: peerFields.firstName,
      lastName: peerFields.lastName,
      username: peerFields.username,
      phone: peerFields.peerPhone,
      title: createTitle
    }
  );

  const nextTitle =
    typeof fill.title === "string"
      ? fill.title
      : contactDisplayTitleQuality(createTitle, existing.telegramChatId) >
          contactDisplayTitleQuality(existing.title, existing.telegramChatId)
        ? createTitle
        : existing.title;

  const repaired = {
    id: existing.id,
    telegramChatId: existing.telegramChatId,
    title: nextTitle,
    chatType: peerFields.chatType,
    peerType: peerFields.peerType,
    accessHash: peerFields.accessHash,
    firstName: peerFields.firstName,
    lastName: peerFields.lastName,
    username: peerFields.username,
    peerPhone: peerFields.peerPhone,
    unreadCount: existing.unreadCount,
    assignedToUserId: existing.assignedToUserId ?? null
  };

  return { metadataCompleteBefore, repaired, peerFields, createTitle };
}

describe("private peer completeness predicate", () => {
  it("complete private peer is not incomplete", () => {
    const row = {
      chatType: "PRIVATE",
      peerType: "USER",
      accessHash: ACCESS_HASH,
      telegramChatId: PEER_ID,
      title: "Picasso",
      firstName: "Picasso",
      lastName: null,
      username: null
    };
    expect(isIncompletePrivatePeer(row)).toBe(false);
    expect(isPrivatePeerMetadataComplete(row)).toBe(true);
    expect(needsIdentityBackfillRow(row)).toBe(false);
  });

  it("flags missing peer_type, non-USER peer_type, and missing access_hash", () => {
    expect(
      isIncompletePrivatePeer({
        chatType: "PRIVATE",
        peerType: null,
        accessHash: ACCESS_HASH,
        telegramChatId: PEER_ID,
        title: "Picasso",
        firstName: "Picasso",
        lastName: null,
        username: null
      })
    ).toBe(true);
    expect(
      isIncompletePrivatePeer({
        chatType: "PRIVATE",
        peerType: "CHANNEL",
        accessHash: ACCESS_HASH,
        telegramChatId: PEER_ID,
        title: "Picasso",
        firstName: "Picasso",
        lastName: null,
        username: null
      })
    ).toBe(true);
    expect(
      isIncompletePrivatePeer({
        chatType: "PRIVATE",
        peerType: "USER",
        accessHash: null,
        telegramChatId: PEER_ID,
        title: "Picasso",
        firstName: "Picasso",
        lastName: null,
        username: null
      })
    ).toBe(true);
  });

  it("flags digit-only, Telegram user fallback, and Unknown User titles", () => {
    expect(isUnusablePrivatePeerTitle(PEER_ID)).toBe(true);
    expect(isUnusablePrivatePeerTitle(formatTelegramUserFallbackTitle(PEER_ID))).toBe(true);
    expect(isUnusablePrivatePeerTitle("Unknown User")).toBe(true);
    expect(isUnusablePrivatePeerTitle("Picasso")).toBe(false);

    expect(
      isIncompletePrivatePeer({
        chatType: "PRIVATE",
        peerType: "USER",
        accessHash: ACCESS_HASH,
        telegramChatId: PEER_ID,
        title: formatTelegramUserFallbackTitle(PEER_ID),
        firstName: "Picasso",
        lastName: null,
        username: null
      })
    ).toBe(true);
  });

  it("flags when first_name, last_name, and username are all empty", () => {
    expect(
      isIncompletePrivatePeer({
        chatType: "PRIVATE",
        peerType: "USER",
        accessHash: ACCESS_HASH,
        telegramChatId: PEER_ID,
        title: "Picasso",
        firstName: null,
        lastName: null,
        username: null
      })
    ).toBe(true);
  });

  it("does not apply private-user rules to groups/channels", () => {
    expect(
      isIncompletePrivatePeer({
        chatType: "GROUP",
        peerType: "CHAT",
        accessHash: null,
        telegramChatId: "-456",
        title: "Team",
        firstName: null,
        lastName: null,
        username: null
      })
    ).toBe(false);
    expect(
      isIncompletePrivatePeer({
        chatType: "CHANNEL",
        peerType: "CHANNEL",
        accessHash: null,
        telegramChatId: "-1001",
        title: "News",
        firstName: null,
        lastName: null,
        username: null
      })
    ).toBe(false);
    expect(isPrivatePeerMetadataComplete({ chatType: "GROUP", peerType: "CHAT", accessHash: null })).toBe(true);
  });
});

describe("inbound peer metadata repair", () => {
  it("complete private peer skips repair (metadataCompleteBefore=true)", () => {
    const existing = {
      id: "chat-db-1",
      title: "Picasso",
      telegramChatId: PEER_ID,
      chatType: "PRIVATE",
      peerType: "USER",
      accessHash: ACCESS_HASH,
      firstName: "Picasso",
      lastName: null as string | null,
      username: null as string | null,
      peerPhone: null as string | null,
      unreadCount: 3,
      assignedToUserId: "staff-1"
    };
    const live = dialog({
      telegramChatId: PEER_ID,
      title: "Picasso",
      firstName: "Picasso",
      accessHash: ACCESS_HASH,
      peerType: "USER"
    });
    const { metadataCompleteBefore, repaired } = repairPrivatePeerFromLive(existing, live);
    expect(metadataCompleteBefore).toBe(true);
    expect(repaired.id).toBe(existing.id);
    expect(repaired.accessHash).toBe(ACCESS_HASH);
    expect(repaired.unreadCount).toBe(3);
    expect(repaired.assignedToUserId).toBe("staff-1");
  });

  it("incomplete peer: next inbound repairs peer_type, access_hash, and name", () => {
    const existing = {
      id: "chat-db-1",
      title: formatTelegramUserFallbackTitle(PEER_ID),
      telegramChatId: PEER_ID,
      chatType: "PRIVATE",
      peerType: null as string | null,
      accessHash: null as string | null,
      firstName: null as string | null,
      lastName: null as string | null,
      username: null as string | null,
      peerPhone: null as string | null,
      unreadCount: 1
    };
    expect(isIncompletePrivatePeer(existing)).toBe(true);

    const live = dialog({
      telegramChatId: PEER_ID,
      title: "Picasso",
      firstName: "Picasso",
      lastName: null,
      accessHash: ACCESS_HASH,
      peerType: "USER"
    });
    const { metadataCompleteBefore, repaired } = repairPrivatePeerFromLive(existing, live);
    expect(metadataCompleteBefore).toBe(false);
    expect(repaired.id).toBe("chat-db-1");
    expect(repaired.telegramChatId).toBe(PEER_ID);
    expect(repaired.peerType).toBe("USER");
    expect(repaired.accessHash).toBe(ACCESS_HASH);
    expect(repaired.firstName).toBe("Picasso");
    expect(repaired.title).toBe("Picasso");
    expect(isIncompletePrivatePeer(repaired)).toBe(false);
  });

  it("numeric title becomes real name on same chat row", () => {
    const existing = {
      id: "chat-db-2",
      title: PEER_ID,
      telegramChatId: PEER_ID,
      chatType: "PRIVATE",
      peerType: "USER" as string | null,
      accessHash: ACCESS_HASH,
      firstName: null as string | null,
      lastName: null as string | null,
      username: null as string | null,
      peerPhone: null as string | null,
      unreadCount: 0
    };
    const { repaired } = repairPrivatePeerFromLive(
      existing,
      dialog({
        telegramChatId: PEER_ID,
        title: "John Smith",
        firstName: "John",
        lastName: "Smith",
        accessHash: ACCESS_HASH,
        peerType: "USER"
      })
    );
    expect(repaired.id).toBe("chat-db-2");
    expect(repaired.title).toBe("John Smith");
    expect(repaired.telegramChatId).toBe(PEER_ID);
  });

  it("Telegram user fallback becomes real name", () => {
    const existing = {
      id: "chat-db-3",
      title: formatTelegramUserFallbackTitle(PEER_ID),
      telegramChatId: PEER_ID,
      chatType: "PRIVATE",
      peerType: "USER" as string | null,
      accessHash: ACCESS_HASH,
      firstName: null as string | null,
      lastName: null as string | null,
      username: null as string | null,
      peerPhone: null as string | null,
      unreadCount: 5
    };
    const { repaired } = repairPrivatePeerFromLive(
      existing,
      dialog({
        telegramChatId: PEER_ID,
        title: "Ada Lovelace",
        firstName: "Ada",
        lastName: "Lovelace",
        accessHash: ACCESS_HASH,
        peerType: "USER"
      })
    );
    expect(repaired.title).toBe("Ada Lovelace");
    expect(repaired.unreadCount).toBe(5);
  });

  it("partial update does not erase existing metadata", () => {
    const existing = {
      id: "chat-db-4",
      title: "Ada",
      telegramChatId: PEER_ID,
      chatType: "PRIVATE",
      peerType: "USER" as string | null,
      accessHash: ACCESS_HASH,
      firstName: "Ada" as string | null,
      lastName: null as string | null,
      username: "ada" as string | null,
      peerPhone: null as string | null,
      unreadCount: 0
    };
    const { repaired, peerFields } = repairPrivatePeerFromLive(
      existing,
      dialog({
        telegramChatId: PEER_ID,
        title: "Ada",
        firstName: null,
        lastName: "Lovelace",
        username: null,
        accessHash: null,
        peerType: null
      })
    );
    expect(peerFields.accessHash).toBe(ACCESS_HASH);
    expect(peerFields.peerType).toBe("USER");
    expect(peerFields.firstName).toBe("Ada");
    expect(peerFields.username).toBe("ada");
    expect(peerFields.lastName).toBe("Lovelace");
    expect(repaired.title).toBe("Ada Lovelace");
  });

  it("same chat row updated — no duplicate conversation key", () => {
    const existing = {
      id: "chat-db-5",
      title: formatTelegramUserFallbackTitle(PEER_ID),
      telegramChatId: PEER_ID,
      chatType: "PRIVATE",
      peerType: null as string | null,
      accessHash: null as string | null,
      firstName: null as string | null,
      lastName: null as string | null,
      username: null as string | null,
      peerPhone: null as string | null,
      unreadCount: 2
    };
    const a = repairPrivatePeerFromLive(
      existing,
      dialog({
        telegramChatId: PEER_ID,
        title: "Picasso",
        firstName: "Picasso",
        accessHash: ACCESS_HASH,
        peerType: "USER"
      })
    );
    const b = repairPrivatePeerFromLive(
      a.repaired as typeof existing,
      dialog({
        telegramChatId: PEER_ID,
        title: "Picasso",
        firstName: "Picasso",
        accessHash: ACCESS_HASH,
        peerType: "USER"
      })
    );
    expect(a.repaired.id).toBe(b.repaired.id);
    expect(a.repaired.telegramChatId).toBe(b.repaired.telegramChatId);
  });

  it("realtime identity updates without refresh — chat.updated carries repaired title", () => {
    const repairedRow = {
      id: "chat-db-6",
      telegramAccountId: "acc-1",
      telegramChatId: PEER_ID,
      title: "Picasso",
      username: null as string | null,
      firstName: "Picasso" as string | null,
      lastName: null as string | null,
      chatType: "PRIVATE",
      isBot: false,
      isPinned: false,
      unreadCount: 4,
      lastMessagePreview: "hello",
      lastMessageAt: new Date("2026-08-03T12:00:00.000Z"),
      needsCrmAttention: true,
      crmStatus: "NEW" as const,
      assignedUserId: null as string | null,
      assignedUserName: null as string | null,
      assignedAt: null,
      claimedAt: null,
      peerPhone: null as string | null
    };
    const chatEvent = chatUpdatedEvent(
      "ws-1",
      chatUpdatedFieldsFromRow({
        ...repairedRow,
        lastMessageDirection: "INBOUND"
      })
    );
    expect(chatEvent.type).toBe("telegram.chat.updated");
    expect(chatEvent.title).toBe("Picasso");
    expect(chatEvent.chatId).toBe("chat-db-6");
    expect(chatEvent.unreadCount).toBe(4);
    expect(chatEvent.identityResolved).toBe(true);

    const messageEvent = messageCreatedEvent("ws-1", {
      id: "msg-1",
      chatId: "chat-db-6",
      telegramAccountId: "acc-1",
      telegramChatId: PEER_ID,
      telegramMessageId: "9001",
      direction: "INBOUND",
      senderName: "Picasso",
      text: "hello",
      contentType: "TEXT",
      sentAt: "2026-08-03T12:00:00.000Z",
      chatTitle: "Picasso",
      chatType: "PRIVATE",
      chatUsername: null
    } as never);
    expect(messageEvent.type).toBe("telegram.message.created");
    expect(messageEvent.chatId).toBe("chat-db-6");
    expect(messageEvent.message.chatId).toBe("chat-db-6");
  });

  it("failed outbound remains failed until explicit retry; retry succeeds after repair", () => {
    const failed = {
      id: "msg-out-1",
      sendStatus: "FAILED_RETRYABLE",
      telegramMessageId: `pending:send:${PEER_ID}:uuid`,
      mediaError: "TELEGRAM_PEER_UNRESOLVED: Could not resolve Telegram peer"
    };
    const autoResend = vi.fn();
    // Inbound repair must not auto-resend.
    expect(failed.sendStatus).toBe("FAILED_RETRYABLE");
    expect(autoResend).not.toHaveBeenCalled();

    const chatAfterRepair = {
      telegramChatId: PEER_ID,
      peerType: "USER",
      accessHash: ACCESS_HASH,
      firstName: "Picasso",
      title: "Picasso"
    };
    expect(isIncompletePrivatePeer(chatAfterRepair)).toBe(false);

    // Explicit retry is idempotent on the same message / command row.
    const retried = {
      ...failed,
      sendStatus: "QUEUED",
      mediaError: null as string | null
    };
    expect(retried.id).toBe(failed.id);
    expect(retried.telegramMessageId).toBe(failed.telegramMessageId);

    const afterAck = {
      id: retried.id,
      telegramMessageId: "981",
      sendStatus: "SENT"
    };
    expect(afterAck.id).toBe(failed.id);
    expect(afterAck.sendStatus).toBe("SENT");
  });

  it("group/channel metadata is unaffected by private completeness rules", () => {
    const group = {
      chatType: "GROUP",
      peerType: "CHAT",
      accessHash: null,
      telegramChatId: "-12345",
      title: "Ops Team",
      firstName: null,
      lastName: null,
      username: null
    };
    expect(isIncompletePrivatePeer(group)).toBe(false);
    expect(needsIdentityBackfillRow({ ...group, username: null })).toBe(false);

    const channel = {
      chatType: "CHANNEL" as const,
      peerType: "CHANNEL" as string | null,
      accessHash: "555",
      telegramChatId: "-100999",
      title: "News",
      username: "news",
      firstName: null,
      lastName: null
    };
    expect(isIncompletePrivatePeer(channel)).toBe(false);
  });
});
