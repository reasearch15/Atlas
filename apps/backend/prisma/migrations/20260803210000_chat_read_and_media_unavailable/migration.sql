-- Durable chat read markers + outbound MARK_CHAT_READ + UNAVAILABLE media state.

ALTER TYPE "TelegramOutboundOperation" ADD VALUE 'MARK_CHAT_READ';
ALTER TYPE "TelegramMediaDownloadState" ADD VALUE 'UNAVAILABLE';

ALTER TABLE "telegram_chats"
  ADD COLUMN "last_read_telegram_message_id" VARCHAR(80),
  ADD COLUMN "last_read_at" TIMESTAMP(3);
