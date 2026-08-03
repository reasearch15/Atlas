import type {
  TelegramChatUpdatedEvent,
  TelegramMessageCreatedEvent,
  TelegramMessageDto,
  TelegramMessageUpdatedEvent
} from "@atlas/shared";

/**
 * Builds a workspace-scoped realtime event for a persisted message.
 */
export function messageCreatedEvent(workspaceId: string, message: TelegramMessageDto): TelegramMessageCreatedEvent {
  return {
    type: "telegram.message.created",
    eventId: crypto.randomUUID(),
    workspaceId,
    telegramAccountId: message.telegramAccountId,
    chatId: message.chatId,
    chatDbId: message.chatId,
    message
  };
}

/**
 * Builds a workspace-scoped realtime event when media finishes downloading/uploading.
 */
export function messageUpdatedEvent(workspaceId: string, message: TelegramMessageDto): TelegramMessageUpdatedEvent {
  return {
    type: "telegram.message.updated",
    eventId: crypto.randomUUID(),
    workspaceId,
    telegramAccountId: message.telegramAccountId,
    chatId: message.chatId,
    chatDbId: message.chatId,
    message
  };
}

/**
 * Builds a workspace-scoped realtime event for chat list ordering/preview updates.
 */
export function chatUpdatedEvent(
  workspaceId: string,
  input: {
    readonly telegramAccountId: string;
    readonly chatId: string;
    readonly lastMessagePreview: string | null;
    readonly lastMessageAt: string | null;
    readonly lastMessageDirection: "INBOUND" | "OUTBOUND" | null;
    readonly unreadCount: number;
  }
): TelegramChatUpdatedEvent {
  return {
    type: "telegram.chat.updated",
    eventId: crypto.randomUUID(),
    workspaceId,
    telegramAccountId: input.telegramAccountId,
    chatId: input.chatId,
    lastMessagePreview: input.lastMessagePreview,
    lastMessageAt: input.lastMessageAt,
    lastMessageDirection: input.lastMessageDirection,
    unreadCount: input.unreadCount
  };
}
