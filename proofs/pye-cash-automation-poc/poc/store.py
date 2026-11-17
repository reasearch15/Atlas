import sqlite3
import threading
from contextlib import closing
from pathlib import Path

from .models import InvoiceRecord


class InvoiceStore:
    def __init__(self, path: str | Path) -> None:
        self.path = str(path)
        self._lock = threading.RLock()
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        return connection

    def _initialize(self) -> None:
        with closing(self._connect()) as db:
            with db:
                db.execute("PRAGMA journal_mode=WAL")
                db.execute(
                """
                CREATE TABLE IF NOT EXISTS invoices (
                    operation_key TEXT PRIMARY KEY,
                    player_id TEXT NOT NULL,
                    chat_id TEXT NOT NULL,
                    amount_cents INTEGER NOT NULL,
                    state TEXT NOT NULL,
                    provider_id TEXT,
                    payload TEXT,
                    expires_at TEXT,
                    qr_png BLOB,
                    delivery_state TEXT NOT NULL DEFAULT 'NOT_QUEUED',
                    telegram_message_id TEXT,
                    error TEXT,
                    payment_state TEXT NOT NULL DEFAULT 'UNCONFIRMED'
                )
                """
                )

    def reserve(self, operation_key: str, player_id: str, chat_id: str, amount_cents: int) -> tuple[InvoiceRecord, bool]:
        with self._lock, closing(self._connect()) as db:
            with db:
                db.execute("BEGIN IMMEDIATE")
                existing = db.execute(
                    "SELECT * FROM invoices WHERE operation_key = ?", (operation_key,)
                ).fetchone()
                if existing:
                    return self._record(existing), False
                db.execute(
                    "INSERT INTO invoices(operation_key, player_id, chat_id, amount_cents, state) VALUES(?,?,?,?,?)",
                    (operation_key, player_id, chat_id, amount_cents, "CREATING"),
                )
                row = db.execute(
                    "SELECT * FROM invoices WHERE operation_key = ?", (operation_key,)
                ).fetchone()
                return self._record(row), True

    def update(self, operation_key: str, **fields: object) -> InvoiceRecord:
        allowed = {
            "state", "provider_id", "payload", "expires_at", "qr_png",
            "delivery_state", "telegram_message_id", "error", "payment_state",
        }
        if not fields or not set(fields).issubset(allowed):
            raise ValueError("invalid invoice update")
        with self._lock, closing(self._connect()) as db:
            with db:
                assignments = ", ".join(f"{name} = ?" for name in fields)
                db.execute(
                    f"UPDATE invoices SET {assignments} WHERE operation_key = ?",
                    (*fields.values(), operation_key),
                )
                row = db.execute(
                    "SELECT * FROM invoices WHERE operation_key = ?", (operation_key,)
                ).fetchone()
                return self._record(row)

    def get(self, operation_key: str) -> InvoiceRecord | None:
        with closing(self._connect()) as db:
            row = db.execute(
                "SELECT * FROM invoices WHERE operation_key = ?", (operation_key,)
            ).fetchone()
            return self._record(row) if row else None

    @staticmethod
    def _record(row: sqlite3.Row) -> InvoiceRecord:
        return InvoiceRecord(**dict(row))
