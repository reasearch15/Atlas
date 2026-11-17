import threading
import uuid

from .errors import TelegramDeliveryError


class MockTelegramTransport:
    def __init__(self, fail_first: bool = False) -> None:
        self.fail_first = fail_first
        self.attempts = 0
        self.sent: dict[str, dict[str, object]] = {}
        self._lock = threading.Lock()

    def send_qr(
        self,
        *,
        delivery_key: str,
        chat_id: str,
        player_id: str,
        amount_cents: int,
        provider_id: str,
        payload: str,
        qr_png: bytes,
    ) -> str:
        with self._lock:
            existing = self.sent.get(delivery_key)
            if existing:
                return str(existing["message_id"])
            self.attempts += 1
            if self.fail_first and self.attempts == 1:
                raise TelegramDeliveryError("mock Telegram delivery failure")
            message_id = f"mock-message-{uuid.uuid4().hex}"
            self.sent[delivery_key] = {
                "message_id": message_id,
                "chat_id": chat_id,
                "player_id": player_id,
                "amount_cents": amount_cents,
                "provider_id": provider_id,
                "payload": payload,
                "qr_png": qr_png,
            }
            return message_id
