/**
 * Deterministic public leaderboard card renderer (SVG → PNG).
 * Luxury black / gold / purple tournament poster. Pure input → Buffer.
 * Decorative shapes are drawn in code. No baked-in names, amounts, or dates.
 */

import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { formatCompetitionEndDisplay } from "./competition-end-display";
import {
  buildPublicLeaderboardClimbTips,
  type LeaderboardClimbTip
} from "./public-leaderboard-climb-tips";

export const LEADERBOARD_CARD_WIDTH = 1080;
/** 4:5 canvas. Tall 9:16 posters get cropped in the Telegram chat preview. */
export const LEADERBOARD_CARD_HEIGHT = 1350;

/** Future visual variants — Phase 1 styles NORMAL; others nudge accents only. */
export type LeaderboardCardTheme = "NORMAL" | "FINAL_24H" | "FROZEN" | "RESULTS";

export type RankMovementKind = "up" | "down" | "same" | "new";

export interface RankMovement {
  readonly kind: RankMovementKind;
  /** Absolute rank delta for up/down. */
  readonly delta?: number;
}

export interface LeaderboardCardStanding {
  readonly rank: number;
  readonly displayName: string;
  readonly points: number;
  readonly movement?: RankMovement | null;
}

export interface LeaderboardCardInput {
  readonly brandName: string;
  readonly prizePoolCents: number;
  readonly endsAt: Date;
  readonly timezone: string;
  readonly competitionStatus: string;
  readonly standings: readonly LeaderboardCardStanding[];
  readonly theme?: LeaderboardCardTheme;
  /** Injection point for tests / frozen clock. */
  readonly now?: Date;
  /**
   * Player-facing climb tips. When omitted, defaults from Atlas constants
   * (deposit/referral/promotions; wheel omitted unless provided).
   */
  readonly climbTips?: readonly LeaderboardClimbTip[];
}

export interface LeaderboardCardRenderResult {
  readonly png: Buffer;
  readonly width: number;
  readonly height: number;
  readonly renderMs: number;
  readonly imageBytes: number;
  readonly svg: string;
}

/**
 * Compare previous Top 10 (by crmContactId) to compute movement.
 * Returns null when previous snapshot is missing/empty — omit rather than guess.
 */
export function computeRankMovement(
  crmContactId: string,
  currentRank: number,
  previous:
    | readonly { readonly crmContactId: string; readonly rank: number }[]
    | null
    | undefined
): RankMovement | null {
  if (!previous || previous.length === 0) return null;
  const prev = previous.find((p) => p.crmContactId === crmContactId);
  if (!prev) return { kind: "new" };
  const delta = prev.rank - currentRank;
  if (delta > 0) return { kind: "up", delta };
  if (delta < 0) return { kind: "down", delta: Math.abs(delta) };
  return { kind: "same" };
}

export function formatRankMovementLabel(movement: RankMovement | null | undefined): string {
  if (!movement) return "";
  if (movement.kind === "new") return "NEW";
  if (movement.kind === "same") return "—";
  if (movement.kind === "up") return `▲${movement.delta ?? ""}`;
  if (movement.kind === "down") return `▼${movement.delta ?? ""}`;
  return "";
}

/** Hero prize: $1 / $250 / $1,000 / $10,000 — no clipping for large pools. */
export function formatPrizePoolHero(cents: number): string {
  const safe = Number.isFinite(cents) ? Math.max(0, Math.trunc(cents)) : 0;
  const dollars = safe / 100;
  if (Number.isInteger(dollars)) {
    return `$${dollars.toLocaleString("en-US")}`;
  }
  return `$${dollars.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

export function formatCountdownLeft(endsAt: Date, now: Date = new Date()): string {
  const ms = endsAt.getTime() - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return "ENDED";
  const totalMinutes = Math.floor(ms / 60_000);
  const totalHours = Math.floor(totalMinutes / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}D ${hours}H LEFT`;
  if (totalHours > 0) return `${totalHours}H ${minutes}M LEFT`;
  return `${Math.max(1, minutes)}M LEFT`;
}

export function resolveLeaderboardCardTheme(
  status: string,
  endsAt: Date,
  now: Date = new Date()
): LeaderboardCardTheme {
  const normalized = status.trim().toUpperCase();
  if (normalized === "FROZEN") return "FROZEN";
  if (normalized === "FINALIZED" || normalized === "COMPLETED" || normalized === "ENDED") {
    return "RESULTS";
  }
  const ms = endsAt.getTime() - now.getTime();
  if (Number.isFinite(ms) && ms > 0 && ms <= 24 * 60 * 60 * 1000) return "FINAL_24H";
  return "NORMAL";
}

export function truncateLeaderboardName(name: string, maxChars: number): string {
  const cleaned = (name || "Player").replace(/\s+/g, " ").trim() || "Player";
  const chars = Array.from(cleaned);
  if (chars.length <= maxChars) return cleaned;
  if (maxChars <= 1) return "…";
  return `${chars.slice(0, maxChars - 1).join("")}…`;
}

export function escapeSvgText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

type ResolvedFonts = {
  readonly family: string;
  readonly css: string;
};

function fileUrlIfExists(path: string): string | null {
  if (!existsSync(path)) return null;
  return pathToFileURL(path).href;
}

function resolveBundledFonts(): ResolvedFonts {
  const windows = [
    {
      family: "LbCard",
      regular: "C:/Windows/Fonts/segoeui.ttf",
      bold: "C:/Windows/Fonts/segoeuib.ttf"
    }
  ];
  const linux = [
    {
      family: "LbCard",
      regular: "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
      bold: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
    },
    {
      family: "LbCard",
      regular: "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
      bold: "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
    }
  ];

  for (const candidate of [...windows, ...linux]) {
    const regular = fileUrlIfExists(candidate.regular);
    const bold = fileUrlIfExists(candidate.bold) ?? regular;
    if (regular && bold) {
      return {
        family: candidate.family,
        css: `
@font-face {
  font-family: '${candidate.family}';
  src: url('${regular}');
  font-weight: 400;
  font-style: normal;
}
@font-face {
  font-family: '${candidate.family}';
  src: url('${bold}');
  font-weight: 700;
  font-style: normal;
}`
      };
    }
  }

  return {
    family: "DejaVu Sans, Arial, Helvetica, sans-serif",
    css: ""
  };
}


type FontMetrics = {
  readonly unitsPerEm: number;
  readonly advances: readonly number[];
  readonly glyphFor: (codePoint: number) => number;
};

const fontCache = new Map<string, FontMetrics | null>();

function boldFontFile(): string | null {
  const candidates = [
    "C:/Windows/Fonts/segoeuib.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

function loadFontMetrics(filePath: string): FontMetrics | null {
  const cached = fontCache.get(filePath);
  if (cached !== undefined) return cached;
  try {
    const parsed = parseTrueType(readFileSync(filePath));
    fontCache.set(filePath, parsed);
    return parsed;
  } catch {
    fontCache.set(filePath, null);
    return null;
  }
}

function parseTrueType(buf: Buffer): FontMetrics {
  const numTables = buf.readUInt16BE(4);
  const tables = new Map<string, { offset: number; length: number }>();
  for (let i = 0; i < numTables; i += 1) {
    const record = 12 + i * 16;
    const tag = buf.toString("latin1", record, record + 4);
    tables.set(tag, { offset: buf.readUInt32BE(record + 8), length: buf.readUInt32BE(record + 12) });
  }
  const head = tables.get("head");
  const hhea = tables.get("hhea");
  const hmtx = tables.get("hmtx");
  const cmap = tables.get("cmap");
  if (!head || !hhea || !hmtx || !cmap) throw new Error("FONT_TABLE_MISSING");
  const unitsPerEm = buf.readUInt16BE(head.offset + 18);
  const numberOfHMetrics = buf.readUInt16BE(hhea.offset + 34);
  const advances: number[] = [];
  for (let i = 0; i < numberOfHMetrics; i += 1) {
    advances.push(buf.readUInt16BE(hmtx.offset + i * 4));
  }
  const glyphFor = buildCmap(buf, cmap.offset);
  return { unitsPerEm, advances, glyphFor };
}

function buildCmap(buf: Buffer, offset: number): (codePoint: number) => number {
  const numTables = buf.readUInt16BE(offset + 2);
  let format4 = 0;
  let format12 = 0;
  for (let i = 0; i < numTables; i += 1) {
    const rec = offset + 4 + i * 8;
    const platform = buf.readUInt16BE(rec);
    const encoding = buf.readUInt16BE(rec + 2);
    const sub = offset + buf.readUInt32BE(rec + 4);
    const format = buf.readUInt16BE(sub);
    if (format === 12 && (platform === 3 || platform === 0)) format12 = sub;
    if (format === 4 && platform === 3 && (encoding === 1 || encoding === 0)) format4 = sub;
  }
  const lookup12 = format12 ? parseCmap12(buf, format12) : null;
  const lookup4 = format4 ? parseCmap4(buf, format4) : null;
  return (codePoint: number) => lookup12?.(codePoint) || lookup4?.(codePoint) || 0;
}

function parseCmap4(buf: Buffer, offset: number): (codePoint: number) => number {
  const segCount = buf.readUInt16BE(offset + 6) / 2;
  let cursor = offset + 14;
  const endCode: number[] = [];
  const startCode: number[] = [];
  const idDelta: number[] = [];
  const idRangeOffset: number[] = [];
  for (let i = 0; i < segCount; i += 1) endCode.push(buf.readUInt16BE(cursor + i * 2));
  cursor += segCount * 2 + 2;
  for (let i = 0; i < segCount; i += 1) startCode.push(buf.readUInt16BE(cursor + i * 2));
  cursor += segCount * 2;
  for (let i = 0; i < segCount; i += 1) idDelta.push(buf.readInt16BE(cursor + i * 2));
  cursor += segCount * 2;
  const rangePos = cursor;
  for (let i = 0; i < segCount; i += 1) idRangeOffset.push(buf.readUInt16BE(cursor + i * 2));
  return (codePoint: number) => {
    if (codePoint > 0xffff) return 0;
    for (let i = 0; i < segCount; i += 1) {
      if (codePoint > (endCode[i] ?? 0) || codePoint < (startCode[i] ?? 0)) continue;
      if ((idRangeOffset[i] ?? 0) === 0) return (codePoint + (idDelta[i] ?? 0)) & 0xffff;
      const glyphPos =
        rangePos + i * 2 + (idRangeOffset[i] ?? 0) + (codePoint - (startCode[i] ?? 0)) * 2;
      const glyph = buf.readUInt16BE(glyphPos);
      return glyph === 0 ? 0 : (glyph + (idDelta[i] ?? 0)) & 0xffff;
    }
    return 0;
  };
}

function parseCmap12(buf: Buffer, offset: number): (codePoint: number) => number {
  const nGroups = buf.readUInt32BE(offset + 12);
  const groups: Array<{ start: number; end: number; glyph: number }> = [];
  for (let i = 0; i < nGroups; i += 1) {
    const at = offset + 16 + i * 12;
    groups.push({
      start: buf.readUInt32BE(at),
      end: buf.readUInt32BE(at + 4),
      glyph: buf.readUInt32BE(at + 8)
    });
  }
  return (codePoint: number) => {
    let lo = 0;
    let hi = groups.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const group = groups[mid];
      if (!group) return 0;
      if (codePoint < group.start) hi = mid - 1;
      else if (codePoint > group.end) lo = mid + 1;
      else return group.glyph + (codePoint - group.start);
    }
    return 0;
  };
}

function activeMetrics(): FontMetrics | null {
  const path = boldFontFile();
  return path ? loadFontMetrics(path) : null;
}

function measureText(text: string, fontSize: number): number {
  const metrics = activeMetrics();
  if (!metrics || metrics.unitsPerEm <= 0) {
    return Array.from(text).length * fontSize * 0.62;
  }
  let units = 0;
  for (const ch of Array.from(text)) {
    const code = ch.codePointAt(0) ?? 0;
    const glyph = metrics.glyphFor(code);
    const indexed = glyph > 0 ? metrics.advances[Math.min(glyph, metrics.advances.length - 1)] : undefined;
    const advance = indexed && indexed > 0 ? indexed : metrics.unitsPerEm * 0.62;
    units += code > 0x2e80 ? Math.max(advance, metrics.unitsPerEm * 0.95) : advance;
  }
  return ((units * fontSize) / metrics.unitsPerEm) * 1.14;
}

function cleanName(name: string): string {
  return (name || "Player").replace(/\s+/g, " ").trim() || "Player";
}

function ellipsisToWidth(text: string, fontSize: number, maxWidth: number): string {
  const chars = Array.from(text);
  if (measureText(text, fontSize) <= maxWidth) return text;
  let lo = 1;
  let hi = chars.length;
  let best = "…";
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = `${chars.slice(0, mid).join("")}…`;
    if (measureText(candidate, fontSize) <= maxWidth) {
      best = candidate;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

function fitPlayerName(
  name: string,
  maxWidth: number,
  maxSize: number,
  minSize: number,
  maxLines: number
): { lines: string[]; size: number } {
  const cleaned = cleanName(name);
  const safety = maxWidth * 0.94;
  let oneLine: { lines: string[]; size: number } | null = null;
  for (let size = maxSize; size >= minSize; size -= 1) {
    if (measureText(cleaned, size) <= safety) {
      oneLine = { lines: [cleaned], size };
      break;
    }
  }
  if (oneLine && (maxLines < 2 || oneLine.size >= Math.min(maxSize - 6, 36))) return oneLine;
  if (maxLines < 2) return { lines: [ellipsisToWidth(cleaned, minSize, safety)], size: minSize };

  const chars = Array.from(cleaned);
  for (let size = maxSize; size >= minSize; size -= 2) {
    let bestLines: string[] | null = null;
    let bestScore = Infinity;
    for (let index = 4; index <= chars.length - 4; index += 1) {
      const left = chars.slice(0, index).join("").trim();
      const right = chars.slice(index).join("").trim();
      const onSpace = chars[index] === " " || chars[index - 1] === " ";
      const leftLen = Array.from(left).length;
      const rightLen = Array.from(right).length;
      if (onSpace ? leftLen < 2 || rightLen < 2 : leftLen < 6 || rightLen < 6) continue;
      if (measureText(left, size) > safety || measureText(right, size) > safety) continue;
      const score = Math.abs(Array.from(left).length - Array.from(right).length) + (onSpace ? 0 : 40);
      if (score < bestScore) {
        bestScore = score;
        bestLines = [left, right];
      }
    }
    if (bestLines) return { lines: bestLines, size };
  }
  if (oneLine) return oneLine;
  return { lines: [ellipsisToWidth(cleaned, minSize, safety)], size: minSize };
}

function nameSvg(
  name: string,
  x: number,
  y: number,
  maxWidth: number,
  maxSize: number,
  minSize: number,
  maxLines: number,
  fontFamily: string,
  anchor: "middle" | "start"
): string {
  const layout = fitPlayerName(name, maxWidth, maxSize, minSize, maxLines);
  const lineH = Math.round(layout.size * 1.08);
  const firstY = y - (layout.lines.length - 1) * lineH;
  return layout.lines
    .map(
      (line, index) =>
        `<text x="${x}" y="${firstY + index * lineH}" text-anchor="${anchor}" fill="#fffaf0" font-family="${fontFamily}" font-size="${layout.size}" font-weight="700">${escapeSvgText(line)}</text>`
    )
    .join("\n");
}

function prizeFontSize(prizeText: string): number {
  const maxWidth = 620;
  for (let size = 72; size >= 40; size -= 2) {
    if (measureText(prizeText, size) <= maxWidth) return size;
  }
  return 40;
}

function shortEndLabel(endsAt: Date, timezone: string, now: Date): string {
  try {
    const full = formatCompetitionEndDisplay(endsAt, timezone, { now });
    const compact = full.replace(/^(\w+),/, (_, w: string) => w.slice(0, 3)).replace(" at ", " • ");
    return `ENDS ${compact}`.toUpperCase();
  } catch {
    return "END TIME UNAVAILABLE";
  }
}

function countdownCopy(theme: LeaderboardCardTheme, countdown: string): string {
  if (theme === "RESULTS") return "FINAL RESULTS";
  if (theme === "FROZEN") return "FINALIZING";
  return countdown;
}

function climbDisplayTitle(title: string): string {
  if (/wheel|spin/i.test(title)) return "SPIN";
  return title;
}

function climbSort(title: string): number {
  const upper = title.toUpperCase();
  if (upper.includes("DEPOSIT")) return 0;
  if (upper.includes("WHEEL") || upper.includes("SPIN")) return 1;
  if (upper.includes("REFER")) return 2;
  if (upper.includes("PROMO")) return 3;
  return 4;
}

function crown(cx: number, cy: number, scale: number, fill: string): string {
  return `<g transform="translate(${cx} ${cy}) scale(${scale})">
    <path d="M-18 6 L-14 -10 L-6 0 L0 -16 L6 0 L14 -10 L18 6 Z" fill="${fill}"/>
    <rect x="-18" y="6" width="36" height="5" rx="1" fill="${fill}"/>
  </g>`;
}

function medal(cx: number, cy: number, radius: number, label: string, metal: string, fontFamily: string): string {
  const font = label.length > 1 ? Math.max(15, radius - 6) : Math.max(18, radius - 8);
  return `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="url(#${metal})" stroke="#fff6d0" stroke-width="2"/>
    <circle cx="${cx}" cy="${cy}" r="${radius - 7}" fill="#140f09"/>
    <text x="${cx}" y="${cy + font * 0.36}" text-anchor="middle" fill="#fff8e7" font-family="${fontFamily}" font-size="${font}" font-weight="700">${escapeSvgText(label)}</text>`;
}

function championAvatar(cx: number, cy: number): string {
  return `<g transform="translate(${cx} ${cy})">
    <ellipse cx="0" cy="46" rx="46" ry="16" fill="#d4af37" opacity="0.25"/>
    <path d="M-34 18 L-28 -8 L-10 6 L0 -18 L10 6 L28 -8 L34 18 Z" fill="url(#goldMetal)"/>
    <rect x="-30" y="16" width="60" height="8" rx="2" fill="#ffe7a4"/>
    <circle cx="0" cy="34" r="16" fill="#f3d2a6"/>
    <path d="M-16 32 Q0 26 16 32" fill="none" stroke="#3a2412" stroke-width="1.4"/>
    <circle cx="-6" cy="32" r="1.6" fill="#2a1c10"/>
    <circle cx="6" cy="32" r="1.6" fill="#2a1c10"/>
    <path d="M-42 78 Q-36 48 -8 46 L8 46 Q36 48 42 78 Z" fill="#6b4e12"/>
    <path d="M-18 50 L0 70 L18 50 L8 46 L-8 46 Z" fill="#ffe7a4"/>
  </g>`;
}

function knightAvatar(cx: number, cy: number): string {
  return `<g transform="translate(${cx} ${cy})">
    <ellipse cx="0" cy="46" rx="42" ry="14" fill="#9aa6b5" opacity="0.28"/>
    <path d="M-8 -8 L0 -28 L8 -8 Z" fill="#e8eef6"/>
    <path d="M-22 8 Q-24 -8 0 -10 Q24 -8 22 8 L18 28 L-18 28 Z" fill="url(#silverMetal)"/>
    <rect x="-12" y="8" width="24" height="8" rx="2" fill="#1c2430"/>
    <path d="M-38 78 Q-30 46 -8 44 L10 44 Q32 46 38 78 Z" fill="#3d4856"/>
    <path d="M18 36 L40 28 L36 58 L16 50 Z" fill="#d5dde8" stroke="#8b97a8" stroke-width="1.5"/>
  </g>`;
}

function warriorAvatar(cx: number, cy: number): string {
  return `<g transform="translate(${cx} ${cy})">
    <ellipse cx="0" cy="46" rx="42" ry="14" fill="#cd7f32" opacity="0.28"/>
    <path d="M-16 -6 Q0 -30 16 -6 L12 4 L-12 4 Z" fill="#e7b07a"/>
    <path d="M-20 6 Q-22 -4 0 -6 Q22 -4 20 8 L16 26 L-16 26 Z" fill="url(#bronzeMetal)"/>
    <rect x="-10" y="10" width="20" height="6" rx="1" fill="#3a2012"/>
    <path d="M-36 78 Q-28 46 -6 44 L8 44 Q30 46 36 78 Z" fill="#6a3a16"/>
    <path d="M22 20 L30 -8 L34 24 Z" fill="#f0c79a"/>
  </g>`;
}

function rowEmblem(rank: number, cx: number, cy: number): string {
  if (rank === 4) {
    return `<g transform="translate(${cx} ${cy})">
      <path d="M0 16 C-4 8 -10 6 -8 -2 C-14 2 -14 10 -8 16 C-4 14 0 16 0 16 Z" fill="#ff7a2f"/>
      <path d="M0 16 C4 8 10 6 8 -2 C14 2 14 10 8 16 C4 14 0 16 0 16 Z" fill="#ffb703"/>
      <path d="M0 16 C-2 6 2 2 0 -8 C2 2 2 8 0 16 Z" fill="#fff1a8"/>
    </g>`;
  }
  if (rank === 5) {
    return `<path d="M${cx} ${cy - 16} L${cx + 6} ${cy - 2} L${cx + 16} ${cy} L${cx + 4} ${cy + 2} L${cx + 8} ${cy + 16} L${cx} ${cy + 6} L${cx - 8} ${cy + 16} L${cx - 4} ${cy + 2} L${cx - 16} ${cy} L${cx - 6} ${cy - 2} Z" fill="#ffe566"/>`;
  }
  if (rank === 6) {
    return `<path d="M${cx} ${cy - 14} L${cx + 12} ${cy} L${cx} ${cy + 14} L${cx - 12} ${cy} Z" fill="#7ee0ff" stroke="#dff8ff" stroke-width="1.4"/>`;
  }
  if (rank === 7) {
    return `<g transform="translate(${cx} ${cy})">
      <path d="M-4 14 L2 -14 L8 -8 L4 14 Z" fill="#f4f7fb"/>
      <path d="M-10 2 L10 -4 L6 6 Z" fill="#ff8a3d"/>
      <circle cx="2" cy="-12" r="3" fill="#ffd166"/>
    </g>`;
  }
  if (rank === 8) {
    return `<g transform="translate(${cx} ${cy})">
      <path d="M-14 4 Q-6 -12 8 -8 Q16 0 6 8 Q-2 14 -14 4 Z" fill="#3ddc97"/>
      <path d="M8 -8 Q18 -16 14 -2" fill="none" stroke="#b8ffd9" stroke-width="2"/>
      <circle cx="2" cy="0" r="1.6" fill="#083022"/>
    </g>`;
  }
  if (rank === 9) {
    return `<path d="M${cx} ${cy - 14} L${cx + 4} ${cy - 4} L${cx + 14} ${cy - 2} L${cx + 6} ${cy + 5} L${cx + 8} ${cy + 15} L${cx} ${cy + 9} L${cx - 8} ${cy + 15} L${cx - 6} ${cy + 5} L${cx - 14} ${cy - 2} L${cx - 4} ${cy - 4} Z" fill="#ffe08a"/>`;
  }
  return `<g transform="translate(${cx} ${cy})">
    <path d="M-12 -8 L12 -8 L14 4 L0 16 L-14 4 Z" fill="#7eb6ff" stroke="#e7f2ff" stroke-width="1.3"/>
    <path d="M-6 -8 L0 -16 L6 -8" fill="#d6e8ff"/>
  </g>`;
}

function climbIcon(kind: string, cx: number, cy: number): string {
  if (kind === "DEPOSIT") {
    return `<g><ellipse cx="${cx}" cy="${cy + 8}" rx="16" ry="6" fill="url(#goldMetal)"/><ellipse cx="${cx}" cy="${cy}" rx="16" ry="6" fill="#ffe7a4"/></g>`;
  }
  if (kind === "SPIN") {
    return `<g><circle cx="${cx}" cy="${cy + 2}" r="14" fill="none" stroke="url(#goldMetal)" stroke-width="3"/><path d="M${cx} ${cy - 10} L${cx + 5} ${cy + 2} L${cx - 2} ${cy + 1} Z" fill="#fff4c8"/></g>`;
  }
  if (kind === "REFER") {
    return `<g fill="url(#goldMetal)"><circle cx="${cx - 6}" cy="${cy - 4}" r="6"/><circle cx="${cx + 8}" cy="${cy - 2}" r="5"/><path d="M${cx - 16} ${cy + 14} Q${cx - 6} ${cy + 2} ${cx} ${cy + 8} Q${cx + 4} ${cy + 4} ${cx + 16} ${cy + 14} Z"/></g>`;
  }
  return `<g><path d="M${cx} ${cy - 12} L${cx + 8} ${cy} L${cx + 12} ${cy + 12} L${cx - 12} ${cy + 12} L${cx - 8} ${cy} Z" fill="url(#goldMetal)"/></g>`;
}

export function buildPublicLeaderboardCardSvg(input: LeaderboardCardInput): string {
  const now = input.now ?? new Date();
  const theme = input.theme ?? resolveLeaderboardCardTheme(input.competitionStatus, input.endsAt, now);
  const fonts = resolveBundledFonts();
  const brand = truncateLeaderboardName(input.brandName.trim() || "LEADERBOARD", 32).toUpperCase();
  const prize = formatPrizePoolHero(input.prizePoolCents);
  const prizeSize = prizeFontSize(prize);
  const countdown = countdownCopy(theme, formatCountdownLeft(input.endsAt, now));
  const endsLine = shortEndLabel(input.endsAt, input.timezone, now);
  const climbTips = [...(input.climbTips ?? buildPublicLeaderboardClimbTips({ includeWheel: false }))].sort(
    (a, b) => climbSort(a.title) - climbSort(b.title)
  );
  const ordered = [...input.standings]
    .filter((s) => s.rank >= 1 && s.rank <= 10)
    .sort((a, b) => a.rank - b.rank);
  const first = ordered.find((s) => s.rank === 1) ?? null;
  const second = ordered.find((s) => s.rank === 2) ?? null;
  const third = ordered.find((s) => s.rank === 3) ?? null;
  const rest = ordered.filter((s) => s.rank >= 4 && s.rank <= 10);

  const podium =
    ordered.length === 0
      ? `<text x="540" y="560" text-anchor="middle" fill="#f0d78a" font-family="${fonts.family}" font-size="40" font-weight="700">The race starts here.</text>
         <text x="540" y="608" text-anchor="middle" fill="#d7c49a" font-family="${fonts.family}" font-size="24">Be the first on the board.</text>`
      : renderPodium(first, second, third, fonts.family);
  const rows = renderRows(rest, fonts.family);
  const climb = renderClimb(climbTips, fonts.family);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${LEADERBOARD_CARD_WIDTH}" height="${LEADERBOARD_CARD_HEIGHT}" viewBox="0 0 ${LEADERBOARD_CARD_WIDTH} ${LEADERBOARD_CARD_HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#140818"/>
      <stop offset="42%" stop-color="#07060a"/>
      <stop offset="100%" stop-color="#09060f"/>
    </linearGradient>
    <linearGradient id="goldMetal" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#fff8dc"/>
      <stop offset="45%" stop-color="#e0b03a"/>
      <stop offset="100%" stop-color="#8a6914"/>
    </linearGradient>
    <linearGradient id="silverMetal" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="50%" stop-color="#c5ccd6"/>
      <stop offset="100%" stop-color="#6d7684"/>
    </linearGradient>
    <linearGradient id="bronzeMetal" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#f6d2ae"/>
      <stop offset="50%" stop-color="#cd7f32"/>
      <stop offset="100%" stop-color="#7a4518"/>
    </linearGradient>
    <linearGradient id="frame" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#2a220f"/>
      <stop offset="100%" stop-color="#0c0a07"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="18%" r="46%">
      <stop offset="0%" stop-color="#f0d060" stop-opacity="0.28"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0"/>
    </radialGradient>
    <style><![CDATA[${fonts.css}]]></style>
  </defs>
  <rect width="1080" height="1350" fill="url(#bg)"/>
  <rect width="1080" height="1350" fill="url(#glow)"/>
  <rect x="0" y="0" width="28" height="1350" fill="#3a1468" opacity="0.85"/>
  <rect x="1052" y="0" width="28" height="1350" fill="#3a1468" opacity="0.85"/>

  ${crown(540, 28, 0.7, "url(#goldMetal)")}
  <text x="540" y="62" text-anchor="middle" fill="#f4e7c3" font-family="${fonts.family}" font-size="18" font-weight="700" letter-spacing="4">${escapeSvgText(brand)}</text>
  <text x="540" y="92" text-anchor="middle" fill="#f7f1df" font-family="${fonts.family}" font-size="16" font-weight="700" letter-spacing="6">BIWEEKLY</text>
  <text x="540" y="138" text-anchor="middle" fill="url(#goldMetal)" font-family="${fonts.family}" font-size="46" font-weight="700" letter-spacing="2">LEADERBOARD</text>

  <text x="540" y="176" text-anchor="middle" fill="#e6cb72" font-family="${fonts.family}" font-size="16" font-weight="700" letter-spacing="3">PRIZE POOL</text>
  <rect x="210" y="190" width="660" height="108" rx="22" fill="url(#frame)" stroke="url(#goldMetal)" stroke-width="3"/>
  <text x="540" y="${246 + Math.round(prizeSize * 0.18)}" text-anchor="middle" fill="url(#goldMetal)" font-family="${fonts.family}" font-size="${prizeSize}" font-weight="700">${escapeSvgText(prize)}</text>

  <rect x="300" y="314" width="480" height="48" rx="24" fill="#120e08" stroke="url(#goldMetal)" stroke-width="2"/>
  <circle cx="356" cy="338" r="10" fill="none" stroke="#ffe7a4" stroke-width="2"/>
  <path d="M356 332 L356 338 L362 342" fill="none" stroke="#ffe7a4" stroke-width="2"/>
  <text x="560" y="346" text-anchor="middle" fill="#fff6d8" font-family="${fonts.family}" font-size="24" font-weight="700">${escapeSvgText(countdown)}</text>
  <text x="540" y="386" text-anchor="middle" fill="#d7c49a" font-family="${fonts.family}" font-size="16" font-weight="700">${escapeSvgText(endsLine)}</text>

  ${podium}
  ${rows}
  ${climb}
</svg>`;
}

function renderPodium(
  first: LeaderboardCardStanding | null,
  second: LeaderboardCardStanding | null,
  third: LeaderboardCardStanding | null,
  fontFamily: string
): string {
  const slot = (
    standing: LeaderboardCardStanding | null,
    opts: {
      x: number;
      y: number;
      w: number;
      h: number;
      rank: "1" | "2" | "3";
      metal: string;
      fill: string;
      nameSize: number;
    }
  ) => {
    const cx = opts.x + opts.w / 2;
    const avatar =
      opts.rank === "1"
        ? championAvatar(cx, opts.y + 28)
        : opts.rank === "2"
          ? knightAvatar(cx, opts.y + 36)
          : warriorAvatar(cx, opts.y + 36);
    const name = standing
      ? `<clipPath id="clip-${opts.rank}"><rect x="${opts.x + 8}" y="${opts.y + opts.h - 92}" width="${opts.w - 16}" height="80"/></clipPath>
         <g clip-path="url(#clip-${opts.rank})">${nameSvg(standing.displayName, cx, opts.y + opts.h - 16, opts.w - 28, opts.nameSize, 30, 2, fontFamily, "middle")}</g>`
      : `<text x="${cx}" y="${opts.y + opts.h - 36}" text-anchor="middle" fill="#b7a98a" font-family="${fontFamily}" font-size="28" font-weight="700">OPEN</text>`;
    return `<g>
      <rect x="${opts.x}" y="${opts.y + 24}" width="${opts.w}" height="${opts.h - 24}" rx="22" fill="${opts.fill}" stroke="url(#${opts.metal})" stroke-width="${opts.rank === "1" ? 4 : 3}"/>
      ${medal(cx, opts.y + 24, opts.rank === "1" ? 30 : 26, opts.rank, opts.metal, fontFamily)}
      ${crown(cx, opts.y - 2, opts.rank === "1" ? 1.15 : 0.9, `url(#${opts.metal})`)}
      ${avatar}
      ${name}
    </g>`;
  };
  return `<g>
    ${slot(second, { x: 36, y: 448, w: 318, h: 248, rank: "2", metal: "silverMetal", fill: "#1a1e26", nameSize: 44 })}
    ${slot(third, { x: 726, y: 448, w: 318, h: 248, rank: "3", metal: "bronzeMetal", fill: "#24160e", nameSize: 44 })}
    ${slot(first, { x: 364, y: 420, w: 352, h: 276, rank: "1", metal: "goldMetal", fill: "#241c0c", nameSize: 52 })}
  </g>`;
}

function renderRows(rows: readonly LeaderboardCardStanding[], fontFamily: string): string {
  if (rows.length === 0) return "";
  const startY = 716;
  const rowH = 56;
  const gap = 4;
  const panelH = 12 + rows.length * (rowH + gap);
  const body = rows
    .map((row, index) => {
      const y = startY + 8 + index * (rowH + gap);
      const cy = y + rowH / 2;
      return `<g>
        <rect x="48" y="${y}" width="984" height="${rowH}" rx="14" fill="${index % 2 === 0 ? "#16130e" : "#100e0b"}" stroke="#d4af37" stroke-opacity="0.35"/>
        ${medal(92, cy, 20, String(row.rank), "goldMetal", fontFamily)}
        ${rowEmblem(row.rank, 148, cy)}
        <clipPath id="row-clip-${row.rank}"><rect x="176" y="${y + 4}" width="840" height="${rowH - 8}"/></clipPath>
        <g clip-path="url(#row-clip-${row.rank})">${nameSvg(row.displayName, 184, cy + 14, 800, 40, 24, 1, fontFamily, "start")}</g>
      </g>`;
    })
    .join("");
  return `<g><rect x="36" y="${startY}" width="1008" height="${panelH}" rx="18" fill="#0c0a08" stroke="url(#goldMetal)" stroke-width="1.6"/>${body}</g>`;
}

function renderClimb(tips: readonly LeaderboardClimbTip[], fontFamily: string): string {
  if (tips.length === 0) return "";
  const y = 1176;
  const count = tips.length;
  const colW = 960 / count;
  const columns = tips
    .map((tip, index) => {
      const cx = 60 + colW * index + colW / 2;
      const title = climbDisplayTitle(tip.title);
      const kind = title.toUpperCase().includes("DEPOSIT")
        ? "DEPOSIT"
        : title.toUpperCase().includes("SPIN")
          ? "SPIN"
          : title.toUpperCase().includes("REFER")
            ? "REFER"
            : "PROMOTIONS";
      const detail = ellipsisToWidth(tip.detail, 15, colW - 16);
      return `<g>
        ${climbIcon(kind, cx, y + 36)}
        <text x="${cx}" y="${y + 78}" text-anchor="middle" fill="#fff6d8" font-family="${fontFamily}" font-size="16" font-weight="700">${escapeSvgText(title)}</text>
        <text x="${cx}" y="${y + 100}" text-anchor="middle" fill="#d9c79a" font-family="${fontFamily}" font-size="15" font-weight="700">${escapeSvgText(detail)}</text>
      </g>`;
    })
    .join("");
  return `<g>
    <text x="540" y="${y - 8}" text-anchor="middle" fill="url(#goldMetal)" font-family="${fontFamily}" font-size="16" font-weight="700" letter-spacing="3">HOW TO CLIMB</text>
    <rect x="48" y="${y}" width="984" height="128" rx="16" fill="#100e0b" stroke="url(#goldMetal)" stroke-width="1.4"/>
    ${columns}
  </g>`;
}

export async function renderPublicLeaderboardCard(
  input: LeaderboardCardInput
): Promise<LeaderboardCardRenderResult> {
  const started = Date.now();
  const svg = buildPublicLeaderboardCardSvg(input);
  const png = await sharp(Buffer.from(svg), { density: 72 })
    .resize(LEADERBOARD_CARD_WIDTH, LEADERBOARD_CARD_HEIGHT, { fit: "fill" })
    .png({ compressionLevel: 8 })
    .toBuffer();
  return {
    png,
    width: LEADERBOARD_CARD_WIDTH,
    height: LEADERBOARD_CARD_HEIGHT,
    renderMs: Date.now() - started,
    imageBytes: png.byteLength,
    svg
  };
}

export function isValidPngBuffer(buf: Buffer): boolean {
  return (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  );
}
