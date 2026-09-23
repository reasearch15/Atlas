-- Persist public winner-result Telegram delivery confirmation.
ALTER TYPE "LeaderboardTelegramArtifactType" ADD VALUE IF NOT EXISTS 'PUBLIC_RESULTS';
