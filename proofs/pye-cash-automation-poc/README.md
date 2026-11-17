# Pye-Cash automation proof of concept

This isolated project demonstrates Atlas-side invoice orchestration without
calling Pye-Cash or Telegram. Every payment payload is synthetic and begins
with `PYECASH-POC-NONPAYABLE:`. It is not a Bitcoin or Lightning invoice.

The POC covers:

- USD amount validation and durable invoice records in SQLite;
- operation-key idempotency and concurrent duplicate-click protection;
- distinct synthetic provider invoices and QR images;
- QR encode/decode verification using OpenCV;
- mocked, idempotent Telegram delivery with retryable failures;
- explicit `UNKNOWN` state after an ambiguous provider timeout;
- restart recovery from the same SQLite database;
- invoice expiration without converting delivery into payment confirmation.

Run all tests:

```powershell
python -m unittest discover -s tests -v
```

No network access is used by the implementation or tests.
