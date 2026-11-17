import threading
import uuid
from datetime import datetime, timedelta, timezone

from .errors import (
    AmbiguousCreationError,
    InvalidProviderResponseError,
    ProviderTimeoutError,
    ProviderUnavailableError,
)
from .models import ProviderInvoice


class MockPyeCashProvider:
    """Synthetic provider. It never calls the network or creates payable data."""

    def __init__(self, behavior: str = "success") -> None:
        self.behavior = behavior
        self.creation_count = 0
        self.created: list[ProviderInvoice] = []
        self._lock = threading.Lock()

    def create_invoice(self, amount_cents: int, operation_key: str) -> ProviderInvoice:
        with self._lock:
            if self.behavior == "unavailable":
                raise ProviderUnavailableError("mock provider unavailable")
            if self.behavior == "timeout_before_creation":
                raise ProviderTimeoutError("mock timeout before creation")

            invoice = self._new_invoice(amount_cents, operation_key)
            self.creation_count += 1
            self.created.append(invoice)

            if self.behavior == "ambiguous_after_creation":
                raise AmbiguousCreationError("mock response lost after creation")
            if self.behavior == "invalid_response":
                return ProviderInvoice("", amount_cents, "", "")
            return invoice

    @staticmethod
    def validate(invoice: ProviderInvoice) -> None:
        if (
            not invoice.provider_id
            or not invoice.payload.startswith("PYECASH-POC-NONPAYABLE:")
            or not invoice.expires_at
        ):
            raise InvalidProviderResponseError("mock provider response is incomplete")

    def _new_invoice(self, amount_cents: int, operation_key: str) -> ProviderInvoice:
        provider_id = uuid.uuid4().hex[:16]
        expires_at = (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat()
        payload = (
            "PYECASH-POC-NONPAYABLE:"
            f"id={provider_id};cents={amount_cents};exp={expires_at};nonce={uuid.uuid4().hex[:8]}"
        )
        return ProviderInvoice(
            provider_id=provider_id,
            amount_cents=amount_cents,
            payload=payload,
            expires_at=expires_at,
        )
