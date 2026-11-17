import QRCode from "qrcode";
import sharp from "sharp";

const GREEN = "#00D632";
const ORANGE = "#F7931A";
const AMBER = "#F59E0B";
const AMBER_DARK = "#D97706";
const INK = "#1A1A2E";

export interface PyeCashCardInput {
  readonly bolt11: string;
  readonly amountCents: number;
  readonly expiresAt: string;
}

/**
 * Renders a payment card whose QR encodes the BOLT11 invoice itself.
 * Finder modules stay square. The center mark stays inside the high-ECC budget.
 */
export async function renderPyeCashCard(input: PyeCashCardInput): Promise<{ readonly png: Buffer; readonly svg: string }> {
  if (!input.bolt11.toLowerCase().startsWith("lnbc") || input.bolt11.length > 2048) {
    throw new Error("QR payload must be a BOLT11 invoice");
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error("QR amount must be positive cents");
  }
  const expires = new Date(input.expiresAt);
  if (Number.isNaN(expires.getTime())) {
    throw new Error("QR expiration is invalid");
  }

  const qrPng = await renderQrPng(input.bolt11);
  const qrMeta = await sharp(qrPng).metadata();
  const qrSize = qrMeta.width ?? 520;
  const amount = `$${(input.amountCents / 100).toFixed(2)}`;
  const expiryLabel = expires.toISOString().replace(".000Z", "Z");
  const width = Math.max(840, qrSize + 280);
  const frameTop = 700;
  const frameHeight = qrSize + 180;
  const height = frameTop + frameHeight + 230;
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#ffffff"/>
  <rect x="48" y="56" width="52" height="52" rx="14" fill="${ORANGE}"/>
  <text x="74" y="92" text-anchor="middle" font-family="Segoe UI, DejaVu Sans, sans-serif" font-size="30" font-weight="700" fill="#111111">$</text>
  <text x="116" y="94" font-family="Segoe UI, DejaVu Sans, sans-serif" font-size="34" font-weight="700" fill="${INK}">Pye-Cash</text>
  <defs>
    <linearGradient id="amount" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${AMBER}"/>
      <stop offset="1" stop-color="${AMBER_DARK}"/>
    </linearGradient>
  </defs>
  <rect x="48" y="140" width="${width - 96}" height="176" rx="28" fill="url(#amount)"/>
  <text x="80" y="190" font-family="Segoe UI, DejaVu Sans, sans-serif" font-size="22" font-weight="700" fill="#ffffff">CASH APP PAYMENT</text>
  <text x="80" y="250" font-family="Segoe UI, DejaVu Sans, sans-serif" font-size="68" font-weight="700" fill="#ffffff">${amount}</text>
  <text x="80" y="288" font-family="Segoe UI, DejaVu Sans, sans-serif" font-size="24" font-weight="700" fill="#ffffff">USD</text>
  <rect x="48" y="344" width="${width - 96}" height="320" rx="24" fill="#F6FFF8" stroke="#C8F5D3"/>
  <text x="76" y="390" font-family="Segoe UI, DejaVu Sans, sans-serif" font-size="26" font-weight="700" fill="#008A20">How to pay</text>
  <text x="76" y="440" font-family="Segoe UI, DejaVu Sans, sans-serif" font-size="24" fill="${INK}">1. Copy the invoice or save this QR.</text>
  <text x="76" y="480" font-family="Segoe UI, DejaVu Sans, sans-serif" font-size="24" fill="${INK}">2. Open Cash App and tap scan.</text>
  <text x="76" y="520" font-family="Segoe UI, DejaVu Sans, sans-serif" font-size="24" fill="${INK}">3. Paste the invoice or choose this QR.</text>
  <text x="76" y="560" font-family="Segoe UI, DejaVu Sans, sans-serif" font-size="24" fill="${INK}">Use only this QR. Delete old ones.</text>
  <text x="76" y="610" font-family="Segoe UI, DejaVu Sans, sans-serif" font-size="22" fill="#5C6570">Expires ${escapeXml(expiryLabel)}</text>
  <rect x="48" y="${frameTop}" width="${width - 96}" height="${frameHeight}" rx="52" fill="${GREEN}"/>
  <rect x="${width / 2 - 150}" y="${frameTop + 28}" width="52" height="52" rx="14" fill="${ORANGE}"/>
  <text x="${width / 2 - 124}" y="${frameTop + 64}" text-anchor="middle" font-family="Segoe UI, DejaVu Sans, sans-serif" font-size="30" font-weight="700" fill="#111111">$</text>
  <text x="${width / 2 - 80}" y="${frameTop + 66}" font-family="Segoe UI, DejaVu Sans, sans-serif" font-size="36" font-weight="700" fill="#ffffff">PYE-CASH</text>
  <rect x="${(width - qrSize) / 2 - 16}" y="${frameTop + 100}" width="${qrSize + 32}" height="${qrSize + 32}" rx="28" fill="#ffffff"/>
  <text x="${width / 2}" y="${frameTop + qrSize + 156}" text-anchor="middle" font-family="Segoe UI, DejaVu Sans, sans-serif" font-size="28" font-weight="700" fill="#ffffff">Scan with Cash App</text>
  <rect x="48" y="${frameTop + frameHeight + 28}" width="${width - 96}" height="150" rx="24" fill="#FFF4E5" stroke="${AMBER}" stroke-width="4"/>
  <text x="76" y="${frameTop + frameHeight + 72}" font-family="Segoe UI, DejaVu Sans, sans-serif" font-size="26" font-weight="700" fill="#B45309">Always pay with a NEW QR</text>
  <text x="76" y="${frameTop + frameHeight + 112}" font-family="Segoe UI, DejaVu Sans, sans-serif" font-size="22" fill="#7A3E00">Each QR works for one payment only.</text>
  <text x="76" y="${frameTop + frameHeight + 146}" font-family="Segoe UI, DejaVu Sans, sans-serif" font-size="22" fill="#7A3E00">Never pay an old or saved QR again.</text>
  <circle cx="360" cy="${height - 36}" r="8" fill="#DDDDDD"/>
  <text x="380" y="${height - 28}" font-family="Segoe UI, DejaVu Sans, sans-serif" font-size="22" fill="#888888">Waiting for payment...</text>
</svg>`;
  const chrome = await sharp(Buffer.from(svg)).png().toBuffer();
  const png = await sharp(chrome)
    .composite([{ input: qrPng, left: Math.round((width - qrSize) / 2), top: frameTop + 116 }])
    .png()
    .toBuffer();
  return { png, svg };
}

async function renderQrPng(payload: string): Promise<Buffer> {
  const code = QRCode.create(payload, { errorCorrectionLevel: "H" });
  const count = code.modules.size;
  const quiet = 4;
  const scale = 8;
  const pixels = (count + quiet * 2) * scale;
  const raw = Buffer.alloc(pixels * pixels * 3, 255);
  const logo = Math.floor(count * 0.16);
  const logoOrigin = Math.floor((count - logo) / 2);
  for (let y = 0; y < count; y += 1) {
    for (let x = 0; x < count; x += 1) {
      const inLogo = x >= logoOrigin && x < logoOrigin + logo && y >= logoOrigin && y < logoOrigin + logo;
      const dark = !inLogo && Boolean(code.modules.get(x, y));
      if (!dark) continue;
      paint(raw, pixels, (x + quiet) * scale, (y + quiet) * scale, scale, scale, 0, 0, 0);
    }
  }
  paint(raw, pixels, (logoOrigin + quiet) * scale, (logoOrigin + quiet) * scale, logo * scale, logo * scale, 0, 214, 50);
  const qr = await sharp(raw, { raw: { width: pixels, height: pixels, channels: 3 } }).png().toBuffer();
  const badge = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${logo * scale}" height="${logo * scale}"><text x="50%" y="58%" text-anchor="middle" font-family="Segoe UI, DejaVu Sans, sans-serif" font-size="${Math.floor(logo * scale * 0.72)}" font-weight="700" fill="#ffffff">$</text></svg>`
  );
  return sharp(qr)
    .composite([{ input: badge, left: (logoOrigin + quiet) * scale, top: (logoOrigin + quiet) * scale }])
    .png()
    .toBuffer();
}

function paint(raw: Buffer, width: number, x: number, y: number, w: number, h: number, r: number, g: number, b: number): void {
  for (let row = y; row < y + h; row += 1) {
    for (let col = x; col < x + w; col += 1) {
      const offset = (row * width + col) * 3;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
    }
  }
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "\"":
        return "&quot;";
      default:
        return "&apos;";
    }
  });
}
