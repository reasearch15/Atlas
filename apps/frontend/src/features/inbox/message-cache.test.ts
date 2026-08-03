import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  bindChatMessagesQueryClient,
  chatMessagesQueryKey,
  peekChatMessages,
  rememberChatMessage,
  rememberChatMessages,
  refreshChatMessagesIfStale
} from "./message-cache";
import type { TelegramMessageDto } from "@atlas/shared";
import { emptyMediaFields } from "./media-message-helpers";

function msg(id: string, telegramMessageId: string, text: string): TelegramMessageDto {
  return {
    id,
    telegramAccountId: "acc",
    chatId: "chat-1",
    telegramMessageId,
    direction: "INBOUND",
    senderTelegramUserId: null,
    senderDisplayName: null,
    internalSenderUserId: null,
    text,
    contentType: "TEXT",
    mediaType: "TEXT",
    ...emptyMediaFields(),
    replyToTelegramMessageId: null,
    sentAt: new Date().toISOString(),
    editedAt: null,
    isEdited: false,
    isDeleted: false,
    sendStatus: "RECEIVED"
  };
}

describe("chat message query cache", () => {
  it("stores and peeks messages without network", () => {
    const client = new QueryClient();
    bindChatMessagesQueryClient(client);
    rememberChatMessages("chat-1", [msg("1", "10", "hello")]);
    expect(peekChatMessages("chat-1")?.map((row) => row.text)).toEqual(["hello"]);
    rememberChatMessage("chat-1", msg("2", "11", "world"));
    expect(peekChatMessages("chat-1")?.map((row) => row.text)).toEqual(["hello", "world"]);
  });

  it("skips invalidate when the active chat cache is still fresh", () => {
    const client = new QueryClient();
    bindChatMessagesQueryClient(client);
    client.setQueryData(chatMessagesQueryKey("chat-1"), [msg("1", "10", "hello")]);
    let invalidated = 0;
    const original = client.invalidateQueries.bind(client);
    client.invalidateQueries = (async (...args: Parameters<typeof original>) => {
      invalidated += 1;
      return original(...args);
    }) as typeof client.invalidateQueries;
    refreshChatMessagesIfStale("chat-1");
    expect(invalidated).toBe(0);
  });
});
