import { describe, expect, it } from "vitest";
import { buildCrmContactDisplayTitle, contactDisplayTitleQuality } from "@atlas/shared";
import { buildIdentityFillUpdate } from "./chat-identity";
import {
  coalescePeerPersistenceFields,
  extractAccessHashFromPeerCandidate,
  extractPeerFields,
  isIncompletePrivatePeer
} from "./entity-resolution";
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

describe("inbound peer access_hash persistence", () => {
  it("extracts accessHash from User and InputPeerUser shapes", () => {
    expect(
      extractPeerFields(
        {
          className: "User",
          id: "8291583373",
          accessHash: "8949449174917549431",
          firstName: "Ada",
          lastName: "Lovelace"
        },
        "8291583373"
      ).accessHash
    ).toBe("8949449174917549431");

    expect(
      extractAccessHashFromPeerCandidate({
        className: "InputPeerUser",
        userId: "8291583373",
        accessHash: BigInt("8949449174917549431")
      })
    ).toBe("8949449174917549431");
  });

  it("never overwrites a non-null accessHash with null on partial updates", () => {
    const merged = coalescePeerPersistenceFields(
      {
        accessHash: "111",
        peerType: "USER",
        firstName: "Ada",
        lastName: null,
        username: null,
        peerPhone: null,
        chatType: "PRIVATE"
      },
      {
        accessHash: null,
        peerType: null,
        firstName: null,
        lastName: "Lovelace",
        username: "ada",
        phone: null,
        chatType: "PRIVATE"
      }
    );
    expect(merged.accessHash).toBe("111");
    expect(merged.peerType).toBe("USER");
    expect(merged.lastName).toBe("Lovelace");
    expect(merged.username).toBe("ada");

    const existing = {
      title: "Ada",
      telegramChatId: "8291583373",
      username: null as string | null,
      firstName: "Ada",
      lastName: null as string | null,
      chatType: "PRIVATE",
      accessHash: "111",
      peerType: "USER" as string | null,
      peerPhone: null as string | null
    };
    const data = buildIdentityFillUpdate(
      existing,
      dialog({
        telegramChatId: "8291583373",
        title: "Ada Lovelace",
        firstName: "Ada",
        lastName: "Lovelace",
        accessHash: null,
        peerType: null
      })
    );
    expect(data.accessHash).toBeUndefined();
    expect(data.peerType).toBeUndefined();
    expect(data.lastName).toBe("Lovelace");
  });

  it("enriches a numeric-title row on later inbound without changing peer id", () => {
    const existing = {
      title: "8291583373",
      telegramChatId: "8291583373",
      username: null as string | null,
      firstName: null as string | null,
      lastName: null as string | null,
      chatType: "PRIVATE",
      accessHash: null as string | null,
      peerType: null as string | null,
      peerPhone: null as string | null
    };
    expect(isIncompletePrivatePeer(existing)).toBe(true);

    const nextTitle = buildCrmContactDisplayTitle({
      chatType: "PRIVATE",
      firstName: "John",
      lastName: "Smith",
      telegramChatId: "8291583373"
    });
    const data = buildIdentityFillUpdate(
      existing,
      dialog({
        telegramChatId: "8291583373",
        title: nextTitle,
        firstName: "John",
        lastName: "Smith",
        accessHash: "999888777",
        peerType: "USER"
      })
    );
    expect(data.title).toBe("John Smith");
    expect(data.accessHash).toBe("999888777");
    expect(data.peerType).toBe("USER");
    expect(contactDisplayTitleQuality(String(data.title), "8291583373")).toBeGreaterThan(
      contactDisplayTitleQuality(existing.title, existing.telegramChatId)
    );
  });

  it("flags incomplete private peers for diagnostics", () => {
    expect(
      isIncompletePrivatePeer({
        chatType: "PRIVATE",
        peerType: null,
        accessHash: null,
        telegramChatId: "8291583373"
      })
    ).toBe(true);
    expect(
      isIncompletePrivatePeer({
        chatType: "PRIVATE",
        peerType: "USER",
        accessHash: "123",
        telegramChatId: "8291583373"
      })
    ).toBe(false);
    expect(
      isIncompletePrivatePeer({
        chatType: "PRIVATE",
        peerType: "USER",
        accessHash: "123",
        telegramChatId: "8291583373",
        title: "Telegram user 8291583373",
        firstName: null,
        lastName: null,
        username: null
      })
    ).toBe(true);
    expect(
      isIncompletePrivatePeer({
        chatType: "GROUP",
        peerType: "CHAT",
        accessHash: null,
        telegramChatId: "-456"
      })
    ).toBe(false);
  });
});
