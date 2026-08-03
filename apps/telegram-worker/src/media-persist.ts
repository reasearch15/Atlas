import type { Prisma } from "@prisma/client";
import type { NormalizedTextMessage } from "./telegram-client";

/**
 * Builds Prisma media column values without `undefined` (exactOptionalPropertyTypes).
 */
export function mediaPersistFields(message: NormalizedTextMessage): {
  caption: string | null;
  mimeType: string | null;
  fileName: string | null;
  fileSizeBytes: number | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  waveformJson?: Prisma.InputJsonValue;
  mediaMetadataJson: Prisma.InputJsonValue;
  mediaDownloadState: "PENDING" | "NONE";
  mediaUploadState: "PENDING" | "NONE";
} {
  const base = {
    caption: message.caption,
    mimeType: message.mimeType,
    fileName: message.fileName,
    fileSizeBytes: message.fileSizeBytes,
    width: message.width,
    height: message.height,
    durationSeconds: message.durationSeconds,
    mediaMetadataJson: message.mediaMetadata as Prisma.InputJsonValue,
    mediaDownloadState: message.needsBinaryDownload ? ("PENDING" as const) : ("NONE" as const),
    mediaUploadState: message.needsBinaryDownload ? ("PENDING" as const) : ("NONE" as const)
  };
  if (message.waveform) {
    return { ...base, waveformJson: message.waveform as Prisma.InputJsonValue };
  }
  return base;
}
