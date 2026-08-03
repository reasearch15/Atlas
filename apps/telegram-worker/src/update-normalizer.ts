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

export type ChatUpdatedEventInput = {
  readonly telegramAccountId: string;
  readonly chatId: string;
  readonly lastMessagePreview: string | null;
  readonly lastMessageAt: string | null;
  readonly lastMessageDirection: "INBOUND" | "OUTBOUND" | null;
  readonly unreadCount: number;
  readonly title?: string;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly username?: string | null;
  readonly phone?: string | null;
  readonly chatType?: string;
  readonly isBot?: boolean;
  readonly isPinned?: boolean;
  readonly identityResolved?: boolean;
  readonly needsCrmAttention?: boolean;
  readonly telegramChatId?: string;
};

/**
 * Builds a workspace-scoped realtime event for chat list ordering/preview/identity updates.
 */
export function chatUpdatedEvent(workspaceId: string, input: ChatUpdatedEventInput): TelegramChatUpdatedEvent {
  return {
    type: "telegram.chat.updated",
    eventId: crypto.randomUUID(),
    workspaceId,
    telegramAccountId: input.telegramAccountId,
    chatId: input.chatId,
    lastMessagePreview: input.lastMessagePreview,
    lastMessageAt: input.lastMessageAt,
    lastMessageDirection: input.lastMessageDirection,
    unreadCount: input.unreadCount,
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
    ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
    ...(input.username !== undefined ? { username: input.username } : {}),
    ...(input.phone !== undefined ? { phone: input.phone } : {}),
    ...(input.chatType !== undefined ? { chatType: input.chatType } : {}),
    ...(input.isBot !== undefined ? { isBot: input.isBot } : {}),
    ...(input.isPinned !== undefined ? { isPinned: input.isPinned } : {}),
    ...(input.identityResolved !== undefined ? { identityResolved: input.identityResolved } : {}),
    ...(input.needsCrmAttention !== undefined ? { needsCrmAttention: input.needsCrmAttention } : {}),
    ...(input.telegramChatId !== undefined ? { telegramChatId: input.telegramChatId } : {})
  };
}

/**
 * Builds chat.updated payload fields from a persisted TelegramChat row.
 */
export function chatUpdatedFieldsFromRow(chat: {
  readonly id: string;
  readonly telegramAccountId: string;
  readonly telegramChatId: string;
  readonly title: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly username: string | null;
  readonly peerPhone?: string | null;
  readonly chatType: string;
  readonly isBot: boolean;
  readonly isPinned: boolean;
  readonly unreadCount: number;
  readonly needsCrmAttention: boolean;
  readonly lastMessagePreview: string | null;
  readonly lastMessageAt: Date | null;
  readonly lastMessageDirection?: "INBOUND" | "OUTBOUND" | null;
}): ChatUpdatedEventInput {
  const identityResolved = Boolean(chat.title && !/^unknown(\s|$)/i.test(chat.title.trim()));
  return {
    telegramAccountId: chat.telegramAccountId,
    chatId: chat.id,
    lastMessagePreview: chat.lastMessagePreview,
    lastMessageAt: chat.lastMessageAt?.toISOString() ?? null,
    lastMessageDirection: chat.lastMessageDirection ?? null,
    unreadCount: chat.unreadCount,
    title: chat.title,
    firstName: chat.firstName,
    lastName: chat.lastName,
    username: chat.username,
    phone: chat.peerPhone ?? null,
    chatType: chat.chatType,
    isBot: chat.isBot,
    isPinned: chat.isPinned,
    identityResolved,
    needsCrmAttention: chat.needsCrmAttention,
    telegramChatId: chat.telegramChatId
  };
}
