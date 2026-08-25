-- Staff deposit history keyset pagination: filter by actor + type, order by created_at/id.
CREATE INDEX IF NOT EXISTS "leaderboard_events_workspace_id_actor_user_id_type_created_at_idx"
ON "leaderboard_events" ("workspace_id", "actor_user_id", "type", "created_at");

-- Coadmin board-wide deposit history keyset pagination.
CREATE INDEX IF NOT EXISTS "leaderboard_events_workspace_id_owner_coadmin_user_id_type_created_at_idx"
ON "leaderboard_events" ("workspace_id", "owner_coadmin_user_id", "type", "created_at");
