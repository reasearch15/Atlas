-- AlterTable
ALTER TABLE "telegram_chats" ADD COLUMN IF NOT EXISTS "first_name" VARCHAR(120);
ALTER TABLE "telegram_chats" ADD COLUMN IF NOT EXISTS "last_name" VARCHAR(120);
ALTER TABLE "telegram_chats" ADD COLUMN IF NOT EXISTS "is_bot" BOOLEAN NOT NULL DEFAULT false;
