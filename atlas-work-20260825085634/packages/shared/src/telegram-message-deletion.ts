/**
 * Soft-delete tombstone helpers for Telegram messages removed from Atlas.
 * Preserves audit metadata while scrubbing message body and media pointers.
 */

export const TELEGRAM_MESSAGE_TOMBSTONE_TEXT = "";

export type SoftDeleteMessageFields = {
  readonly textContent: string;
  readonly caption: null;
  readonly mediaStorageKey: null;
  readonly thumbnailStorageKey: null;
  readonly mediaDownloadState: "NONE";
  readonly mediaUploadState: "NONE";
  readonly mediaError: null;
  readonly waveformJson: null;
  readonly mediaMetadataJson: {
    readonly tombstone: true;
    readonly deletedAt: string;
    readonly deletionScope: "EVERYONE" | "ATLAS_ONLY";
    readonly originalContentType: string;
  };
};

/**
 * Builds Prisma-ready tombstone fields after a successful deletion.
 */
export function buildMessageTombstoneFields(input: {
  readonly deletedAt: Date;
  readonly deletionScope: "EVERYONE" | "ATLAS_ONLY";
  readonly originalContentType: string;
}): SoftDeleteMessageFields {
  return {
    textContent: TELEGRAM_MESSAGE_TOMBSTONE_TEXT,
    caption: null,
    mediaStorageKey: null,
    thumbnailStorageKey: null,
    mediaDownloadState: "NONE",
    mediaUploadState: "NONE",
    mediaError: null,
    waveformJson: null,
    mediaMetadataJson: {
      tombstone: true,
      deletedAt: input.deletedAt.toISOString(),
      deletionScope: input.deletionScope,
      originalContentType: input.originalContentType
    }
  };
}

/**
 * True when a message row should be hidden from the inbox conversation timeline.
 */
export function isSoftDeletedTelegramMessage(input: {
  readonly deletedAt?: Date | string | null;
  readonly isDeleted?: boolean | null;
}): boolean {
  if (input.isDeleted) return true;
  return Boolean(input.deletedAt);
}
