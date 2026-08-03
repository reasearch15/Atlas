"use client";

import type { TelegramMessageDto } from "@atlas/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  CHAT_MESSAGES_GC_MS,
  CHAT_MESSAGES_STALE_MS,
  cancelChatMessagesQuery,
  chatMessagesQueryKey,
  fetchChatMessages
} from "./message-cache";

/**
 * Loads messages for the currently selected chat only.
 * Shows cached data immediately; background-refreshes when stale; cancels on chat switch.
 */
export function useChatMessages(chatId: string): {
  readonly messages: TelegramMessageDto[];
  readonly loading: boolean;
  readonly fetching: boolean;
  readonly error: string | null;
  readonly setMessages: (updater: (current: TelegramMessageDto[]) => TelegramMessageDto[]) => void;
} {
  const queryClient = useQueryClient();
  const cachedState = queryClient.getQueryState<TelegramMessageDto[]>(chatMessagesQueryKey(chatId));

  const query = useQuery({
    queryKey: chatMessagesQueryKey(chatId),
    queryFn: ({ signal }) => fetchChatMessages(chatId, signal),
    staleTime: CHAT_MESSAGES_STALE_MS,
    gcTime: CHAT_MESSAGES_GC_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    ...(cachedState?.data
      ? {
          initialData: cachedState.data,
          initialDataUpdatedAt: cachedState.dataUpdatedAt
        }
      : {})
  });

  useEffect(() => {
    return () => {
      cancelChatMessagesQuery(chatId);
    };
  }, [chatId]);

  function setMessages(updater: (current: TelegramMessageDto[]) => TelegramMessageDto[]): void {
    queryClient.setQueryData<TelegramMessageDto[]>(chatMessagesQueryKey(chatId), (current) => updater(current ?? []));
  }

  const rows = (query.data ?? []) as TelegramMessageDto[];

  return {
    messages: rows,
    loading: query.isPending && rows.length === 0,
    fetching: query.isFetching,
    error: query.error instanceof Error ? query.error.message : query.error ? String(query.error) : null,
    setMessages
  };
}
