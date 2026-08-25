-- Persist GramJS InputPeer reconstruction fields on synchronized chats

ALTER TABLE "telegram_chats"
  ADD COLUMN IF NOT EXISTS "access_hash" VARCHAR(80),
  ADD COLUMN IF NOT EXISTS "peer_type" VARCHAR(16),
  ADD COLUMN IF NOT EXISTS "peer_phone" VARCHAR(32);
