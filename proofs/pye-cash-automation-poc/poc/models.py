from dataclasses import dataclass


@dataclass(frozen=True)
class ProviderInvoice:
    provider_id: str
    amount_cents: int
    payload: str
    expires_at: str


@dataclass(frozen=True)
class InvoiceRecord:
    operation_key: str
    player_id: str
    chat_id: str
    amount_cents: int
    state: str
    provider_id: str | None
    payload: str | None
    expires_at: str | None
    qr_png: bytes | None
    delivery_state: str
    telegram_message_id: str | None
    error: str | None
    payment_state: str
