# Inbox sync, unread, identity, media — investigation & fix notes

Production: https://platform.atlast.work

## Source of truth

| Concern | Authoritative source |
|--------|----------------------|
| Conversation unread badge | PostgreSQL `telegram_chats.unread_count` after Atlas mark-read; Telegram dialog unread only adopted on create or when `dialog.topMessageId > last_read_telegram_message_id` |
| Contact title | Worker `buildCrmContactDisplayTitle` + REST `toChatDto`; WS `telegram.chat.updated` must carry the same identity fields |
| Media bytes | MinIO object at `media_storage_key`; DB key written **only after** upload succeeds |
| List order | UI: pinned → needs attention → `lastMessageAt` DESC → `id` ASC; REST: pinned → `lastMessageAt` DESC → `id` ASC |

## Root causes (confirmed in code)

1. **Photos blank** — Migrated DB keys without MinIO objects; signed URLs 404; UI had no `onError` / UNAVAILABLE. INITIAL_SYNC left media `PENDING` without download. Delivery WS events wiped `mediaUrl` via merge.
2. **Unread returns after refresh** — `clearUnread` was UI-only; no `/read` API; `INITIAL_SYNC` overwrote `unreadCount` from `dialog.unreadCount`.
3. **Unknown User live** — `telegram.chat.updated` omitted title/name/username; identity backfill did not broadcast.
4. **Order wrong until refresh** — WS omitted `needsCrmAttention` / identity; merge did not upgrade titles.
5. **Service chats** — partially fixed earlier; cleanup script + safer “Telegram” name heuristic added.

## Deploy

1. `pnpm db:migrate:deploy` (adds `MARK_CHAT_READ`, `UNAVAILABLE`, read columns)
2. Deploy backend, worker, frontend
3. Dry-run `pnpm --filter @atlas/backend cleanup:telegram` then `CONFIRM_CLEANUP=YES pnpm --filter @atlas/backend cleanup:telegram`
4. Run `pnpm --filter @atlas/backend inbox:diagnostics` against prod (counts only)
5. Mirror MinIO if needed — see `docs/minio-media-migration.md`
6. Trigger media backfill for accounts with missing objects

## Rollback

1. Redeploy previous release artifacts
2. Migration adds nullable columns / enum values — forward-compatible; no destructive down migration required for emergency rollback of app code

## Production verification checklist

- [ ] New inbound photo downloads and renders
- [ ] Old missing object shows “Media unavailable” (not broken image)
- [ ] Open chat → refresh → unread stays 0
- [ ] New contact with username never stuck as Unknown User after WS
- [ ] List order matches refresh
- [ ] Service peer 777000 absent from inbox
