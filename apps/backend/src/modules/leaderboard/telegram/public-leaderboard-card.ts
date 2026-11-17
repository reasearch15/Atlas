/**
 * Deterministic public leaderboard card renderer (SVG → PNG).
 * Luxury black / gold / purple tournament poster. Pure input → Buffer.
 * Decorative shapes are drawn in code. No baked-in names, amounts, or dates.
 */

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { formatCompetitionEndDisplay } from "./competition-end-display";
import {
  buildPublicLeaderboardClimbTips,
  type LeaderboardClimbTip
} from "./public-leaderboard-climb-tips";

export const LEADERBOARD_CARD_WIDTH = 1080;
/** Portrait canvas sized for Telegram mobile viewing. */
export const LEADERBOARD_CARD_HEIGHT = 1920;

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

function prizeFontSize(prizeText: string): number {
  const len = prizeText.length;
  if (len <= 4) return 92;
  if (len <= 6) return 84;
  if (len <= 8) return 72;
  if (len <= 10) return 62;
  return 52;
}

function shortEndLabel(endsAt: Date, timezone: string, now: Date): string {
  try {
    const full = formatCompetitionEndDisplay(endsAt, timezone, { now });
    const compact = full
      .replace(/^(\w+),/, (_, w: string) => w.slice(0, 3))
      .replace(" at ", " • ");
    return `ENDS ${compact}`.toUpperCase();
  } catch {
    return "END TIME UNAVAILABLE";
  }
}

function themeAccent(theme: LeaderboardCardTheme): { glow: string; label: string } {
  switch (theme) {
    case "FINAL_24H":
      return { glow: "#ffb347", label: "" };
    case "FROZEN":
      return { glow: "#8ec8ff", label: "FINALIZING" };
    case "RESULTS":
      return { glow: "#d4af37", label: "FINAL RESULTS" };
    default:
      return { glow: "#f0d060", label: "" };
  }
}

function bannerCopy(theme: LeaderboardCardTheme, countdown: string): string {
  if (theme === "RESULTS") return "FINAL RESULTS ARE IN";
  if (theme === "FROZEN") return "ROUND CLOSED — VERIFYING WINNERS";
  if (countdown === "ENDED") return "COMPETITION HAS ENDED";
  return "COMPETITION IS LIVE — KEEP CLIMBING!";
}

function countdownCopy(theme: LeaderboardCardTheme, countdown: string): string {
  if (theme === "RESULTS") return "FINAL RESULTS";
  if (theme === "FROZEN") return "FINALIZING";
  return countdown;
}

function cleanName(name: string): string {
  return (name || "Player").replace(/\s+/g, " ").trim() || "Player";
}

function textUnits(text: string): number {
  let units = 0;
  for (const ch of Array.from(text)) {
    const code = ch.codePointAt(0) ?? 0;
    if (code > 0x2e80) units += 1.15;
    else if (ch === " ") units += 0.36;
    else units += 0.74;
  }
  return units;
}

function layoutName(
  name: string,
  maxWidth: number,
  maxSize: number,
  minSize: number,
  maxLines: number
): { lines: string[]; size: number } {
  const cleaned = cleanName(name);
  const widthAt = (text: string, size: number) => textUnits(text) * size;
  const balanced = (size: number): string[] | null => {
    if (maxLines < 2) return null;
    const chars = Array.from(cleaned);
    if (chars.length < 8) return null;
    let best: string[] | null = null;
    let bestScore = Infinity;
    for (let index = 4; index <= chars.length - 4; index += 1) {
      const left = chars.slice(0, index).join("").trim();
      const right = chars.slice(index).join("").trim();
      if (Array.from(right).length < 4) continue;
      if (widthAt(left, size) > maxWidth || widthAt(right, size) > maxWidth) continue;
      const onSpace = chars[index] === " " || chars[index - 1] === " ";
      const score = Math.abs(Array.from(left).length - Array.from(right).length) + (onSpace ? 0 : 40);
      if (score < bestScore) {
        bestScore = score;
        best = [left, right];
      }
    }
    return best;
  };
  let oneLineSize = 0;
  for (let size = maxSize; size >= minSize; size -= 1) {
    if (widthAt(cleaned, size) <= maxWidth) {
      oneLineSize = size;
      break;
    }
  }
  if (oneLineSize > 0) {
    const wrapped = oneLineSize < maxSize - 2 ? balanced(Math.max(oneLineSize, minSize)) : null;
    if (wrapped && oneLineSize <= maxSize - 6) return { lines: wrapped, size: Math.max(oneLineSize, minSize) };
    return { lines: [cleaned], size: oneLineSize };
  }
  const wrapped = balanced(minSize);
  if (wrapped) return { lines: wrapped, size: minSize };
  const perLine = Math.max(6, Math.floor(maxWidth / (minSize * 0.74)));
  const words = cleaned.split(" ");
  const lines: string[] = [];
  let current = "";
  const push = (value: string) => {
    if (value && lines.length < maxLines) lines.push(value);
  };
  const chunkWord = (word: string) => {
    const chars = Array.from(word);
    let index = 0;
    while (index < chars.length && lines.length < maxLines) {
      const last = lines.length === maxLines - 1;
      const room = Math.max(1, last ? perLine - 1 : perLine);
      const slice = chars.slice(index, index + room).join("");
      index += room;
      push(index < chars.length && last ? `${slice}…` : slice);
      if (last) break;
    }
  };
  for (const word of words) {
    if (lines.length >= maxLines) break;
    if (Array.from(word).length > perLine) {
      push(current);
      current = "";
      chunkWord(word);
      continue;
    }
    const next = current ? `${current} ${word}` : word;
    if (Array.from(next).length <= perLine) current = next;
    else {
      push(current);
      current = word;
    }
  }
  push(current);
  return { lines: lines.length > 0 ? lines : [truncateLeaderboardName(cleaned, perLine)], size: minSize };
}

function nameBlock(
  name: string,
  x: number,
  y: number,
  maxWidth: number,
  maxSize: number,
  minSize: number,
  maxLines: number,
  fontFamily: string,
  anchor: "middle" | "start",
  fill = "#fffaf0"
): string {
  const layout = layoutName(name, maxWidth, maxSize, minSize, maxLines);
  const lineH = layout.size + 4;
  return layout.lines
    .map((line, index) => {
      const lineY = y + index * lineH;
      return `<text x="${x}" y="${lineY}" text-anchor="${anchor}" fill="${fill}" font-family="${fontFamily}" font-size="${layout.size}" font-weight="700">${escapeSvgText(line)}</text>`;
    })
    .join("\n");
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
    <path d="M-20 8 L-16 -8 L-7 1 L0 -14 L7 1 L16 -8 L20 8 Z" fill="${fill}"/>
    <rect x="-20" y="8" width="40" height="5" rx="1" fill="${fill}"/>
    <circle cx="-16" cy="-8" r="2" fill="#fff8dc"/>
    <circle cx="0" cy="-14" r="2.2" fill="#fff8dc"/>
    <circle cx="16" cy="-8" r="2" fill="#fff8dc"/>
  </g>`;
}

function laurel(cx: number, cy: number, flip: boolean): string {
  const dir = flip ? -1 : 1;
  const leaves: string[] = [];
  for (let i = 0; i < 8; i++) {
    const y = cy - 52 + i * 15;
    const x = cx + dir * (6 + Math.abs(i - 3.5) * 4);
    const rot = dir * (42 - i * 10);
    leaves.push(
      `<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="8" ry="16" transform="rotate(${rot.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})" fill="url(#goldMetal)" opacity="${0.55 + (i % 3) * 0.12}"/>`
    );
  }
  return leaves.join("\n");
}

function silhouette(cx: number, cy: number, color: string): string {
  return `<g fill="${color}" opacity="0.9">
    <circle cx="${cx}" cy="${cy}" r="18"/>
    <path d="M${cx - 28} ${cy + 52} C${cx - 24} ${cy + 22} ${cx - 10} ${cy + 16} ${cx} ${cy + 16} C${cx + 10} ${cy + 16} ${cx + 24} ${cy + 22} ${cx + 28} ${cy + 52} Z"/>
  </g>`;
}

function medal(cx: number, cy: number, radius: number, label: string, metalId: string, fontFamily: string): string {
  const font = Math.round(radius * (label.length > 1 ? 0.8 : 0.92));
  const inner = Math.round(radius * 0.74);
  return `<circle cx="${cx}" cy="${cy}" r="${radius + 4}" fill="#000000" opacity="0.35"/>
    <circle cx="${cx}" cy="${cy}" r="${radius}" fill="url(#${metalId})" stroke="#fff6d0" stroke-opacity="0.7" stroke-width="1.6"/>
    <circle cx="${cx}" cy="${cy}" r="${inner}" fill="#120e09"/>
    <text x="${cx}" y="${cy + font * 0.36}" text-anchor="middle" fill="#fff8e7" font-family="${fontFamily}" font-size="${font}" font-weight="700">${escapeSvgText(label)}</text>`;
}

function coinStack(x: number, y: number): string {
  return [0, 1, 2, 3, 4]
    .map(
      (i) =>
        `<ellipse cx="${x}" cy="${y - i * 9}" rx="26" ry="9" fill="url(#goldMetal)" stroke="#fff4c8" stroke-opacity="0.55" stroke-width="0.8"/>`
    )
    .join("\n");
}

function particles(): string {
  const spots: ReadonlyArray<readonly [number, number, number]> = [
    [150, 250, 1.6],
    [930, 220, 1.8],
    [180, 430, 1.4],
    [900, 470, 1.5],
    [210, 690, 1.3],
    [860, 740, 1.7],
    [140, 980, 1.4],
    [940, 1040, 1.5],
    [200, 1280, 1.2],
    [880, 1360, 1.4],
    [480, 300, 1.1],
    [620, 560, 1.2]
  ];
  return spots
    .map(
      ([x, y, r], i) =>
        `<g opacity="${0.35 + (i % 4) * 0.1}">
          <circle cx="${x}" cy="${y}" r="${r}" fill="#fff8dc"/>
          <path d="M${x} ${y - 8} L${x + 1.4} ${y - 1.4} L${x + 8} ${y} L${x + 1.4} ${y + 1.4} L${x} ${y + 8} L${x - 1.4} ${y + 1.4} L${x - 8} ${y} L${x - 1.4} ${y - 1.4} Z" fill="#ffe9a0" opacity="0.75"/>
        </g>`
    )
    .join("\n");
}

function curtains(): string {
  return `<g opacity="0.95">
    <path d="M0 0 C70 80 18 220 64 420 C16 640 78 860 28 1120 C70 1380 12 1640 0 1920 L0 0 Z" fill="url(#curtainLeft)"/>
    <path d="M0 0 C46 140 8 360 40 620 C10 900 52 1200 8 1500 C36 1720 0 1860 0 1920 L0 0 Z" fill="#2a0d4a" opacity="0.45"/>
    <path d="M1080 0 C1010 80 1062 220 1016 420 C1064 640 1002 860 1052 1120 C1010 1380 1068 1640 1080 1920 L1080 0 Z" fill="url(#curtainRight)"/>
    <path d="M1080 0 C1034 140 1072 360 1040 620 C1070 900 1028 1200 1072 1500 C1044 1720 1080 1860 1080 1920 L1080 0 Z" fill="#2a0d4a" opacity="0.45"/>
  </g>`;
}

function miniPerson(cx: number, cy: number): string {
  return `<g fill="#f0ddb0">
    <circle cx="${cx}" cy="${cy - 6}" r="6.5"/>
    <path d="M${cx - 11} ${cy + 11} C${cx - 9} ${cy - 1} ${cx - 4} ${cy - 3} ${cx} ${cy - 3} C${cx + 4} ${cy - 3} ${cx + 9} ${cy - 1} ${cx + 11} ${cy + 11} Z"/>
  </g>`;
}

function climbIcon(kind: string, cx: number, cy: number): string {
  if (kind === "DEPOSIT") {
    return `<g>
      <ellipse cx="${cx}" cy="${cy + 16}" rx="22" ry="8" fill="url(#goldMetal)"/>
      <ellipse cx="${cx}" cy="${cy + 8}" rx="22" ry="8" fill="url(#goldMetal)"/>
      <ellipse cx="${cx}" cy="${cy}" rx="22" ry="8" fill="url(#goldMetalBright)" stroke="#fff4c8" stroke-width="0.8"/>
    </g>`;
  }
  if (kind === "SPIN") {
    return `<g>
      <circle cx="${cx}" cy="${cy + 6}" r="20" fill="none" stroke="url(#goldMetal)" stroke-width="3"/>
      <circle cx="${cx}" cy="${cy + 6}" r="5" fill="url(#goldMetal)"/>
      <path d="M${cx} ${cy - 14} L${cx + 6} ${cy + 4} L${cx - 2} ${cy + 2} Z" fill="#fff4c8"/>
      <path d="M${cx} ${cy + 26} L${cx - 6} ${cy + 8} L${cx + 2} ${cy + 10} Z" fill="#d4af37"/>
    </g>`;
  }
  if (kind === "REFER") {
    return `<g fill="url(#goldMetal)">
      <circle cx="${cx - 8}" cy="${cy - 2}" r="8"/>
      <circle cx="${cx + 10}" cy="${cy}" r="6.5"/>
      <path d="M${cx - 22} ${cy + 22} C${cx - 18} ${cy + 8} ${cx - 8} ${cy + 6} ${cx} ${cy + 10} C${cx - 4} ${cy + 8} ${cx + 2} ${cy + 10} ${cx + 4} ${cy + 22} Z"/>
      <path d="M${cx + 2} ${cy + 22} C${cx + 6} ${cy + 10} ${cx + 14} ${cy + 8} ${cx + 22} ${cy + 22} Z"/>
    </g>`;
  }
  return `<g>
    <path d="M${cx} ${cy - 16} L${cx + 8} ${cy - 2} L${cx + 16} ${cy + 16} L${cx - 16} ${cy + 16} L${cx - 8} ${cy - 2} Z" fill="url(#goldMetal)"/>
    <rect x="${cx - 14}" y="${cy + 16}" width="28" height="6" rx="1" fill="url(#goldMetalBright)"/>
    <rect x="${cx - 6}" y="${cy + 6}" width="12" height="10" fill="#fff4c8" opacity="0.35"/>
  </g>`;
}

function climbKind(title: string): string {
  const upper = climbDisplayTitle(title).toUpperCase();
  if (upper.includes("DEPOSIT")) return "DEPOSIT";
  if (upper.includes("SPIN") || upper.includes("WHEEL")) return "SPIN";
  if (upper.includes("REFER")) return "REFER";
  return "PROMOTIONS";
}

export function buildPublicLeaderboardCardSvg(input: LeaderboardCardInput): string {
  const now = input.now ?? new Date();
  const theme = input.theme ?? resolveLeaderboardCardTheme(input.competitionStatus, input.endsAt, now);
  const accent = themeAccent(theme);
  const fonts = resolveBundledFonts();
  const brand = truncateLeaderboardName(input.brandName.trim() || "LEADERBOARD", 32).toUpperCase();
  const prize = formatPrizePoolHero(input.prizePoolCents);
  const prizeSize = prizeFontSize(prize);
  const countdown = formatCountdownLeft(input.endsAt, now);
  const endsLine = shortEndLabel(input.endsAt, input.timezone, now);
  const headline = countdownCopy(theme, countdown);
  const footer = bannerCopy(theme, countdown);
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
  const showPodium = ordered.length > 0;

  const podium = showPodium ? renderPodium(first, second, third, fonts.family) : "";
  const rowsBlock = renderRows(rest, fonts.family);
  const empty =
    ordered.length === 0
      ? `<text x="540" y="1120" text-anchor="middle" fill="#f0d78a" font-family="${fonts.family}" font-size="36" font-weight="700">The race starts here.</text>
         <text x="540" y="1168" text-anchor="middle" fill="#c9b88a" font-family="${fonts.family}" font-size="22">Be the first on the board.</text>`
      : "";
  const climb = renderClimbTips(climbTips, fonts.family);
  const prizeY = 430 + Math.round(prizeSize * 0.28);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${LEADERBOARD_CARD_WIDTH}" height="${LEADERBOARD_CARD_HEIGHT}" viewBox="0 0 ${LEADERBOARD_CARD_WIDTH} ${LEADERBOARD_CARD_HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#140818"/>
      <stop offset="28%" stop-color="#07060a"/>
      <stop offset="70%" stop-color="#050403"/>
      <stop offset="100%" stop-color="#09060f"/>
    </linearGradient>
    <linearGradient id="curtainLeft" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#3a1468"/>
      <stop offset="55%" stop-color="#5a2394"/>
      <stop offset="100%" stop-color="#1a082e"/>
    </linearGradient>
    <linearGradient id="curtainRight" x1="1" y1="0" x2="0" y2="0">
      <stop offset="0%" stop-color="#3a1468"/>
      <stop offset="55%" stop-color="#5a2394"/>
      <stop offset="100%" stop-color="#1a082e"/>
    </linearGradient>
    <radialGradient id="stageGlow" cx="50%" cy="22%" r="48%">
      <stop offset="0%" stop-color="${accent.glow}" stop-opacity="0.42"/>
      <stop offset="42%" stop-color="#d4af37" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="podiumGlow" cx="50%" cy="48%" r="36%">
      <stop offset="0%" stop-color="#f0d060" stop-opacity="0.28"/>
      <stop offset="55%" stop-color="#d4af37" stop-opacity="0.08"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="vignette" cx="50%" cy="45%" r="72%">
      <stop offset="62%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.55"/>
    </radialGradient>
    <linearGradient id="goldMetal" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#fff8dc"/>
      <stop offset="22%" stop-color="#ffe08a"/>
      <stop offset="48%" stop-color="#e0b03a"/>
      <stop offset="74%" stop-color="#a67c1a"/>
      <stop offset="100%" stop-color="#6b4e12"/>
    </linearGradient>
    <linearGradient id="goldMetalBright" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#fffcef"/>
      <stop offset="40%" stop-color="#ffe37a"/>
      <stop offset="100%" stop-color="#b8922a"/>
    </linearGradient>
    <linearGradient id="silverMetal" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="45%" stop-color="#c5ccd6"/>
      <stop offset="100%" stop-color="#6d7684"/>
    </linearGradient>
    <linearGradient id="bronzeMetal" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#f6d2ae"/>
      <stop offset="46%" stop-color="#cd7f32"/>
      <stop offset="100%" stop-color="#7a4518"/>
    </linearGradient>
    <linearGradient id="prizeFrame" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#3a2c12"/>
      <stop offset="50%" stop-color="#120e08"/>
      <stop offset="100%" stop-color="#070605"/>
    </linearGradient>
    <linearGradient id="podiumGoldFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#4a3a16"/>
      <stop offset="40%" stop-color="#241c0c"/>
      <stop offset="100%" stop-color="#100d08"/>
    </linearGradient>
    <linearGradient id="podiumSilverFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#343a44"/>
      <stop offset="50%" stop-color="#1a1e26"/>
      <stop offset="100%" stop-color="#101318"/>
    </linearGradient>
    <linearGradient id="podiumBronzeFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#4a2c16"/>
      <stop offset="50%" stop-color="#24160e"/>
      <stop offset="100%" stop-color="#120d09"/>
    </linearGradient>
    <linearGradient id="rowA" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1c1812"/>
      <stop offset="100%" stop-color="#12100c"/>
    </linearGradient>
    <linearGradient id="rowB" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#16130e"/>
      <stop offset="100%" stop-color="#0d0b09"/>
    </linearGradient>
    <linearGradient id="bannerFill" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#2a210f"/>
      <stop offset="50%" stop-color="#4a3816"/>
      <stop offset="100%" stop-color="#2a210f"/>
    </linearGradient>
    <linearGradient id="ribbon" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffe7a4"/>
      <stop offset="50%" stop-color="#d4af37"/>
      <stop offset="100%" stop-color="#8a6914"/>
    </linearGradient>
    <filter id="softGlow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="2.2" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
    <filter id="cardShadow" x="-15%" y="-15%" width="130%" height="145%">
      <feDropShadow dx="0" dy="8" stdDeviation="8" flood-color="#000000" flood-opacity="0.55"/>
    </filter>
    <style><![CDATA[
${fonts.css}
    ]]></style>
  </defs>

  <rect width="100%" height="100%" fill="url(#bg)"/>
  <rect width="100%" height="100%" fill="url(#stageGlow)"/>
  <rect x="180" y="860" width="720" height="280" fill="url(#podiumGlow)"/>
  ${curtains()}
  <rect width="100%" height="100%" fill="url(#vignette)"/>
  ${particles()}

  ${crown(540, 62, 1.15, "url(#goldMetal)")}
  <text x="540" y="112" text-anchor="middle" fill="#f4e7c3" font-family="${fonts.family}" font-size="20" font-weight="700" letter-spacing="5.5">${escapeSvgText(brand)}</text>

  ${laurel(250, 196, false)}
  ${laurel(830, 196, true)}
  <text x="540" y="176" text-anchor="middle" fill="#f7f1df" font-family="${fonts.family}" font-size="26" font-weight="700" letter-spacing="8">BIWEEKLY</text>
  <text x="540" y="252" text-anchor="middle" fill="url(#goldMetal)" font-family="${fonts.family}" font-size="64" font-weight="700" letter-spacing="3" filter="url(#softGlow)">LEADERBOARD</text>

  <path d="M390 286 L450 286 L462 304 L450 322 L390 322 L378 304 Z" fill="url(#ribbon)"/>
  <rect x="450" y="286" width="180" height="36" fill="url(#ribbon)"/>
  <path d="M690 286 L630 286 L618 304 L630 322 L690 322 L702 304 Z" fill="url(#ribbon)"/>
  <text x="540" y="311" text-anchor="middle" fill="#3a2808" font-family="${fonts.family}" font-size="16" font-weight="700" letter-spacing="3.2">PRIZE POOL</text>

  ${coinStack(132, 430)}
  ${coinStack(948, 430)}
  <rect x="188" y="348" width="704" height="156" rx="28" fill="url(#prizeFrame)" stroke="url(#goldMetal)" stroke-width="4" filter="url(#softGlow)"/>
  <rect x="202" y="362" width="676" height="128" rx="20" fill="none" stroke="#fff4c8" stroke-opacity="0.2" stroke-width="1.5"/>
  <text x="540" y="${prizeY}" text-anchor="middle" fill="url(#goldMetalBright)" font-family="${fonts.family}" font-size="${prizeSize}" font-weight="700">${escapeSvgText(prize)}</text>

  <rect x="330" y="528" width="420" height="58" rx="29" fill="#120e08" stroke="url(#goldMetal)" stroke-width="2"/>
  <circle cx="392" cy="557" r="12" fill="none" stroke="#ffe7a4" stroke-width="2"/>
  <path d="M392 550 L392 557 L398 561" fill="none" stroke="#ffe7a4" stroke-width="2" stroke-linecap="round"/>
  <text x="560" y="566" text-anchor="middle" fill="#fff6d8" font-family="${fonts.family}" font-size="24" font-weight="700" letter-spacing="1.4">${escapeSvgText(headline)}</text>
  <text x="540" y="618" text-anchor="middle" fill="#d7c49a" font-family="${fonts.family}" font-size="16" font-weight="700" letter-spacing="1.1">${escapeSvgText(endsLine)}</text>

  ${empty}
  ${podium}
  ${rowsBlock}
  ${climb}

  <rect x="96" y="1768" width="888" height="68" rx="18" fill="url(#bannerFill)" stroke="url(#goldMetal)" stroke-width="2"/>
  <text x="540" y="1810" text-anchor="middle" fill="#ffe7a4" font-family="${fonts.family}" font-size="22" font-weight="700" letter-spacing="1.2">${escapeSvgText(footer)}</text>
  <text x="540" y="1876" text-anchor="middle" fill="#c9a85a" font-family="${fonts.family}" font-size="15" font-weight="700" letter-spacing="4">◆  ${escapeSvgText(brand)}  ◆</text>
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
      width: number;
      height: number;
      rank: string;
      metal: string;
      fill: string;
      nameSize: number;
    }
  ): string => {
    const cx = opts.x + opts.width / 2;
    const medalCy = opts.y + 8;
    const name = standing
      ? nameBlock(
          standing.displayName,
          cx,
          opts.y + opts.height - 64,
          opts.width - 36,
          opts.nameSize,
          15,
          2,
          fontFamily
        ,
          "middle"
        )
      : `<text x="${cx}" y="${opts.y + opts.height - 36}" text-anchor="middle" fill="#8a7a55" font-family="${fontFamily}" font-size="18" font-weight="700">OPEN</text>`;
    return `<g filter="url(#cardShadow)">
      <rect x="${opts.x}" y="${opts.y + 28}" width="${opts.width}" height="${opts.height - 28}" rx="26" fill="${opts.fill}" stroke="url(#${opts.metal})" stroke-width="${opts.rank === "1" ? 3.2 : 2.2}"/>
      <rect x="${opts.x + 10}" y="${opts.y + 36}" width="${opts.width - 20}" height="46" rx="16" fill="#ffffff" opacity="0.04"/>
      ${medal(cx, medalCy, opts.rank === "1" ? 36 : 30, opts.rank, opts.metal, fontFamily)}
      ${crown(cx, medalCy - (opts.rank === "1" ? 62 : 54), opts.rank === "1" ? 0.95 : 0.75, `url(#${opts.metal})`)}
      ${silhouette(cx, opts.y + 96, opts.rank === "2" ? "#d5dbe3" : opts.rank === "3" ? "#e0b088" : "#f3e2a8")}
      ${name}
    </g>`;
  };

  return `<g>
    <ellipse cx="540" cy="1024" rx="390" ry="18" fill="#d4af37" opacity="0.16"/>
    ${slot(second, {
      x: 78,
      y: 730,
      width: 286,
      height: 260,
      rank: "2",
      metal: "silverMetal",
      fill: "url(#podiumSilverFill)",
      nameSize: 22
    })}
    ${slot(third, {
      x: 716,
      y: 730,
      width: 286,
      height: 260,
      rank: "3",
      metal: "bronzeMetal",
      fill: "url(#podiumBronzeFill)",
      nameSize: 22
    })}
    ${slot(first, {
      x: 372,
      y: 690,
      width: 336,
      height: 300,
      rank: "1",
      metal: "goldMetal",
      fill: "url(#podiumGoldFill)",
      nameSize: 26
    })}
  </g>`;
}

function renderRows(rows: readonly LeaderboardCardStanding[], fontFamily: string): string {
  if (rows.length === 0) return "";
  const startY = 1028;
  const rowH = 60;
  const gap = 4;
  const panelH = 18 + rows.length * (rowH + gap);
  const body = rows
    .map((row, index) => {
      const y = startY + 12 + index * (rowH + gap);
      const fill = index % 2 === 0 ? "url(#rowA)" : "url(#rowB)";
      const cy = y + rowH / 2;
      return `<g>
        <rect x="108" y="${y}" width="864" height="${rowH}" rx="14" fill="${fill}"/>
        ${medal(156, cy, 22, String(row.rank), "goldMetal", fontFamily)}
        ${miniPerson(210, cy)}
        ${nameBlock(row.displayName, 236, cy + 8, 690, 24, 15, 1, fontFamily, "start")}
      </g>`;
    })
    .join("\n");

  return `<g>
    <rect x="92" y="${startY}" width="896" height="${panelH}" rx="22" fill="#0c0a08" stroke="url(#goldMetal)" stroke-width="2"/>
    ${body}
  </g>`;
}

function renderClimbTips(tips: readonly LeaderboardClimbTip[], fontFamily: string): string {
  if (tips.length === 0) return "";
  const panelY = 1556;
  const panelH = 188;
  const count = tips.length;
  const colW = 840 / count;
  const columns = tips
    .map((tip, index) => {
      const cx = 120 + colW * index + colW / 2;
      const title = climbDisplayTitle(tip.title);
      const kind = climbKind(tip.title);
      const detail = nameBlock(tip.detail, cx, panelY + 146, colW - 28, 15, 13, 2, fontFamily, "middle", "#d9c79a");
      const divider =
        index < count - 1
          ? `<line x1="${120 + colW * (index + 1)}" y1="${panelY + 36}" x2="${120 + colW * (index + 1)}" y2="${panelY + panelH - 28}" stroke="#d4af37" stroke-opacity="0.28" stroke-width="1"/>`
          : "";
      return `<g>
        ${climbIcon(kind, cx, panelY + 58)}
        <text x="${cx}" y="${panelY + 116}" text-anchor="middle" fill="#fff6d8" font-family="${fontFamily}" font-size="16" font-weight="700" letter-spacing="1.1">${escapeSvgText(title)}</text>
        ${detail}
        ${divider}
      </g>`;
    })
    .join("\n");

  return `<g>
    <text x="540" y="${panelY - 16}" text-anchor="middle" fill="url(#goldMetal)" font-family="${fontFamily}" font-size="18" font-weight="700" letter-spacing="3.4">HOW TO CLIMB</text>
    <rect x="96" y="${panelY}" width="888" height="${panelH}" rx="20" fill="#100e0b" stroke="url(#goldMetal)" stroke-width="1.6"/>
    ${columns}
  </g>`;
}

/**
 * Render the premium public leaderboard card as a PNG buffer.
 */
export async function renderPublicLeaderboardCard(
  input: LeaderboardCardInput
): Promise<LeaderboardCardRenderResult> {
  const started = Date.now();
  const svg = buildPublicLeaderboardCardSvg(input);
  const png = await sharp(Buffer.from(svg), { density: 96 })
    .resize(LEADERBOARD_CARD_WIDTH, LEADERBOARD_CARD_HEIGHT, { fit: "fill" })
    .png({ compressionLevel: 8 })
    .toBuffer();
  const renderMs = Date.now() - started;
  return {
    png,
    width: LEADERBOARD_CARD_WIDTH,
    height: LEADERBOARD_CARD_HEIGHT,
    renderMs,
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
