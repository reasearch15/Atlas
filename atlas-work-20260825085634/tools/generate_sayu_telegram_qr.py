from __future__ import annotations

from pathlib import Path
import math

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter


ENCODED_URL = "https://t.me/+ojV4Qxci0pJlYjgx"
OUT_1200 = Path("SAYU_Gaming_Hub_Telegram_QR.png")
OUT_2048 = Path("SAYU_Gaming_Hub_Telegram_QR_2048.png")
SAYU_LOGO_PATH = Path("C:/Users/user/Pictures/Screenshots/Screenshot 2026-08-13 142839.png")


def make_qr_matrix() -> np.ndarray:
    params = cv2.QRCodeEncoder_Params()
    params.correction_level = cv2.QRCodeEncoder_CORRECT_LEVEL_H
    params.mode = cv2.QRCodeEncoder_MODE_AUTO
    encoded = cv2.QRCodeEncoder_create(params).encode(ENCODED_URL)
    return encoded < 128


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
    ]
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def lerp(a: int, b: int, t: float) -> int:
    return round(a + (b - a) * t)


def gradient_color(x: float, y: float, size: float) -> tuple[int, int, int]:
    # Telegram-ish violet to bright blue, with a warmer purple in the upper left.
    c1 = (122, 62, 255)
    c2 = (169, 78, 255)
    c3 = (35, 174, 255)
    t = max(0.0, min(1.0, (x + y) / (2 * size)))
    mid = 0.42
    if t < mid:
        k = t / mid
        return tuple(lerp(c1[i], c2[i], k) for i in range(3))
    k = (t - mid) / (1 - mid)
    return tuple(lerp(c2[i], c3[i], k) for i in range(3))


def rounded_rect(draw: ImageDraw.ImageDraw, box: tuple[float, float, float, float], radius: float, fill: tuple[int, int, int] | str) -> None:
    draw.rounded_rectangle(tuple(round(v) for v in box), radius=round(radius), fill=fill)


def draw_plane(draw: ImageDraw.ImageDraw, cx: float, cy: float, scale: float) -> None:
    # Simple Telegram paper-plane glyph in white, drawn as geometry rather than an external asset.
    points = [
        (cx - 0.62 * scale, cy - 0.08 * scale),
        (cx + 0.70 * scale, cy - 0.62 * scale),
        (cx + 0.34 * scale, cy + 0.66 * scale),
        (cx - 0.06 * scale, cy + 0.28 * scale),
        (cx - 0.32 * scale, cy + 0.52 * scale),
        (cx - 0.20 * scale, cy + 0.14 * scale),
    ]
    draw.polygon(points, fill="white")
    draw.line(
        [(cx - 0.17 * scale, cy + 0.09 * scale), (cx + 0.37 * scale, cy - 0.36 * scale)],
        fill=(209, 242, 255),
        width=max(2, round(scale * 0.08)),
    )


def circular_logo_image(size: int) -> Image.Image | None:
    if not SAYU_LOGO_PATH.exists():
        return None
    logo = Image.open(SAYU_LOGO_PATH).convert("RGB")
    side = min(logo.size)
    left = (logo.width - side) // 2
    top = (logo.height - side) // 2
    logo = logo.crop((left, top, left + side, top + side)).resize((size, size), Image.Resampling.LANCZOS)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(logo, (0, 0), mask)
    return out


def render_card(matrix: np.ndarray, size: int, module_round: float, badge_modules: float) -> Image.Image:
    n = int(matrix.shape[0])
    quiet = 4
    bg = Image.new("RGB", (size, size), (11, 22, 42))
    bg_draw = ImageDraw.Draw(bg)
    for y in range(size):
        t = y / max(1, size - 1)
        color = (lerp(8, 18, t), lerp(19, 32, t), lerp(39, 61, t))
        bg_draw.line([(0, y), (size, y)], fill=color)

    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    card_margin = round(size * 0.105)
    card_top = round(size * 0.13)
    card_bottom = round(size * 0.94)
    sd.rounded_rectangle(
        (card_margin + 8, card_top + 18, size - card_margin + 8, card_bottom + 18),
        radius=round(size * 0.055),
        fill=(0, 0, 0, 62),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(round(size * 0.018)))
    bg = Image.alpha_composite(bg.convert("RGBA"), shadow)
    draw = ImageDraw.Draw(bg)
    draw.rounded_rectangle(
        (card_margin, card_top, size - card_margin, card_bottom),
        radius=round(size * 0.055),
        fill="white",
    )

    badge_r = round(size * 0.082)
    badge_cx = size // 2
    badge_cy = card_top
    draw.ellipse((badge_cx - badge_r, badge_cy - badge_r, badge_cx + badge_r, badge_cy + badge_r), fill="white")
    logo_size = badge_r * 2 - round(size * 0.014)
    logo = circular_logo_image(logo_size)
    if logo:
        bg.alpha_composite(logo, (badge_cx - logo_size // 2, badge_cy - logo_size // 2))
    else:
        draw.ellipse(
            (badge_cx - badge_r + 8, badge_cy - badge_r + 8, badge_cx + badge_r - 8, badge_cy + badge_r - 8),
            fill=(35, 174, 255),
        )
        logo_font = font(round(size * 0.043), bold=True)
        label = "SAYU"
        text_box = draw.textbbox((0, 0), label, font=logo_font)
        draw.text((badge_cx - (text_box[2] - text_box[0]) / 2, badge_cy - (text_box[3] - text_box[1]) / 2 - text_box[1]), label, font=logo_font, fill="white")

    qr_area = round(size * 0.655)
    module = qr_area / (n + 2 * quiet)
    qr_x = (size - qr_area) / 2
    qr_y = round(size * 0.205)
    qr_origin_x = qr_x + quiet * module
    qr_origin_y = qr_y + quiet * module

    # Quiet zone.
    draw.rounded_rectangle((qr_x, qr_y, qr_x + qr_area, qr_y + qr_area), radius=round(size * 0.025), fill="white")

    qr_size_no_quiet = n * module
    for my in range(n):
        for mx in range(n):
            if not matrix[my, mx]:
                continue
            x = qr_origin_x + mx * module
            y = qr_origin_y + my * module
            c = gradient_color(x - qr_origin_x, y - qr_origin_y, qr_size_no_quiet)
            rounded_rect(draw, (x, y, x + module, y + module), module * module_round, c)

    center_x = qr_origin_x + qr_size_no_quiet / 2
    center_y = qr_origin_y + qr_size_no_quiet / 2
    badge_d = badge_modules * module
    draw.ellipse(
        (center_x - badge_d / 2, center_y - badge_d / 2, center_x + badge_d / 2, center_y + badge_d / 2),
        fill="white",
    )
    inner = badge_d * 0.82
    draw.ellipse(
        (center_x - inner / 2, center_y - inner / 2, center_x + inner / 2, center_y + inner / 2),
        fill=(38, 171, 255),
    )
    draw_plane(draw, center_x, center_y, inner * 0.38)

    title_font = font(round(size * 0.041), bold=True)
    sub_font = font(round(size * 0.022), bold=False)
    title = "SAYU GAMING HUB"
    sub = "Scan to join on Telegram"
    title_box = draw.textbbox((0, 0), title, font=title_font)
    sub_box = draw.textbbox((0, 0), sub, font=sub_font)
    title_y = min(qr_y + qr_area + round(size * 0.012), card_bottom - round(size * 0.095))
    draw.text(((size - (title_box[2] - title_box[0])) / 2, title_y), title, font=title_font, fill=(13, 24, 48))
    draw.text(((size - (sub_box[2] - sub_box[0])) / 2, title_y + round(size * 0.054)), sub, font=sub_font, fill=(94, 110, 130))

    return bg.convert("RGB")


def decode(path: Path) -> str:
    image = cv2.imread(str(path))
    detector = cv2.QRCodeDetector()
    decoded, _, _ = detector.detectAndDecode(image)
    return decoded


def main() -> None:
    matrix = make_qr_matrix()
    attempts = [
        (0.20, 5.6),
        (0.16, 5.0),
        (0.12, 4.4),
        (0.08, 3.8),
        (0.04, 3.2),
    ]
    last_decoded = ""
    chosen = None
    for module_round, badge_modules in attempts:
        img = render_card(matrix, 1200, module_round, badge_modules)
        img.save(OUT_1200, optimize=True)
        last_decoded = decode(OUT_1200)
        if last_decoded == ENCODED_URL:
            chosen = (module_round, badge_modules)
            break
    if chosen is None:
        raise SystemExit(f"QR verification failed. Last decoded: {last_decoded!r}")

    img_2048 = render_card(matrix, 2048, chosen[0], chosen[1])
    img_2048.save(OUT_2048, optimize=True)
    decoded_2048 = decode(OUT_2048)
    if decoded_2048 != ENCODED_URL:
        raise SystemExit(f"2048 QR verification failed. Decoded: {decoded_2048!r}")

    print(f"encoded={ENCODED_URL}")
    print("error_correction=H")
    print(f"matrix_size={matrix.shape[0]}x{matrix.shape[1]}")
    print(f"style_module_round={chosen[0]}")
    print(f"style_badge_modules={chosen[1]}")
    print(f"output_1200={OUT_1200.resolve()}")
    print(f"decoded_1200={last_decoded}")
    print(f"output_2048={OUT_2048.resolve()}")
    print(f"decoded_2048={decoded_2048}")
    print("SCAN VERIFIED: YES")


if __name__ == "__main__":
    main()
