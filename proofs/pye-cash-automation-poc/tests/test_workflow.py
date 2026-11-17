import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from poc.errors import QrGenerationError
from poc.provider import MockPyeCashProvider
from poc.qr import decode_png, generate_png
from poc.service import InvoiceWorkflow, parse_usd_to_cents
from poc.store import InvoiceStore
from poc.telegram import MockTelegramTransport


class WorkflowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.db = Path(self.temp.name) / "poc.sqlite"
        self.provider = MockPyeCashProvider()
        self.telegram = MockTelegramTransport()
        self.service = InvoiceWorkflow(InvoiceStore(self.db), self.provider, self.telegram)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def create(self, key: str = "op-1", amount: str = "10.00"):
        return self.service.create(operation_key=key, player_id="player-7", chat_id="chat-9", amount_usd=amount)

    def test_fresh_invoices_are_distinct_and_qrs_round_trip(self):
        first = self.create("op-a")
        second = self.create("op-b")
        self.assertEqual((first.state, second.state), ("READY", "READY"))
        self.assertNotEqual(first.provider_id, second.provider_id)
        self.assertNotEqual(first.qr_png, second.qr_png)
        self.assertEqual(decode_png(first.qr_png or b""), first.payload)
        self.assertEqual(decode_png(second.qr_png or b""), second.payload)
        self.assertIn(f"exp={first.expires_at}", first.payload or "")

    def test_duplicate_click_uses_one_provider_invoice(self):
        first = self.create("same-operation")
        second = self.create("same-operation")
        self.assertEqual(first.provider_id, second.provider_id)
        self.assertEqual(self.provider.creation_count, 1)

    def test_concurrent_staff_requests_with_same_key_create_once(self):
        results = []
        barrier = threading.Barrier(2)
        def request():
            barrier.wait()
            results.append(self.create("concurrent"))
        threads = [threading.Thread(target=request) for _ in range(2)]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        self.assertEqual(len(results), 2)
        self.assertEqual(self.provider.creation_count, 1)
        self.assertEqual(results[0].operation_key, results[1].operation_key)

    def test_provider_unavailable_is_persisted_without_retry(self):
        self.provider.behavior = "unavailable"
        record = self.create("unavailable")
        self.assertEqual(record.state, "FAILED")
        self.assertEqual(self.provider.creation_count, 0)
        self.assertEqual(self.create("unavailable").state, "FAILED")

    def test_timeout_before_creation_is_persisted(self):
        self.provider.behavior = "timeout_before_creation"
        record = self.create("timeout-before")
        self.assertEqual(record.state, "FAILED")
        self.assertEqual(self.provider.creation_count, 0)

    def test_lost_response_becomes_unknown_and_is_never_retried(self):
        self.provider.behavior = "ambiguous_after_creation"
        first = self.create("ambiguous")
        second = self.create("ambiguous")
        self.assertEqual((first.state, second.state), ("UNKNOWN", "UNKNOWN"))
        self.assertEqual(self.provider.creation_count, 1)

    def test_invalid_provider_response_is_rejected(self):
        self.provider.behavior = "invalid_response"
        record = self.create("invalid")
        self.assertEqual(record.state, "FAILED")
        self.assertIsNone(record.qr_png)

    def test_qr_generation_failure_is_persisted(self):
        def broken(_: str) -> bytes:
            raise QrGenerationError("synthetic QR failure")
        service = InvoiceWorkflow(InvoiceStore(self.db), self.provider, self.telegram, qr_generator=broken)
        record = service.create(operation_key="qr-fail", player_id="player-7", chat_id="chat-9", amount_usd="10")
        self.assertEqual(record.state, "QR_FAILED")

    def test_invalid_or_payable_looking_payload_is_rejected(self):
        with self.assertRaises(QrGenerationError): generate_png("")
        with self.assertRaises(QrGenerationError): generate_png("lnbc-not-allowed-in-this-poc")

    def test_telegram_delivery_targets_correct_player_and_is_idempotent(self):
        ready = self.create("deliver")
        sent = self.service.deliver("deliver")
        repeated = self.service.deliver("deliver")
        self.assertEqual((sent.delivery_state, repeated.delivery_state), ("SENT", "SENT"))
        self.assertEqual(len(self.telegram.sent), 1)
        delivered = next(iter(self.telegram.sent.values()))
        self.assertEqual(delivered["player_id"], "player-7")
        self.assertEqual(delivered["chat_id"], "chat-9")
        self.assertEqual(delivered["amount_cents"], 1000)
        self.assertEqual(delivered["provider_id"], ready.provider_id)
        self.assertEqual(decode_png(delivered["qr_png"]), ready.payload)

    def test_telegram_failure_can_retry_without_new_invoice_or_duplicate_send(self):
        telegram = MockTelegramTransport(fail_first=True)
        service = InvoiceWorkflow(InvoiceStore(self.db), self.provider, telegram)
        service.create(operation_key="retry-send", player_id="player-7", chat_id="chat-9", amount_usd="10")
        failed = service.deliver("retry-send")
        sent = service.deliver("retry-send")
        repeated = service.deliver("retry-send")
        self.assertEqual(failed.delivery_state, "FAILED_RETRYABLE")
        self.assertEqual((sent.delivery_state, repeated.delivery_state), ("SENT", "SENT"))
        self.assertEqual(self.provider.creation_count, 1)
        self.assertEqual(len(telegram.sent), 1)

    def test_restart_recovers_ready_record_and_delivers(self):
        original = self.create("restart")
        restarted = InvoiceWorkflow(InvoiceStore(self.db), self.provider, self.telegram)
        recovered = restarted.deliver("restart")
        self.assertEqual(recovered.provider_id, original.provider_id)
        self.assertEqual(recovered.delivery_state, "SENT")
        self.assertEqual(self.provider.creation_count, 1)

    def test_expiration_never_marks_payment_confirmed(self):
        record = self.create("expire")
        expired = self.service.expire_if_due(
            "expire", datetime.fromisoformat(record.expires_at or "") + timedelta(seconds=1)
        )
        self.assertEqual(expired.state, "EXPIRED")
        self.assertEqual(expired.payment_state, "UNCONFIRMED")

    def test_amount_validation(self):
        self.assertEqual(parse_usd_to_cents("10.00"), 1000)
        for value in ("0", "-1", "abc", "1.001"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                parse_usd_to_cents(value)


if __name__ == "__main__":
    unittest.main()
