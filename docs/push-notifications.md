# Push notification reliability (enterprise)

Atlas treats customer-message push as **eventually consistent durable delivery**, not best-effort fire-and-forget.

## Reliability model

```
NotificationService.notify*(…)
  → INSERT push_notifications (Postgres, durable)
  → append notification_delivery_logs (lifecycle events)
  → BullMQ wake-up (delay / retry)
  → worker DISPATCHING → FCM
  → SENT | RETRY_SCHEDULED | INVALID_TOKEN | EXPIRED
```

- **Source of truth:** `push_notifications` table (survives backend/worker restarts)
- **BullMQ:** wake-up only — losing a Redis job does not lose the notification
- **On startup:** `resumePendingNotifications()` re-wakes due rows
- **Offline / no device:** row stays `QUEUED` with `device_token_id = null` until register/reconcile
- **TTL:** `NOTIFICATION_TTL_HOURS` (default 168 = 7 days)

## Lifecycle states

`QUEUED → DISPATCHING → SENT → DELIVERED → OPENED / DISMISSED`

Failure path: `RETRY_SCHEDULED` (backoff) → eventually `SENT` or `EXPIRED` / `INVALID_TOKEN` / `FAILED` / `CANCELLED`

## Retry policy

30s → 2m → 5m → 15m → 30m → 1h (then hold at 1h until expiry)

## Uniqueness / no grouping

- Every row has a UUID `id`
- Android/Web tag = `atlas-n-{id}` (never reused, never collapsed)
- Idempotency key = `{type}:{eventKey}:{userId}:{deviceTokenId}`

## Multi-device

Each registered device gets its own `push_notifications` row. Delivery to one device never suppresses another.

## Client ack + actions

| Endpoint | Purpose |
|----------|---------|
| `POST /api/notifications/:id/ack` | `delivered` / `opened` / `dismissed` |
| `POST /api/notifications/:id/actions` | `open` / `mark_read` / `claim` |
| `GET /api/notifications/history` | User history filters |
| `POST /api/notifications/reconcile` | Catch up after reconnect |
| `GET /api/notifications/admin/analytics` | Latency / open / failure rates |

Service worker posts ack/action messages to the app; notifications use `requireInteraction: true` so they stay until the user interacts.

## Reconciliation triggers

- Device register / token refresh
- App online / visibility restore
- Backend startup maintenance loop (every 60s)

## Favor reliability

If minimizing noise conflicts with never missing a customer message, Atlas keeps the notification pending and retries.

## Content Security Policy (FCM web)

CSP is generated in `apps/frontend/next.config.ts` via `buildAtlasConnectSrc()`.

`connect-src` must allow the hosts the Firebase Messaging JS SDK actually calls
(verified in `@firebase/installations` + `@firebase/messaging`):

| Origin | Why |
|--------|-----|
| `https://firebaseinstallations.googleapis.com` | Installation ID before `getToken()` |
| `https://fcmregistrations.googleapis.com` | Web FCM token registration |
| `https://play.google.com` | Optional SW delivery telemetry |

Without these, Chrome blocks registration (`Connecting to firebaseinstallations.googleapis.com violates Content Security Policy`) and `PushBootstrap` never obtains a token. Do **not** widen to `*.googleapis.com`.
