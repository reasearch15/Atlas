from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation

from .errors import AmbiguousCreationError, QrGenerationError, TelegramDeliveryError
from .models import InvoiceRecord
from .provider import MockPyeCashProvider
from .qr import generate_png
from .store import InvoiceStore
from .telegram import MockTelegramTransport


def parse_usd_to_cents(value: str) -> int:
    try:
        amount = Decimal(value)
    except (InvalidOperation, ValueError) as exc:
        raise ValueError("invalid USD amount") from exc
    if amount <= 0 or amount.as_tuple().exponent < -2:
        raise ValueError("USD amount must be positive with at most two decimals")
    cents = int(amount * 100)
    if cents > 100_000_000:
        raise ValueError("USD amount exceeds POC limit")
    return cents


class InvoiceWorkflow:
    def __init__(
        self,
        store: InvoiceStore,
        provider: MockPyeCashProvider,
        telegram: MockTelegramTransport,
        qr_generator=generate_png,
    ) -> None:
        self.store = store
        self.provider = provider
        self.telegram = telegram
        self.qr_generator = qr_generator

    def create(self, *, operation_key: str, player_id: str, chat_id: str, amount_usd: str) -> InvoiceRecord:
        amount_cents = parse_usd_to_cents(amount_usd)
        record, created = self.store.reserve(operation_key, player_id, chat_id, amount_cents)
        if not created:
            if (record.player_id, record.chat_id, record.amount_cents) != (player_id, chat_id, amount_cents):
                raise ValueError("operation key was already used with different input")
            return record
        try:
            invoice = self.provider.create_invoice(amount_cents, operation_key)
            self.provider.validate(invoice)
            qr_png = self.qr_generator(invoice.payload)
            return self.store.update(
                operation_key,
                state="READY",
                provider_id=invoice.provider_id,
                payload=invoice.payload,
                expires_at=invoice.expires_at,
                qr_png=qr_png,
                error=None,
            )
        except AmbiguousCreationError as exc:
            return self.store.update(operation_key, state="UNKNOWN", error=str(exc))
        except Exception as exc:
            state = "QR_FAILED" if isinstance(exc, QrGenerationError) else "FAILED"
            return self.store.update(operation_key, state=state, error=str(exc))

    def deliver(self, operation_key: str) -> InvoiceRecord:
        record = self.store.get(operation_key)
        if not record or record.state != "READY":
            raise ValueError("invoice is not ready for delivery")
        if record.delivery_state == "SENT":
            return record
        try:
            message_id = self.telegram.send_qr(
                delivery_key=f"invoice:{operation_key}",
                chat_id=record.chat_id,
                player_id=record.player_id,
                amount_cents=record.amount_cents,
                provider_id=record.provider_id or "",
                payload=record.payload or "",
                qr_png=record.qr_png or b"",
            )
            return self.store.update(
                operation_key,
                delivery_state="SENT",
                telegram_message_id=message_id,
                error=None,
            )
        except TelegramDeliveryError as exc:
            return self.store.update(operation_key, delivery_state="FAILED_RETRYABLE", error=str(exc))

    def expire_if_due(self, operation_key: str, now: datetime | None = None) -> InvoiceRecord:
        record = self.store.get(operation_key)
        if not record or not record.expires_at:
            raise ValueError("invoice has no expiration")
        instant = now or datetime.now(timezone.utc)
        expires = datetime.fromisoformat(record.expires_at)
        if instant >= expires and record.payment_state == "UNCONFIRMED":
            return self.store.update(operation_key, state="EXPIRED")
        return record
