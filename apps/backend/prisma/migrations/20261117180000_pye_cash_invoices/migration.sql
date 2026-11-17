-- Isolated Pye-Cash invoice requests. Not a deposit ledger.

CREATE TYPE "PyeCashCreationState" AS ENUM ('CREATING', 'READY', 'UNKNOWN', 'FAILED');
CREATE TYPE "PyeCashDeliveryState" AS ENUM ('NOT_SENT', 'QUEUED', 'SENT', 'FAILED');
CREATE TYPE "PyeCashPaymentState" AS ENUM ('UNCONFIRMED', 'PAID', 'EXPIRED', 'UNKNOWN');

CREATE TABLE "pye_cash_invoices" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "telegram_chat_db_id" UUID NOT NULL,
    "requested_by_user_id" UUID NOT NULL,
    "merchant" VARCHAR(32) NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "idempotency_key" VARCHAR(80) NOT NULL,
    "provider_invoice_id" VARCHAR(128),
    "lightning_invoice_encrypted" JSONB,
    "creation_state" "PyeCashCreationState" NOT NULL DEFAULT 'CREATING',
    "delivery_state" "PyeCashDeliveryState" NOT NULL DEFAULT 'NOT_SENT',
    "payment_state" "PyeCashPaymentState" NOT NULL DEFAULT 'UNCONFIRMED',
    "telegram_message_id" VARCHAR(80),
    "expires_at" TIMESTAMP(3),
    "error_category" VARCHAR(80),
    "status_verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "pye_cash_invoices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pye_cash_invoices_workspace_id_idempotency_key_key"
  ON "pye_cash_invoices"("workspace_id", "idempotency_key");

CREATE UNIQUE INDEX "pye_cash_invoices_provider_invoice_id_key"
  ON "pye_cash_invoices"("provider_invoice_id");

CREATE INDEX "pye_cash_invoices_chat_created_idx"
  ON "pye_cash_invoices"("workspace_id", "telegram_chat_db_id", "created_at");

ALTER TABLE "pye_cash_invoices"
  ADD CONSTRAINT "pye_cash_invoices_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "pye_cash_invoices"
  ADD CONSTRAINT "pye_cash_invoices_telegram_chat_db_id_fkey"
  FOREIGN KEY ("telegram_chat_db_id") REFERENCES "telegram_chats"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "pye_cash_invoices"
  ADD CONSTRAINT "pye_cash_invoices_requested_by_user_id_fkey"
  FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
