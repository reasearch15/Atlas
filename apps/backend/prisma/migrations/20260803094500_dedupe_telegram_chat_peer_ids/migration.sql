-- Deduplicate Telegram chats stored under unmarked vs marked peer ids
-- (e.g. 1974352571 vs -1001974352571 for channels, 5467746352 vs -5467746352 for groups).
-- Unique constraint on (telegram_account_id, telegram_chat_id) already exists and is preserved.

CREATE OR REPLACE FUNCTION atlas_marked_telegram_chat_id(chat_id text, chat_type text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF chat_id IS NULL OR btrim(chat_id) = '' THEN
    RETURN chat_id;
  END IF;
  IF chat_id ~ '^-100[0-9]+$' THEN
    RETURN chat_id;
  END IF;
  IF chat_id ~ '^-[0-9]+$' THEN
    RETURN chat_id;
  END IF;
  IF chat_id ~ '^[0-9]+$' THEN
    IF upper(chat_type) IN ('CHANNEL', 'SUPERGROUP') THEN
      RETURN '-100' || chat_id;
    END IF;
    IF upper(chat_type) = 'GROUP' THEN
      RETURN '-' || chat_id;
    END IF;
  END IF;
  RETURN chat_id;
END;
$$;

DO $$
DECLARE
  merged_groups integer := 0;
  deleted_chats integer := 0;
  rewritten_ids integer := 0;
BEGIN
  CREATE TEMP TABLE tmp_chat_dupe_groups ON COMMIT DROP AS
  SELECT
    telegram_account_id,
    atlas_marked_telegram_chat_id(telegram_chat_id, chat_type::text) AS marked_id,
    array_agg(id ORDER BY
      CASE WHEN telegram_chat_id = atlas_marked_telegram_chat_id(telegram_chat_id, chat_type::text) THEN 0 ELSE 1 END,
      CASE WHEN last_message_at IS NULL THEN 1 ELSE 0 END,
      last_message_at DESC NULLS LAST,
      updated_at DESC,
      created_at DESC
    ) AS chat_ids
  FROM telegram_chats
  GROUP BY telegram_account_id, atlas_marked_telegram_chat_id(telegram_chat_id, chat_type::text)
  HAVING COUNT(*) > 1;

  SELECT COUNT(*) INTO merged_groups FROM tmp_chat_dupe_groups;

  CREATE TEMP TABLE tmp_chat_merge_map ON COMMIT DROP AS
  SELECT
    telegram_account_id,
    marked_id,
    chat_ids[1] AS keep_id,
    unnest(chat_ids[2:array_length(chat_ids, 1)]) AS drop_id
  FROM tmp_chat_dupe_groups;

  -- Drop message rows that would collide on the unique (account, chat_id, message_id) after merge.
  DELETE FROM telegram_messages m
  USING tmp_chat_merge_map map
  WHERE m.telegram_chat_db_id = map.drop_id
    AND EXISTS (
      SELECT 1
      FROM telegram_messages keep
      WHERE keep.telegram_chat_db_id = map.keep_id
        AND keep.telegram_account_id = m.telegram_account_id
        AND keep.telegram_message_id = m.telegram_message_id
    );

  UPDATE telegram_messages m
  SET
    telegram_chat_db_id = map.keep_id,
    telegram_chat_id = map.marked_id
  FROM tmp_chat_merge_map map
  WHERE m.telegram_chat_db_id = map.drop_id;

  UPDATE telegram_outbound_commands c
  SET
    telegram_chat_db_id = map.keep_id,
    telegram_chat_id = map.marked_id
  FROM tmp_chat_merge_map map
  WHERE c.telegram_chat_db_id = map.drop_id;

  -- Merge scalar fields from each duplicate onto the kept row (still using original chat ids).
  UPDATE telegram_chats keep
  SET
    title = CASE
      WHEN keep.title IS NULL OR btrim(keep.title) = '' OR keep.title ~* '^unknown(\\s|$)' OR keep.title = keep.telegram_chat_id
        THEN COALESCE(NULLIF(btrim(drop_chat.title), ''), keep.title)
      ELSE keep.title
    END,
    username = COALESCE(keep.username, drop_chat.username),
    first_name = COALESCE(keep.first_name, drop_chat.first_name),
    last_name = COALESCE(keep.last_name, drop_chat.last_name),
    is_bot = keep.is_bot OR drop_chat.is_bot,
    photo_metadata = COALESCE(keep.photo_metadata, drop_chat.photo_metadata),
    chat_type = CASE WHEN keep.chat_type::text = 'UNKNOWN' THEN drop_chat.chat_type ELSE keep.chat_type END,
    unread_count = GREATEST(keep.unread_count, drop_chat.unread_count),
    is_pinned = keep.is_pinned OR drop_chat.is_pinned,
    is_archived = keep.is_archived AND drop_chat.is_archived,
    last_message_id = CASE
      WHEN keep.last_message_at IS NULL THEN drop_chat.last_message_id
      WHEN drop_chat.last_message_at IS NULL THEN keep.last_message_id
      WHEN drop_chat.last_message_at > keep.last_message_at THEN drop_chat.last_message_id
      ELSE keep.last_message_id
    END,
    last_message_preview = CASE
      WHEN keep.last_message_at IS NULL THEN drop_chat.last_message_preview
      WHEN drop_chat.last_message_at IS NULL THEN keep.last_message_preview
      WHEN drop_chat.last_message_at > keep.last_message_at THEN drop_chat.last_message_preview
      ELSE keep.last_message_preview
    END,
    last_message_at = CASE
      WHEN keep.last_message_at IS NULL THEN drop_chat.last_message_at
      WHEN drop_chat.last_message_at IS NULL THEN keep.last_message_at
      WHEN drop_chat.last_message_at > keep.last_message_at THEN drop_chat.last_message_at
      ELSE keep.last_message_at
    END,
    updated_at = NOW()
  FROM tmp_chat_merge_map map
  JOIN telegram_chats drop_chat ON drop_chat.id = map.drop_id
  WHERE keep.id = map.keep_id;

  DELETE FROM telegram_chats c
  USING tmp_chat_merge_map map
  WHERE c.id = map.drop_id;

  GET DIAGNOSTICS deleted_chats = ROW_COUNT;

  -- Now safe to rewrite kept + remaining rows to marked peer ids.
  UPDATE telegram_chats
  SET telegram_chat_id = atlas_marked_telegram_chat_id(telegram_chat_id, chat_type::text),
      updated_at = NOW()
  WHERE telegram_chat_id IS DISTINCT FROM atlas_marked_telegram_chat_id(telegram_chat_id, chat_type::text);

  GET DIAGNOSTICS rewritten_ids = ROW_COUNT;

  UPDATE telegram_messages m
  SET telegram_chat_id = c.telegram_chat_id
  FROM telegram_chats c
  WHERE m.telegram_chat_db_id = c.id
    AND m.telegram_chat_id IS DISTINCT FROM c.telegram_chat_id;

  UPDATE telegram_outbound_commands o
  SET telegram_chat_id = c.telegram_chat_id
  FROM telegram_chats c
  WHERE o.telegram_chat_db_id = c.id
    AND o.telegram_chat_id IS DISTINCT FROM c.telegram_chat_id;

  RAISE NOTICE 'telegram chat dedupe: groups=%, deleted_duplicates=%, rewritten_ids=%',
    merged_groups, deleted_chats, rewritten_ids;
END;
$$;

-- Unique constraint already exists from foundation migration:
-- telegram_chats_telegram_account_id_telegram_chat_id_key
-- Verified present; do not recreate.

DROP FUNCTION IF EXISTS atlas_marked_telegram_chat_id(text, text);
