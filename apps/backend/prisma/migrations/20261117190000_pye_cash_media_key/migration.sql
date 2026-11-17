-- Stores the private PNG key so a Telegram retry can reuse the same invoice image.

ALTER TABLE "pye_cash_invoices"
  ADD COLUMN "media_storage_key" VARCHAR(512);
