-- Expand Telegram message content types and media metadata columns.

ALTER TYPE "TelegramMessageContentType" ADD VALUE IF NOT EXISTS 'PHOTO';
ALTER TYPE "TelegramMessageContentType" ADD VALUE IF NOT EXISTS 'VIDEO';
ALTER TYPE "TelegramMessageContentType" ADD VALUE IF NOT EXISTS 'VIDEO_NOTE';
ALTER TYPE "TelegramMessageContentType" ADD VALUE IF NOT EXISTS 'VOICE';
ALTER TYPE "TelegramMessageContentType" ADD VALUE IF NOT EXISTS 'AUDIO';
ALTER TYPE "TelegramMessageContentType" ADD VALUE IF NOT EXISTS 'DOCUMENT';
ALTER TYPE "TelegramMessageContentType" ADD VALUE IF NOT EXISTS 'ANIMATION';
ALTER TYPE "TelegramMessageContentType" ADD VALUE IF NOT EXISTS 'STICKER';
ALTER TYPE "TelegramMessageContentType" ADD VALUE IF NOT EXISTS 'CONTACT';
ALTER TYPE "TelegramMessageContentType" ADD VALUE IF NOT EXISTS 'LOCATION';
ALTER TYPE "TelegramMessageContentType" ADD VALUE IF NOT EXISTS 'LIVE_LOCATION';
ALTER TYPE "TelegramMessageContentType" ADD VALUE IF NOT EXISTS 'POLL';
ALTER TYPE "TelegramMessageContentType" ADD VALUE IF NOT EXISTS 'DICE';
ALTER TYPE "TelegramMessageContentType" ADD VALUE IF NOT EXISTS 'OTHER';

DO $$ BEGIN
  CREATE TYPE "TelegramMediaDownloadState" AS ENUM ('NONE', 'PENDING', 'DOWNLOADING', 'STORED', 'FAILED', 'SKIPPED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TYPE "TelegramSendStatus" ADD VALUE IF NOT EXISTS 'UPLOADING';
ALTER TYPE "TelegramOutboundOperation" ADD VALUE IF NOT EXISTS 'SEND_MEDIA_MESSAGE';
ALTER TYPE "TelegramOutboundOperation" ADD VALUE IF NOT EXISTS 'MEDIA_BACKFILL';

ALTER TABLE "telegram_messages"
  ADD COLUMN IF NOT EXISTS "caption" TEXT,
  ADD COLUMN IF NOT EXISTS "mime_type" VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "file_name" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "file_size_bytes" BIGINT,
  ADD COLUMN IF NOT EXISTS "width" INTEGER,
  ADD COLUMN IF NOT EXISTS "height" INTEGER,
  ADD COLUMN IF NOT EXISTS "duration_seconds" INTEGER,
  ADD COLUMN IF NOT EXISTS "waveform_json" JSONB,
  ADD COLUMN IF NOT EXISTS "media_metadata_json" JSONB,
  ADD COLUMN IF NOT EXISTS "media_storage_key" VARCHAR(512),
  ADD COLUMN IF NOT EXISTS "thumbnail_storage_key" VARCHAR(512),
  ADD COLUMN IF NOT EXISTS "media_download_state" "TelegramMediaDownloadState" NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS "media_upload_state" "TelegramMediaDownloadState" NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS "media_error" VARCHAR(500);

CREATE INDEX IF NOT EXISTS "telegram_messages_media_download_state_idx" ON "telegram_messages"("media_download_state");
