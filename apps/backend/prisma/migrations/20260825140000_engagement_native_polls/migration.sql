-- Native Telegram poll identifiers for engagement (sendPoll / poll_answer / stopPoll).
-- Existing callback-button polls keep telegram_poll_id NULL and continue on the legacy close path.

ALTER TABLE "engagement_polls"
  ADD COLUMN IF NOT EXISTS "telegram_poll_id" VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS "engagement_polls_telegram_poll_id_key"
  ON "engagement_polls"("telegram_poll_id");
