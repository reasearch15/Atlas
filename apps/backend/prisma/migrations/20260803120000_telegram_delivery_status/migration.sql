-- Add DELIVERED so outbound ticks can advance past SENT when Telegram confirms a remote message id.

ALTER TYPE "TelegramSendStatus" ADD VALUE IF NOT EXISTS 'DELIVERED';
