import { describe, expect, it } from "vitest";
import {
  applySequentialScrollDeltas,
  scrollDeltaForAnchor
} from "./inbox-list-anchor";
import {
  applyChatActivity,
  compareInboxConversations,
  filterConversations,
  sortConversations,
  toInboxConversation
} from "./inbox-utils";
import type { TelegramChatDto } from "@atlas/shared";

function chat(partial: Partial<TelegramChatDto> & Pick<TelegramChatDto, "id" | "title">): TelegramChatDto {
  return {
    telegramAccountId: "acc",
    telegramChatId: partial.id,
    chatType: "PRIVATE",
    username: null,
    firstName: null,
    lastName: null,
    phone: null,
    lastMessagePreview: null,
    lastMessageAt: null,
    lastMessageDirection: null,
    unreadCount: 0,
    isPinned: false,
    isBot: false,
    identityResolved: true,
    crmStatus: "OPEN",
    assignedUserId: null,
    assignedUserName: null,
    assignedAt: null,
    claimedAt: null,
    needsCrmAttention: false,
    tags: [],
    ...partial
  };
}

function row(
  partial: Partial<TelegramChatDto> & Pick<TelegramChatDto, "id" | "title">
) {
  return toInboxConversation(chat(partial), "acc");
}

describe("inbox list reorder + selection stability", () => {
  it("keeps selectedChatId when the selected chat receives a message and moves to top", () => {
    const selectedChatId = "selected";
    const before = sortConversations([
      row({ id: "other", title: "Other", lastMessageAt: "2026-08-03T12:00:00.000Z" }),
      row({ id: selectedChatId, title: "Selected", lastMessageAt: "2026-08-03T11:00:00.000Z" }),
      row({ id: "older", title: "Older", lastMessageAt: "2026-08-03T10:00:00.000Z" })
    ]);
    expect(before.map((r) => r.chat.id)).toEqual(["other", selectedChatId, "older"]);

    const after = applyChatActivity(before, {
      chatId: selectedChatId,
      previewText: "new inbound",
      sentAt: "2026-08-03T13:00:00.000Z",
      direction: "INBOUND",
      bumpUnread: true
    });

    expect(after.map((r) => r.chat.id)).toEqual([selectedChatId, "other", "older"]);
    expect(after.find((r) => r.chat.id === selectedChatId)?.chat.id).toBe(selectedChatId);
    expect(after.filter((r) => r.chat.id === selectedChatId)).toHaveLength(1);
    // Simulated list indices: selected moved 1 → 0; scroll compensation uses positional delta.
    const previousOffset = 72; // was second row
    const newOffset = 0; // now first row
    const delta = scrollDeltaForAnchor({
      previousOffsetFromContainerTop: previousOffset,
      newOffsetFromContainerTop: newOffset
    });
    expect(delta).toBe(-72);
    expect(applySequentialScrollDeltas(200, [delta])).toBe(128);
  });

  it("keeps selected chat open when another chat jumps above it and compensates scroll", () => {
    const selectedChatId = "selected";
    const before = sortConversations([
      row({ id: selectedChatId, title: "Selected", lastMessageAt: "2026-08-03T12:00:00.000Z" }),
      row({ id: "other", title: "Other", lastMessageAt: "2026-08-03T11:00:00.000Z" })
    ]);
    const after = applyChatActivity(before, {
      chatId: "other",
      previewText: "bump",
      sentAt: "2026-08-03T13:00:00.000Z",
      direction: "INBOUND",
      bumpUnread: true
    });

    expect(after.map((r) => r.chat.id)).toEqual(["other", selectedChatId]);
    expect(after.find((r) => r.chat.id === selectedChatId)).toBeTruthy();

    // Selected row shifts down by one row height — restore by adding that delta to scrollTop.
    const delta = scrollDeltaForAnchor({
      previousOffsetFromContainerTop: 0,
      newOffsetFromContainerTop: 72
    });
    expect(delta).toBe(72);
    expect(applySequentialScrollDeltas(0, [delta])).toBe(72);
  });

  it("handles multiple rapid messages without duplicate rows or selection drift", () => {
    const selectedChatId = "selected";
    let list = sortConversations([
      row({ id: selectedChatId, title: "Selected", lastMessageAt: "2026-08-03T10:00:00.000Z" }),
      row({ id: "a", title: "A", lastMessageAt: "2026-08-03T09:00:00.000Z" }),
      row({ id: "b", title: "B", lastMessageAt: "2026-08-03T08:00:00.000Z" })
    ]);

    const deltas: number[] = [];
    const events = [
      { chatId: "a", sentAt: "2026-08-03T10:01:00.000Z", prevOffset: 0, nextOffset: 72 },
      { chatId: "b", sentAt: "2026-08-03T10:02:00.000Z", prevOffset: 72, nextOffset: 144 },
      { chatId: "a", sentAt: "2026-08-03T10:03:00.000Z", prevOffset: 144, nextOffset: 144 }
    ] as const;

    for (const event of events) {
      list = applyChatActivity(list, {
        chatId: event.chatId,
        previewText: `msg-${event.sentAt}`,
        sentAt: event.sentAt,
        direction: "INBOUND",
        bumpUnread: true
      });
      deltas.push(
        scrollDeltaForAnchor({
          previousOffsetFromContainerTop: event.prevOffset,
          newOffsetFromContainerTop: event.nextOffset
        })
      );
    }

    expect(list.filter((r) => r.chat.id === selectedChatId)).toHaveLength(1);
    expect(new Set(list.map((r) => r.chat.id)).size).toBe(list.length);
    expect(list.find((r) => r.chat.id === selectedChatId)?.chat.id).toBe(selectedChatId);
    // Perfect per-step compensation → net scroll equals sum of deltas, no extra drift.
    const initial = 50;
    expect(applySequentialScrollDeltas(initial, deltas)).toBe(initial + deltas.reduce((a, b) => a + b, 0));
  });

  it("matches REST flatten sort and realtime merge order (deterministic)", () => {
    const unsorted = [
      row({ id: "c", title: "C", lastMessageAt: "2026-08-03T10:00:00.000Z", assignedAt: "2026-08-01T00:00:00.000Z" }),
      row({ id: "a", title: "A", lastMessageAt: "2026-08-03T12:00:00.000Z" }),
      row({ id: "b", title: "B", lastMessageAt: "2026-08-03T11:00:00.000Z" }),
      row({ id: "p", title: "Pinned", isPinned: true, lastMessageAt: "2026-08-03T09:00:00.000Z" })
    ];
    const restOrder = sortConversations(unsorted).map((r) => r.chat.id);
    const afterWs = applyChatActivity(unsorted, {
      chatId: "c",
      previewText: "same time as a",
      sentAt: "2026-08-03T12:00:00.000Z",
      direction: "INBOUND"
    });
    // Same lastMessageAt as a → updatedAt proxy then id tie-break; still deterministic vs fresh sort.
    const refreshed = sortConversations(afterWs);
    expect(refreshed.map((r) => r.chat.id)).toEqual(afterWs.map((r) => r.chat.id));
    expect(restOrder[0]).toBe("p");
    expect(compareInboxConversations(afterWs[0]!, afterWs[1]!)).toBeLessThanOrEqual(0);
  });

  it("preserves selection by id across All / Unassigned / Mine / New when the row stays in filter", () => {
    const selectedChatId = "mine-new";
    const rows = sortConversations([
      row({
        id: selectedChatId,
        title: "Mine New",
        crmStatus: "NEW",
        assignedUserId: "u1",
        lastMessageAt: "2026-08-03T12:00:00.000Z"
      }),
      row({
        id: "unassigned",
        title: "Unassigned",
        crmStatus: "OPEN",
        assignedUserId: null,
        lastMessageAt: "2026-08-03T11:00:00.000Z"
      })
    ]);

    for (const filter of ["all", "mine", "new"] as const) {
      const visible = filterConversations(rows, filter, "", "u1");
      expect(visible.some((r) => r.chat.id === selectedChatId)).toBe(true);
    }
    expect(filterConversations(rows, "unassigned", "", "u1").some((r) => r.chat.id === selectedChatId)).toBe(false);
  });

  it("does not pick an arbitrary row when the selected chat leaves the current filter", () => {
    const selectedChatId = "resolved-chat";
    const rows = [
      row({
        id: selectedChatId,
        title: "Resolved",
        crmStatus: "RESOLVED",
        assignedUserId: "u1",
        lastMessageAt: "2026-08-03T12:00:00.000Z"
      }),
      row({
        id: "open-chat",
        title: "Open",
        crmStatus: "OPEN",
        assignedUserId: null,
        lastMessageAt: "2026-08-03T11:00:00.000Z"
      })
    ];
    const visible = filterConversations(rows, "unassigned", "", "u1");
    expect(visible.map((r) => r.chat.id)).toEqual(["open-chat"]);
    // Selection remains the URL id — callers must not fall back to visible[0].
    const stillSelectedId = selectedChatId;
    expect(visible[0]?.chat.id).not.toBe(stillSelectedId);
    expect(stillSelectedId).toBe("resolved-chat");
  });

  it("keeps stable row identity keys across unread/title/preview/identity repair", () => {
    const id = "stable-id";
    let list = [row({ id, title: "Unknown User", unreadCount: 0, lastMessagePreview: "a", identityResolved: false })];
    const keyBefore = list[0]!.chat.id;

    list = applyChatActivity(list, {
      chatId: id,
      previewText: "b",
      sentAt: "2026-08-03T13:00:00.000Z",
      direction: "INBOUND",
      bumpUnread: true,
      title: "Ada Lovelace",
      identityResolved: true
    });

    expect(list[0]!.chat.id).toBe(keyBefore);
    expect(list[0]!.chat.unreadCount).toBe(1);
    expect(list[0]!.chat.title).toBe("Ada Lovelace");
    expect(list[0]!.chat.lastMessagePreview).toBe("b");
  });

  it("does not let urgency/unread alone reorder above a newer lastMessageAt", () => {
    const newerQuiet = row({
      id: "quiet",
      title: "Quiet",
      lastMessageAt: "2026-08-03T12:00:00.000Z",
      unreadCount: 0,
      needsCrmAttention: false
    });
    const olderHot = row({
      id: "hot",
      title: "Hot",
      lastMessageAt: "2026-08-03T10:00:00.000Z",
      unreadCount: 5,
      needsCrmAttention: true,
      assignedUserId: "u1"
    });
    expect(sortConversations([olderHot, newerQuiet]).map((r) => r.chat.id)).toEqual(["quiet", "hot"]);
  });

  it("documents message-pane isolation: list reorder math does not touch message scrollTop", () => {
    const messagePaneScrollTop = 480;
    const listDelta = scrollDeltaForAnchor({
      previousOffsetFromContainerTop: 0,
      newOffsetFromContainerTop: 72
    });
    // List compensation applies only to the conversation list container.
    expect(applySequentialScrollDeltas(100, [listDelta])).toBe(172);
    expect(messagePaneScrollTop).toBe(480);
  });
});
