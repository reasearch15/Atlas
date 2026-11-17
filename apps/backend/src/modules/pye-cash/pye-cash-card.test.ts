import jsQR from "jsqr";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { renderPyeCashCard } from "./pye-cash-card";

const SHORT = "lnbc500n1qqqqqqqqqqqqqqqqqqqqqq";

function bolt11(marker: string, length: number): string {
  const body = `${marker}${"qpzry9x8gf2tvdw0s3jn54khce6mua7l".repeat(40)}`.slice(0, length);
  return `lnbc${body.length}n1${body}`;
}

async function decode(png: Buffer): Promise<string | null> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const result = jsQR(new Uint8ClampedArray(data), info.width, info.height);
  return result?.data ?? null;
}

describe("Pye-Cash card renderer", () => {
  it.each([500, 2500, 10000])("renders $%i cents and decodes that invoice", async (amountCents) => {
    const payload = bolt11(`amt${amountCents}`, 180);
    const card = await renderPyeCashCard({
      bolt11: payload,
      amountCents,
      expiresAt: "2026-11-18T12:00:00.000Z"
    });
    expect(card.png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(card.svg).toContain(`$${(amountCents / 100).toFixed(2)}`);
    expect(card.svg).not.toContain(payload);
    expect(await decode(card.png)).toBe(payload);
  });

  it("keeps a quiet zone and does not reuse another invoice", async () => {
    const first = bolt11("firstinvoice", 220);
    const second = bolt11("secondinvoice", 240);
    const card = await renderPyeCashCard({ bolt11: first, amountCents: 500, expiresAt: "2026-11-18T12:00:00.000Z" });
    const other = await renderPyeCashCard({ bolt11: second, amountCents: 2500, expiresAt: "2026-11-18T13:00:00.000Z" });
    expect(await decode(card.png)).toBe(first);
    expect(await decode(other.png)).toBe(second);
    const { data, info } = await sharp(card.png).raw().toBuffer({ resolveWithObject: true });
    const corner = data[0] + (data[1] ?? 0) + (data[2] ?? 0);
    expect(corner).toBeGreaterThan(700);
    expect(info.width).toBeGreaterThan(400);
  });

  it("decodes a long Lightning invoice from the full card", async () => {
    const payload = bolt11(SHORT, 700);
    const card = await renderPyeCashCard({
      bolt11: payload,
      amountCents: 10000,
      expiresAt: "2026-11-19T00:00:00.000Z"
    });
    expect(payload.length).toBeGreaterThan(600);
    expect(await decode(card.png)).toBe(payload);
  });
});
