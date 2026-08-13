-- Additive: MANUAL_ADJUSTMENT event type for ACTIVE deposit-scoring reconciliation.
-- Does not rewrite historical DEPOSIT events or frozen snapshots.

ALTER TYPE "LeaderboardEventType" ADD VALUE IF NOT EXISTS 'MANUAL_ADJUSTMENT';
