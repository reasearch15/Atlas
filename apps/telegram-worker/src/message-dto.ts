import {
  buildTelegramMessageMediaPath,
  contentTypeToMediaType,
  type TelegramContentType,
  type TelegramMediaDownloadState,
  type TelegramMessageDto,
  type TelegramMessageMediaTypeDto
} from "@atlas/shared";

type MessageRow = {
  readonly id: string;
  readonly telegramAccountId: string;
  readonly telegramChatDbId: string;
  readonly telegramMessageId: string;
  readonly senderTelegramUserId: string | null;
  readonly direction: "INBOUND" | "OUTBOUND";
  readonly contentType: TelegramContentType | string;
  readonly textContent: string;
  readonly caption?: string | null;
  readonly mimeType?: string | null;
  readonly fileName?: string | null;
  readonly fileSizeBytes?: bigint | number | null;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly durationSeconds?: number | null;
  readonly waveformJson?: unknown;
  readonly mediaMetadataJson?: unknown;
  readonly mediaDownloadState?: TelegramMediaDownloadState | string | null;
  readonly mediaUploadState?: TelegramMediaDownloadState | string | null;
  readonly mediaError?: string | null;
  readonly mediaStorageKey?: string | null;
  readonly thumbnailStorageKey?: string | null;
  readonly replyToTelegramMessageId: string | null;
  readonly telegramCreatedAt: Date;
  readonly telegramEditedAt: Date | null;
  readonly internalSenderUserId: string | null;
  readonly internalSenderSessionId?: string | null;
  readonly internalSenderRole?: string | null;
  readonly internalSenderName?: string | null;
  readonly sendStatus: string;
};

type ChatIdentityHint = {
  readonly direction?: "INBOUND" | "OUTBOUND";
  readonly chatTitle: string | null;
  readonly chatType: string;
  readonly chatUsername: string | null;
};

type MediaUrlHints = {
  readonly mediaUrl?: string | null;
  readonly thumbnailUrl?: string | null;
};

/**
 * Maps a persisted Telegram message row into the shared API DTO.
 */
export function toTelegramMessageDto(
  message: MessageRow,
  chat: ChatIdentityHint,
  urls: MediaUrlHints = {}
): TelegramMessageDto {
  const direction = chat.direction ?? message.direction;
  const contentType = (message.contentType || "TEXT") as TelegramContentType;
  const metadata =
    message.mediaMetadataJson && typeof message.mediaMetadataJson === "object" && !Array.isArray(message.mediaMetadataJson)
      ? (message.mediaMetadataJson as Record<string, unknown>)
      : null;
  const webPreviewRaw = metadata?.webPreview;
  const webPreview =
    webPreviewRaw && typeof webPreviewRaw === "object" && !Array.isArray(webPreviewRaw)
      ? {
          url: typeof (webPreviewRaw as { url?: unknown }).url === "string" ? (webPreviewRaw as { url: string }).url : "",
          title:
            typeof (webPreviewRaw as { title?: unknown }).title === "string"
              ? ((webPreviewRaw as { title: string }).title ?? null)
              : null,
          description:
            typeof (webPreviewRaw as { description?: unknown }).description === "string"
              ? ((webPreviewRaw as { description: string }).description ?? null)
              : null
        }
      : null;

  return {
    id: message.id,
    telegramAccountId: message.telegramAccountId,
    chatId: message.telegramChatDbId,
    telegramMessageId: message.telegramMessageId,
    direction,
    contentType,
    mediaType: contentTypeToMediaType(contentType) as TelegramMessageMediaTypeDto,
    text: message.textContent,
    caption: message.caption ?? null,
    mimeType: message.mimeType ?? null,
    fileName: message.fileName ?? null,
    fileSizeBytes: message.fileSizeBytes == null ? null : Number(message.fileSizeBytes),
    width: message.width ?? null,
    height: message.height ?? null,
    durationSeconds: message.durationSeconds ?? null,
    waveform: Array.isArray(message.waveformJson) ? (message.waveformJson as number[]) : null,
    mediaMetadata: metadata,
    mediaUrl:
      urls.mediaUrl ??
      (message.mediaStorageKey && message.mediaDownloadState === "STORED"
        ? buildTelegramMessageMediaPath(message.id, "media")
        : null),
    thumbnailUrl:
      urls.thumbnailUrl ??
      (message.thumbnailStorageKey ? buildTelegramMessageMediaPath(message.id, "thumbnail") : null),
    mediaDownloadState: (message.mediaDownloadState as TelegramMessageDto["mediaDownloadState"]) ?? "NONE",
    mediaUploadState: (message.mediaUploadState as TelegramMessageDto["mediaUploadState"]) ?? "NONE",
    mediaError: message.mediaError ?? null,
    sentAt: message.telegramCreatedAt.toISOString(),
    editedAt: message.telegramEditedAt?.toISOString() ?? null,
    isEdited: Boolean(message.telegramEditedAt),
    isDeleted: false,
    senderTelegramUserId: message.senderTelegramUserId,
    senderDisplayName: resolveSenderDisplayName(direction, chat),
    replyToTelegramMessageId: message.replyToTelegramMessageId,
    replyPreview: null,
    webPreview: webPreview && webPreview.url ? webPreview : null,
    internalSenderUserId: message.internalSenderUserId,
    internalSenderSessionId: message.internalSenderSessionId ?? null,
    internalSenderRole: (message.internalSenderRole as TelegramMessageDto["internalSenderRole"]) ?? null,
    internalSenderName: message.internalSenderName ?? null,
    attributionSource: message.internalSenderUserId
      ? "ATLAS"
      : direction === "OUTBOUND"
        ? "TELEGRAM_EXTERNAL"
        : null,
    sendStatus: message.sendStatus
  };
}

function resolveSenderDisplayName(direction: "INBOUND" | "OUTBOUND", chat: ChatIdentityHint): string | null {
  if (direction === "OUTBOUND") return "You";
  const title = chat.chatTitle?.trim() ?? "";
  if (title && !/^-?\d{5,}$/.test(title) && !/^unknown(\s|$)/i.test(title)) {
    const kind = chat.chatType;
    if (kind === "PRIVATE" || kind === "UNKNOWN" || (chat.chatUsername ?? "").toLowerCase().endsWith("bot")) {
      return title;
    }
  }
  return null;
}
