"""Authorized one-shot Pye-Cash test. Never retries invoice creation."""

from __future__ import annotations

import argparse
import datetime
import decimal
import hashlib
import json
import re
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import cv2
import numpy as np


CREATE_URL = "https://www.pye-cash.app/api/payments"
INVOICE_BASE = "https://www.pye-cash.app/invoice/"
OUTPUT = Path(__file__).resolve().parent / "output" / "pye_cash_5_usd_test.png"


def local_qr(payload: str) -> np.ndarray:
    if not payload.casefold().startswith("lnbc"):
        raise ValueError("provider payload is not a Bitcoin-mainnet BOLT11 invoice")
    matrix = cv2.QRCodeEncoder_create().encode(payload)
    bordered = cv2.copyMakeBorder(matrix, 4, 4, 4, 4, cv2.BORDER_CONSTANT, value=255)
    return cv2.resize(bordered, None, fx=10, fy=10, interpolation=cv2.INTER_NEAREST)


def decode_qr(image: np.ndarray) -> str:
    decoded, _, _ = cv2.QRCodeDetector().detectAndDecode(image)
    if not decoded:
        raise ValueError("QR decode failed")
    return decoded


def provider_svg_qr(html: str) -> np.ndarray:
    match = re.search(r'<svg\b[^>]*aria-label="Payment QR code"[\s\S]*?</svg>', html, re.I)
    if not match:
        raise ValueError("provider QR SVG not found")
    svg = match.group(0)
    view = re.search(r'viewBox="0 0 ([0-9.]+) ([0-9.]+)"', svg, re.I)
    if not view or view.group(1) != view.group(2):
        raise ValueError("provider QR SVG has an unsupported viewBox")
    modules = int(float(view.group(1)))
    scale, quiet = 12, 4
    image = np.full(((modules + quiet * 2) * scale,) * 2, 255, np.uint8)
    for x, y in re.findall(r'<circle cx="([0-9.]+)" cy="([0-9.]+)"', svg):
        cv2.circle(
            image,
            (round((float(x) + quiet) * scale), round((float(y) + quiet) * scale)),
            round(0.55 * scale),
            0,
            -1,
        )
    last = modules - 7
    for ox, oy in ((0, 0), (last, 0), (0, last)):
        x, y = (ox + quiet) * scale, (oy + quiet) * scale
        cv2.rectangle(image, (x, y), (x + 7 * scale - 1, y + 7 * scale - 1), 0, -1)
        cv2.rectangle(
            image, (x + scale, y + scale), (x + 6 * scale - 1, y + 6 * scale - 1), 255, -1
        )
        cv2.rectangle(
            image, (x + 2 * scale, y + 2 * scale), (x + 5 * scale - 1, y + 5 * scale - 1), 0, -1
        )
    return image


def bolt11_metadata(payload: str) -> tuple[str, int, str, str]:
    charset = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
    invoice = payload.casefold()
    separator = invoice.rfind("1")
    hrp = invoice[:separator]
    values = [charset.index(char) for char in invoice[separator + 1 :]]
    timestamp = 0
    for value in values[:7]:
        timestamp = (timestamp << 5) | value
    position, end, expiry = 7, len(values) - 104, 3600
    while position + 3 <= end:
        tag = charset[values[position]]
        length = (values[position + 1] << 5) | values[position + 2]
        position += 3
        segment = values[position : position + length]
        position += length
        if tag == "x":
            expiry = 0
            for value in segment:
                expiry = (expiry << 5) | value
    created = datetime.datetime.fromtimestamp(timestamp, datetime.timezone.utc)
    expires = created + datetime.timedelta(seconds=expiry)
    amount_match = re.fullmatch(r"lnbc(\d+)([munp]?)", hrp)
    btc = "UNKNOWN"
    if amount_match:
        multipliers = {
            "": decimal.Decimal(1),
            "m": decimal.Decimal(".001"),
            "u": decimal.Decimal(".000001"),
            "n": decimal.Decimal(".000000001"),
            "p": decimal.Decimal(".000000000001"),
        }
        btc = format(decimal.Decimal(amount_match.group(1)) * multipliers[amount_match.group(2)], "f")
    return btc, expiry, created.isoformat(), expires.isoformat()


def self_test() -> None:
    # Long, non-payable text proves the local PNG path and decoder before any POST.
    payload = "SELFTEST-NONPAYABLE:" + hashlib.sha256(b"pye-cash-local-readiness").hexdigest() * 3
    matrix = cv2.QRCodeEncoder_create().encode(payload)
    image = cv2.resize(
        cv2.copyMakeBorder(matrix, 4, 4, 4, 4, cv2.BORDER_CONSTANT, value=255),
        None,
        fx=10,
        fy=10,
        interpolation=cv2.INTER_NEAREST,
    )
    if decode_qr(image) != payload:
        raise RuntimeError("local QR readiness test failed")
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    probe = OUTPUT.parent / ".write_probe.png"
    if not cv2.imwrite(str(probe), image):
        raise RuntimeError("output directory is not writable")
    probe.unlink()
    print("SELF_TEST=PASS")
    print("OUTPUT_READY=" + str(OUTPUT.parent))


def live_test() -> int:
    body = json.dumps(
        {"amount": 5, "currency": "USD", "metadata": {"merchant": "sg"}}, separators=(",", ":")
    ).encode()
    request = urllib.request.Request(
        CREATE_URL,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "User-Agent": "Atlas-Authorized-One-Time-Test/1.0"},
    )
    # Exactly one urlopen call performs POST. No retry loop exists.
    try:
        response = urllib.request.urlopen(request, timeout=20)
        status = response.status
        content_type = response.headers.get("Content-Type", "")
        data = json.loads(response.read())
    except (TimeoutError, socket.timeout, urllib.error.URLError) as error:
        print("Invoice created: UNKNOWN")
        print("HTTP status: UNKNOWN")
        print("ERROR=" + type(error).__name__)
        return 2

    payment_id = data.get("id")
    payload = data.get("lightning_invoice")
    if not isinstance(payment_id, str) or not isinstance(payload, str):
        print("Invoice created: UNKNOWN")
        print(f"HTTP status: {status}")
        print("ERROR=invalid_provider_response")
        return 3

    invoice_url = INVOICE_BASE + urllib.parse.quote(payment_id, safe="")
    try:
        page_response = urllib.request.urlopen(invoice_url, timeout=20)
        page_status = page_response.status
        html = page_response.read().decode("utf-8", "strict")
    except Exception as error:
        print("Invoice created: YES")
        print(f"HTTP status: {status}")
        print("ERROR=invoice_get_" + type(error).__name__)
        return 4

    page_payload_match = re.search(r'const INVOICE = "([^"]+)"', html)
    page_amount_match = re.search(r"const AMOUNT = ([0-9.]+);", html)
    page_payload = page_payload_match.group(1) if page_payload_match else ""
    if page_payload.casefold() != payload.casefold():
        print("Invoice created: YES")
        print(f"HTTP status: {status}")
        print("ERROR=page_payload_mismatch")
        return 5

    generated = local_qr(payload)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(OUTPUT), generated):
        print("Invoice created: YES")
        print(f"HTTP status: {status}")
        print("ERROR=png_write_failed")
        return 6
    local_decoded = decode_qr(generated)
    provider_decoded = decode_qr(provider_svg_qr(html))
    local_pass = local_decoded.casefold() == payload.casefold()
    provider_pass = provider_decoded.casefold() == payload.casefold()
    btc, expiry_seconds, created, decoded_expiry = bolt11_metadata(payload)
    response_expiry = str(data.get("expires_at", "UNKNOWN"))
    initial_status = str(data.get("status", "UNKNOWN"))

    print("Invoice created: YES")
    print(f"HTTP status: {status}")
    print("Creation content type: " + content_type)
    print(f"Invoice page HTTP status: {page_status}")
    print("Amount: $5 USD")
    print("Page amount: $" + (page_amount_match.group(1) if page_amount_match else "UNKNOWN") + " USD")
    print("QR generated: YES")
    print("Local QR decode: " + ("PASS" if local_pass else "FAIL"))
    print("Provider QR comparison: " + ("PASS" if provider_pass and local_decoded.casefold() == provider_decoded.casefold() else "FAIL"))
    print("Expiration response: " + response_expiry)
    print("Expiration BOLT11 UTC: " + decoded_expiry)
    print(f"Expiration lifetime seconds: {expiry_seconds}")
    print("Invoice status: " + initial_status)
    print("BOLT11 amount BTC: " + btc)
    print("BOLT11 created UTC: " + created)
    print("Invoice ID SHA256: " + hashlib.sha256(payment_id.encode()).hexdigest())
    print("Payload SHA256: " + hashlib.sha256(payload.casefold().encode()).hexdigest())
    print("QR path: " + str(OUTPUT))
    print("POST attempts: 1")
    print("RESULT=" + ("PASS" if local_pass and provider_pass else "FAIL"))
    return 0 if local_pass and provider_pass else 7


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("self-test", "live"))
    arguments = parser.parse_args()
    if arguments.mode == "self-test":
        self_test()
        sys.exit(0)
    sys.exit(live_test())
