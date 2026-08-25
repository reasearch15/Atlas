# Inbox sync, unread, identity, media — investigation & fix notes

Production: https://platform.atlast.work

## Source of truth

| Concern | Authoritative source |
|--------|----------------------|
| Conversation unread badge | PostgreSQL `telegram_chats.unread_count` after Atlas mark-read; Telegram dialog unread only adopted on create or when `dialog.topMessageId > last_read_telegram_message_id` |
| Contact title | Worker `buildCrmContactDisplayTitle` + REST `toChatDto`; WS `telegram.chat.updated` must carry the same identity fields |
| Media bytes | MinIO object at `media_storage_key`; **browser delivery** via authenticated Atlas proxy (never private MinIO URLs) |
| List order | UI: pinned → needs attention → `lastMessageAt` DESC → `id` ASC; REST: pinned → `lastMessageAt` DESC → `id` ASC |

## Media delivery (authenticated proxy)

**Root cause:** DTOs previously returned MinIO presigned GET URLs for `S3_ENDPOINT=http://127.0.0.1:9000`. Browsers resolve `127.0.0.1` to the user’s device → `ERR_CONNECTION_REFUSED`. Affects every Telegram media type stored in MinIO.

**Fix:** Keep MinIO private. Stream through:

- `GET /api/telegram/messages/:messageId/media`
- `GET /api/telegram/messages/:messageId/thumbnail`
- `GET /api/telegram/messages/:messageId/media-access?variant=media|thumbnail` (mints HMAC `?access=` ticket for `<img>`/`<video>`/`<audio>`)

DTO / WebSocket `mediaUrl` / `thumbnailUrl` are same-origin `/api/telegram/messages/...` paths (REST may include short-lived `access` tickets). Never `localhost`, `:9000`, or `X-Amz-*`.

Nginx: dedicated `/api/telegram/messages/` location with `proxy_buffering off` and long read timeouts. Do not proxy MinIO publicly.

## Root causes (confirmed in code)

1. **Photos / all media blank** — Signed URLs pointed at private MinIO; also migrated DB keys without objects; UI lacked UNAVAILABLE handling; WS null `mediaUrl` wiped good URLs.
2. **Unread returns after refresh** — `clearUnread` was UI-only; no `/read` API; `INITIAL_SYNC` overwrote `unreadCount` from `dialog.unreadCount`.
3. **Raw numeric / Unknown User live** — `buildCrmContactDisplayTitle` fell back to naked `telegramChatId`; NewMessage entity was unused before upsert; identity backfill updated DB without WS. Fixed: `"Telegram user <peerId>"` fallback, event-entity + resolve before emit, deferred improve + backfill publish `telegram.chat.updated`.
4. **Order wrong until refresh** — WS omitted `needsCrmAttention` / identity; merge did not upgrade titles.
5. **Service chats** — partially fixed earlier; cleanup script + safer “Telegram” name heuristic added.

## Deploy

1. `pnpm db:migrate:deploy` (adds `MARK_CHAT_READ`, `UNAVAILABLE`, read columns)
2. Deploy backend, worker, frontend; reload Nginx from `deploy/nginx/atlas.conf.template`
3. Dry-run `pnpm --filter @atlas/backend cleanup:telegram` then `CONFIRM_CLEANUP=YES pnpm --filter @atlas/backend cleanup:telegram`
4. Run `pnpm --filter @atlas/backend inbox:diagnostics` against prod (counts only)
5. Mirror MinIO if needed — see `docs/minio-media-migration.md`
6. Trigger media backfill for accounts with missing objects

## Rollback

1. Redeploy previous release artifacts
2. Migration adds nullable columns / enum values — forward-compatible; no destructive down migration required for emergency rollback of app code

## Production verification checklist

### Media proxy (all types — required)

Browser Network must only hit `https://platform.atlast.work/api/...` (no `127.0.0.1`, `localhost`, `:9000`, `X-Amz-Signature`).

- [ ] Inbound PHOTO renders; full-size open works
- [ ] Inbound VIDEO plays; seeking works (HTTP 206 Range)
- [ ] Inbound VIDEO_NOTE circular playback + seeking
- [ ] Inbound VOICE waveform + seeking
- [ ] Inbound AUDIO player + seeking
- [ ] Inbound DOCUMENT downloads with safe filename
- [ ] Inbound ANIMATION / GIF loops
- [ ] Inbound STICKER (WebP transparency)
- [ ] Thumbnails load via `/thumbnail` (or ticketed proxy)
- [ ] Outbound send of each type above; refresh still loads via proxy
- [ ] After media.ready WS, no page refresh required
- [ ] Unauthorized user → 401/403; missing object → unavailable UI (no storage key leak)
- [ ] MinIO remains bound to `127.0.0.1:9000` only

### Other inbox checks

- [ ] Old missing object shows “Media unavailable” (not broken image)
- [ ] Open chat → refresh → unread stays 0
- [ ] New contact with username never stuck as Unknown User after WS
- [ ] List order matches refresh
- [ ] Service peer 777000 absent from inbox
