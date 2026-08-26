-- Decorative native-poll header message ids (sendMessage before sendPoll).
-- One poll set = header message + native poll message. Existing rows stay NULL.

ALTER TABLE "engagement_polls"
  ADD COLUMN IF NOT EXISTS "telegram_header_message_id" VARCHAR(64);

ALTER TABLE "engagement_polls"
  ADD COLUMN IF NOT EXISTS "header_theme_id" VARCHAR(32);
