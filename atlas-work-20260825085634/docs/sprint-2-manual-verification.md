# Sprint 2 Manual Verification

Use this checklist with a development Telegram user account. Do not use a production personal account while validating authorization behavior.

## Prerequisites

1. Start Docker Desktop.
2. Set a 64+ character `TELEGRAM_SESSION_ENCRYPTION_KEY` in `.env`.
3. Run:

```powershell
pnpm dev:infra
pnpm db:migrate
pnpm db:seed
pnpm dev
```

## Accounts

- Platform Admin: `admin@atlas.local`
- Acme Coadmin: `coadmin@acme.local`
- Acme Staff: `staff@acme.local`
- Globex Coadmin: `coadmin@globex.local`
- Development password: `ChangeMe123!`
- Workspace slug for Acme users: `acme`
- Workspace slug for Globex users: `globex`

## Verification

1. Sign in as Acme Coadmin and create one Telegram account.
2. Create a Telegram Developer App in Workspace Settings with the app credentials from `my.telegram.org`.
3. Connect one Telegram account from that Developer App.
4. Start authorization, submit phone, submit OTP, and submit 2FA password if Telegram requests it.
3. Confirm the account reaches `CONNECTED` and recent chats appear.
4. Restart backend and worker; confirm the account remains connected from encrypted session state.
5. Sign in as Acme Staff and open the same Telegram chat list.
6. Send a text message with the composer and confirm the recipient receives it in Telegram.
7. Send a Telegram text message into the connected account and confirm the browser updates without refresh.
8. Retry the same outbound idempotency key through the API and confirm no duplicate Telegram message is sent.
9. Sign in as Globex Coadmin and confirm Acme Telegram accounts and chats are not visible.
10. Confirm audit logs include account authorization and message send records with user and session IDs.
