"""Recreate the existing Pye-Cash invoice card. Does not create an invoice."""

from __future__ import annotations

import datetime
import decimal
import hashlib
import os
import re
import urllib.request
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

INVOICE_URL = (
    "https://www.pye-cash.app/invoice/"
    "5ff851958d58a62d0bf1f26162c80d3733b07abc17aed1e376895e60baca26fb"
)
OUT = Path(__file__).resolve().parent / "output"
SCALE = 2
GREEN = (0, 214, 50)
ORANGE = (247, 147, 26)
AMBER = (245, 158, 11)
AMBER_DARK = (217, 119, 6)
INK = (26, 26, 46)
PAGE = (244, 246, 251)


def fetch_page() -> str:
    request = urllib.request.Request(INVOICE_URL, headers={"User-Agent": "PyeCash-Design-Match/1.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        if response.status != 200:
            raise RuntimeError("invoice page was not available")
        return response.read().decode("utf-8")


def page_fields(html: str) -> tuple[str, str, float]:
    invoice = re.search(r'const INVOICE = "([^"]+)"', html)
    amount = re.search(r"const AMOUNT = ([0-9.]+);", html)
    svg = re.search(r'<svg\b[^>]*aria-label="Payment QR code"[\s\S]*?</svg>', html, re.I)
    if not invoice or not amount or not svg:
        raise RuntimeError("invoice page is missing the payment QR")
    payload = invoice.group(1)
    if not payload.casefold().startswith("lnbc"):
        raise RuntimeError("page payload is not a Bitcoin-mainnet BOLT11 invoice")
    return payload, svg.group(0), float(amount.group(1))


def bolt11_facts(payload: str) -> tuple[str, str]:
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
    match = re.fullmatch(r"lnbc(\d+)([munp]?)", hrp)
    btc = "UNKNOWN"
    if match:
        multipliers = {
            "": decimal.Decimal(1),
            "m": decimal.Decimal("0.001"),
            "u": decimal.Decimal("0.000001"),
            "n": decimal.Decimal("0.000000001"),
            "p": decimal.Decimal("0.000000000001"),
        }
        btc = format(decimal.Decimal(match.group(1)) * multipliers[match.group(2)], "f")
    return btc, expires.isoformat()


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    path = "C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf"
    if os.path.exists(path):
        return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def text_size(draw: ImageDraw.ImageDraw, value: str, face: ImageFont.ImageFont) -> tuple[int, int]:
    box = draw.textbbox((0, 0), value, font=face)
    return box[2] - box[0], box[3] - box[1]


def render_qr(svg: str, with_logo: bool = True) -> Image.Image:
    """Rasterize the provider modules. Finder squares stay sharp so the code still scans."""
    view = re.search(r'viewBox="0 0 ([0-9.]+) ([0-9.]+)"', svg)
    if not view or view.group(1) != view.group(2):
        raise RuntimeError("provider QR viewBox is not square")
    modules = int(float(view.group(1)))
    scale, quiet = 12, 4
    canvas = np.full(((modules + quiet * 2) * scale,) * 2, 255, np.uint8)
    for x, y in re.findall(r'<circle cx="([0-9.]+)" cy="([0-9.]+)"', svg):
        cv2.circle(
            canvas,
            (round((float(x) + quiet) * scale), round((float(y) + quiet) * scale)),
            round(0.55 * scale),
            0,
            -1,
        )
    last = modules - 7
    for ox, oy in ((0, 0), (last, 0), (0, last)):
        x, y = (ox + quiet) * scale, (oy + quiet) * scale
        cv2.rectangle(canvas, (x, y), (x + 7 * scale - 1, y + 7 * scale - 1), 0, -1)
        cv2.rectangle(canvas, (x + scale, y + scale), (x + 6 * scale - 1, y + 6 * scale - 1), 255, -1)
        cv2.rectangle(canvas, (x + 2 * scale, y + 2 * scale), (x + 5 * scale - 1, y + 5 * scale - 1), 0, -1)
    image = Image.fromarray(canvas).convert("RGB")
    if not with_logo:
        return image
    draw = ImageDraw.Draw(image)
    logo = int(16 * scale)
    origin = int((30.5 + quiet) * scale)
    draw.rounded_rectangle((origin, origin, origin + logo, origin + logo), radius=int(4.48 * scale), fill="#00D632")
    face = font(int(12.48 * scale), bold=True)
    label_w, label_h = text_size(draw, "$", face)
    draw.text(
        (origin + (logo - label_w) / 2, origin + (logo - label_h) / 2 - int(0.4 * scale)),
        "$",
        fill="white",
        font=face,
    )
    return image


def decode_image(image: Image.Image) -> str:
    array = cv2.cvtColor(np.array(image.convert("RGB")), cv2.COLOR_RGB2BGR)
    decoded, _, _ = cv2.QRCodeDetector().detectAndDecode(array)
    return decoded


def rounded_mask(size: tuple[int, int], radius: int) -> Image.Image:
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), radius=radius, fill=255)
    return mask


def paste_round(base: Image.Image, image: Image.Image, xy: tuple[int, int], radius: int) -> None:
    mask = rounded_mask(image.size, radius)
    base.paste(image, xy, mask)


def payment_card(qr: Image.Image, amount: float) -> Image.Image:
    width = 420 * SCALE
    card = Image.new("RGB", (width, 1400 * SCALE), "white")
    draw = ImageDraw.Draw(card)
    pad = 24 * SCALE

    logo_font = font(17 * SCALE, bold=True)
    badge = 26 * SCALE
    badge_x, badge_y = pad, 28 * SCALE
    draw.rounded_rectangle(
        (badge_x, badge_y, badge_x + badge, badge_y + badge), radius=7 * SCALE, fill=ORANGE
    )
    dollar = font(15 * SCALE, bold=True)
    dw, dh = text_size(draw, "$", dollar)
    draw.text((badge_x + (badge - dw) / 2, badge_y + (badge - dh) / 2 - 1), "$", fill="black", font=dollar)
    draw.text((badge_x + badge + 8 * SCALE, badge_y + 2), "Pye-Cash", fill=INK, font=logo_font)

    box = (pad, 70 * SCALE, width - pad, 158 * SCALE)
    gradient = Image.new("RGB", (box[2] - box[0], box[3] - box[1]))
    gradient_draw = ImageDraw.Draw(gradient)
    for row in range(gradient.height):
        blend = row / max(1, gradient.height - 1)
        color = tuple(int(start + (end - start) * blend) for start, end in zip(AMBER, AMBER_DARK))
        gradient_draw.line((0, row, gradient.width, row), fill=color)
    paste_round(card, gradient, (box[0], box[1]), 14 * SCALE)
    label = font(11 * SCALE, bold=True)
    value = font(34 * SCALE, bold=True)
    currency = font(12 * SCALE, bold=True)
    draw.text((pad + 16 * SCALE, 80 * SCALE), "CASH APP PAYMENT", fill=(255, 255, 255), font=label)
    amount_text = f"${amount:.2f}"
    draw.text((pad + 16 * SCALE, 98 * SCALE), amount_text, fill="white", font=value)
    draw.text((pad + 16 * SCALE, 136 * SCALE), "USD", fill=(255, 255, 255), font=currency)

    steps_top = 172 * SCALE
    draw.rounded_rectangle(
        (pad, steps_top, width - pad, steps_top + 168 * SCALE),
        radius=12 * SCALE,
        fill=(246, 255, 248),
        outline=(200, 245, 211),
        width=SCALE,
    )
    body = font(13 * SCALE)
    bold = font(13 * SCALE, bold=True)
    draw.text((pad + 14 * SCALE, steps_top + 10 * SCALE), "How to pay", fill=(0, 138, 32), font=bold)
    lines = [
        "1. Tap Copy to copy the invoice, or tap",
        "    Save QR to Photos.",
        "2. Tap Open Cash App. It unlocks after",
        "    step 1.",
        "3. In Cash App, tap the scan icon, then",
        "    paste the invoice or pick the saved QR.",
        "    Use only this QR. Delete old ones.",
    ]
    y = steps_top + 34 * SCALE
    for line in lines:
        draw.text((pad + 14 * SCALE, y), line, fill=INK, font=body)
        y += 18 * SCALE

    frame_top = steps_top + 182 * SCALE
    wrap_pad = 16 * SCALE
    shown = qr.resize((qr.width // 2, qr.height // 2), Image.Resampling.NEAREST)
    wrap = Image.new("RGB", (shown.width + wrap_pad * 2, shown.height + wrap_pad * 2), "white")
    wrap.paste(shown, (wrap_pad, wrap_pad))
    frame_height = 52 * SCALE + wrap.height + 48 * SCALE
    frame = Image.new("RGB", (width - pad * 2, frame_height), GREEN)
    frame_draw = ImageDraw.Draw(frame)
    brand_badge = 26 * SCALE
    brand_x = (frame.width - (brand_badge + 118 * SCALE)) // 2
    frame_draw.rounded_rectangle(
        (brand_x, 14 * SCALE, brand_x + brand_badge, 14 * SCALE + brand_badge),
        radius=7 * SCALE,
        fill=ORANGE,
    )
    frame_draw.text(
        (brand_x + 6 * SCALE, 16 * SCALE), "$", fill="black", font=font(15 * SCALE, bold=True)
    )
    frame_draw.text(
        (brand_x + brand_badge + 8 * SCALE, 16 * SCALE),
        "PYE-CASH",
        fill="white",
        font=font(18 * SCALE, bold=True),
    )
    wrap_x = (frame.width - wrap.width) // 2
    paste_round(frame, wrap, (wrap_x, 52 * SCALE), 20 * SCALE)
    caption = "Scan with Cash App"
    caption_font = font(14 * SCALE, bold=True)
    caption_w, _ = text_size(frame_draw, caption, caption_font)
    frame_draw.text(((frame.width - caption_w) / 2, 52 * SCALE + wrap.height + 10 * SCALE), caption, fill="white", font=caption_font)
    paste_round(card, frame, (pad, frame_top), 26 * SCALE)

    warn_top = frame_top + frame.height + 14 * SCALE
    draw.rounded_rectangle(
        (pad, warn_top, width - pad, warn_top + 96 * SCALE),
        radius=12 * SCALE,
        fill=(255, 244, 229),
        outline=AMBER,
        width=2 * SCALE,
    )
    draw.text((pad + 14 * SCALE, warn_top + 10 * SCALE), "Always pay with a NEW QR", fill=(180, 83, 9), font=bold)
    note = font(12 * SCALE)
    draw.text((pad + 14 * SCALE, warn_top + 32 * SCALE), "Each QR works for one payment only.", fill=(122, 62, 0), font=note)
    draw.text((pad + 14 * SCALE, warn_top + 50 * SCALE), "Never pay an old or saved QR again.", fill=(122, 62, 0), font=note)
    draw.text((pad + 14 * SCALE, warn_top + 68 * SCALE), "Start a new payment to get a new QR.", fill=(122, 62, 0), font=note)

    status_y = warn_top + 114 * SCALE
    draw.ellipse((width // 2 - 70 * SCALE, status_y, width // 2 - 63 * SCALE, status_y + 7 * SCALE), fill=(221, 221, 221))
    draw.text((width // 2 - 56 * SCALE, status_y - 4 * SCALE), "Waiting for payment…", fill=(136, 136, 136), font=note)
    return card.crop((0, 0, width, status_y + 28 * SCALE))


def comparison(original_qr: Image.Image, card: Image.Image) -> Image.Image:
    left = original_qr.resize((360, 360), Image.Resampling.NEAREST)
    canvas = Image.new("RGB", (left.width + card.width + 80, max(left.height, card.height) + 80), "white")
    draw = ImageDraw.Draw(canvas)
    face = font(18, bold=True)
    draw.text((24, 16), "Scannable QR from the invoice", fill="black", font=face)
    draw.text((left.width + 56, 16), "Recreated payment card", fill="black", font=face)
    canvas.paste(left, (24, 56))
    canvas.paste(card, (left.width + 56, 56))
    return canvas


def main() -> None:
    html = fetch_page()
    payload, svg, amount = page_fields(html)
    original_qr = render_qr(svg, with_logo=False)
    qr = render_qr(svg, with_logo=True)
    card = payment_card(qr, amount)
    OUT.mkdir(parents=True, exist_ok=True)
    png_path = OUT / "pye_cash_matching_qr.png"
    svg_path = OUT / "pye_cash_matching_qr.svg"
    comparison_path = OUT / "pye_cash_comparison.png"
    local = decode_image(qr)
    original = decode_image(original_qr)
    card_decoded = decode_image(card)
    print("Local QR decode: " + ("PASS" if local.casefold() == payload.casefold() else "FAIL"))
    print("Original QR decode: " + ("PASS" if original.casefold() == payload.casefold() else "FAIL"))
    print("Full card decode: " + ("PASS" if card_decoded.casefold() == payload.casefold() else "FAIL"))
    same = (
        bool(local)
        and local.casefold() == payload.casefold()
        and original.casefold() == payload.casefold()
        and local.casefold() == original.casefold()
    )
    card.save(png_path, "PNG")
    svg_path.write_text(svg, encoding="utf-8")
    side_by_side = comparison(qr, card)
    try:
        side_by_side.save(comparison_path, "PNG")
    except OSError:
        comparison_path = OUT / "pye_cash_comparison_review.png"
        side_by_side.save(comparison_path, "PNG")
    btc, expires = bolt11_facts(payload)
    digest = hashlib.sha256(payload.casefold().encode()).hexdigest()
    print(f"USD amount: {amount:.2f}")
    print("BOLT11 amount BTC: " + btc)
    print("BOLT11 expires UTC: " + expires)
    print("Payload SHA256: " + digest)
    print("Decoded payloads identical: " + ("YES" if same else "NO"))
    print("PNG: " + str(png_path))
    print("SVG: " + str(svg_path))
    print("Comparison: " + str(comparison_path))
    try:
        os.startfile(comparison_path)  # noqa: S606 - local visual review requested
    except OSError:
        print("Could not open the comparison image automatically.")
    if not same or card_decoded.casefold() != payload.casefold():
        raise SystemExit(1)


if __name__ == "__main__":
    main()
