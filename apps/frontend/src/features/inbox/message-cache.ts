import type { TelegramMessageDto } from "@atlas/shared";
import type { QueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { mergeAndDeduplicate, mergeMessages } from "./inbox-utils";

export const chatMessagesQueryKey = (chatId: string) => ["telegram", "chat-messages", chatId] as const;

/** How long a chat history is considered fresh enough to skip an immediate network refetch. */
export const CHAT_MESSAGES_STALE_MS = 60_000;
export const CHAT_MESSAGES_GC_MS = 30 * 60_000;

let queryClient: QueryClient | null = null;

/**
 * Binds the app QueryClient so realtime/optimistic merges can update the same cache.
 */
export function bindChatMessagesQueryClient(client: QueryClient): void {
  queryClient = client;
}

/**
 * Synchronous peek of cached messages for instant chat paint.
 */
export function peekChatMessages(chatId: string): TelegramMessageDto[] | null {
  const rows = queryClient?.getQueryData<TelegramMessageDto[]>(chatMessagesQueryKey(chatId));
  return rows && rows.length > 0 ? rows.slice() : null;
}

/**
 * Fetches chat messages. Deduped by React Query; aborted via `signal` on chat switch.
 */
export async function fetchChatMessages(chatId: string, signal?: AbortSignal): Promise<TelegramMessageDto[]> {
  const rows = await api.telegramChatMessages(chatId, signal);
  const prior = peekChatMessages(chatId) ?? [];
  return mergeMessages(prior, rows);
}

/**
 * Merges messages into the React Query cache without shrinking history.
 */
export function rememberChatMessages(chatId: string, messages: TelegramMessageDto[]): void {
  if (!queryClient) return;
  queryClient.setQueryData<TelegramMessageDto[]>(chatMessagesQueryKey(chatId), (current) =>
    mergeMessages(current ?? [], messages)
  );
}

/**
 * Appends/merges a single realtime message into the active chat cache.
 */
export function rememberChatMessage(chatId: string, message: TelegramMessageDto): void {
  if (!queryClient) return;
  queryClient.setQueryData<TelegramMessageDto[]>(chatMessagesQueryKey(chatId), (current) =>
    mergeAndDeduplicate(current ?? [], message)
  );
}

/**
 * Background-refresh the active chat only when its cache is stale (or missing).
 * Never used for hover prefetch of the conversation list.
 */
export function refreshChatMessagesIfStale(chatId: string): void {
  if (!queryClient) return;
  const state = queryClient.getQueryState(chatMessagesQueryKey(chatId));
  if (state?.data && state.dataUpdatedAt && Date.now() - state.dataUpdatedAt < CHAT_MESSAGES_STALE_MS) {
    return;
  }
  void queryClient.invalidateQueries({ queryKey: chatMessagesQueryKey(chatId), exact: true });
}

/**
 * Cancels any in-flight history fetch for a chat (e.g. when switching away).
 */
export function cancelChatMessagesQuery(chatId: string): void {
  if (!queryClient) return;
  void queryClient.cancelQueries({ queryKey: chatMessagesQueryKey(chatId), exact: true });
}

/**
 * Removes cached message history for permanently deleted conversations.
 */
export function purgeChatMessageCaches(chatIds: readonly string[]): void {
  if (!queryClient) return;
  for (const chatId of chatIds) {
    void queryClient.cancelQueries({ queryKey: chatMessagesQueryKey(chatId), exact: true });
    queryClient.removeQueries({ queryKey: chatMessagesQueryKey(chatId), exact: true });
  }
}
