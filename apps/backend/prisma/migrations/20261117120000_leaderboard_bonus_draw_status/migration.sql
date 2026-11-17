-- Existing competitions, including historical finalized rounds, stay COMPLETE
-- so this migration does not reopen or redraw any freeplay award.
CREATE TYPE "LeaderboardBonusDrawStatus" AS ENUM ('PENDING', 'COMPLETE');

ALTER TABLE "leaderboard_competitions"
  ADD COLUMN "bonus_draw_status" "LeaderboardBonusDrawStatus" NOT NULL DEFAULT 'COMPLETE';
