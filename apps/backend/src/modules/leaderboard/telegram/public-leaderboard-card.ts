/**
 * Deterministic public leaderboard card renderer (SVG → PNG).
 * Casino / jackpot tournament visual language. Pure input → Buffer.
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
/** Taller canvas for podium energy + how-to-climb without cramping Telegram width. */
export const LEADERBOARD_CARD_HEIGHT = 1800;

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

const PODIUM_NAME_MAX = 14;
const ROW_NAME_MAX = 20;

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
  if (len <= 4) return 118;
  if (len <= 6) return 100;
  if (len <= 8) return 86;
  if (len <= 10) return 74;
  return 62;
}

function shortEndLabel(endsAt: Date, timezone: string, now: Date): string {
  try {
    const full = formatCompetitionEndDisplay(endsAt, timezone, { now });
    const compact = full
      .replace(/^(\w+),/, (_, w: string) => w.slice(0, 3))
      .replace(" at ", " • ");
    return `ENDS ${compact}`.toUpperCase();
  } catch {
    return "ENDS TUE • 9:00 PM CT";
  }
}

function themeAccent(theme: LeaderboardCardTheme): { glow: string; badge: string; label: string } {
  switch (theme) {
    case "FINAL_24H":
      return { glow: "#ffb347", badge: "#c45c26", label: "FINAL 24 HOURS" };
    case "FROZEN":
      return { glow: "#8ec8ff", badge: "#3a5f8a", label: "FROZEN" };
    case "RESULTS":
      return { glow: "#d4af37", badge: "#6b5420", label: "RESULTS" };
    default:
      return { glow: "#f0d060", badge: "#3a2f14", label: "" };
  }
}

function movementColor(kind: RankMovementKind | undefined): string {
  if (kind === "up") return "#3dd68c";
  if (kind === "down") return "#ff6b6b";
  if (kind === "new") return "#5bb8ff";
  return "#9aa3b2";
}

function marqueeBulbs(cx: number, cy: number, w: number, h: number, count: number): string {
  const bulbs: string[] = [];
  const rx = w / 2;
  const ry = h / 2;
  for (let i = 0; i < count; i++) {
    const t = (i / count) * Math.PI * 2;
    // Slightly squircle path around rounded frame
    const bx = cx + rx * Math.cos(t) * 0.98;
    const by = cy + ry * Math.sin(t) * 0.98;
    const lit = i % 3 !== 2;
    bulbs.push(
      `<circle cx="${bx.toFixed(1)}" cy="${by.toFixed(1)}" r="${lit ? 5.2 : 4.2}" fill="${lit ? "#fff6d0" : "#c9a227"}" opacity="${lit ? 0.95 : 0.55}"/>
       <circle cx="${bx.toFixed(1)}" cy="${by.toFixed(1)}" r="2.2" fill="#ffffff" opacity="${lit ? 0.85 : 0.25}"/>`
    );
  }
  return bulbs.join("\n");
}

function edgeDecor(): string {
  // Floating chips / sparkles near outer edges — avoid covering text columns.
  const chips = [
    { x: 78, y: 520, r: 22, rot: -18 },
    { x: 1002, y: 560, r: 26, rot: 22 },
    { x: 70, y: 1100, r: 18, rot: 12 },
    { x: 1010, y: 1180, r: 20, rot: -28 },
    { x: 95, y: 1580, r: 16, rot: 8 },
    { x: 990, y: 1640, r: 18, rot: -14 }
  ];
  const chipSvg = chips
    .map(
      (c) => `
    <g transform="translate(${c.x} ${c.y}) rotate(${c.rot})" opacity="0.55">
      <circle r="${c.r}" fill="url(#chipGold)" stroke="#fff4c8" stroke-width="1.4"/>
      <circle r="${c.r * 0.62}" fill="none" stroke="#7a5c16" stroke-width="1.2" stroke-dasharray="3 4"/>
      <text y="5" text-anchor="middle" fill="#3a2a0a" font-size="11" font-weight="700">★</text>
    </g>`
    )
    .join("");

  const sparks: ReadonlyArray<readonly [number, number]> = [
    [140, 240],
    [920, 260],
    [160, 780],
    [940, 820],
    [200, 1400],
    [880, 1450],
    [540, 430],
    [480, 700],
    [620, 690]
  ];
  const sparkSvg = sparks
    .map(
      ([x, y], i) =>
        `<g opacity="${0.35 + (i % 3) * 0.12}">
          <circle cx="${x}" cy="${y}" r="1.8" fill="#fff8dc"/>
          <path d="M${x} ${y - 7} L${x + 1.2} ${y - 1.2} L${x + 7} ${y} L${x + 1.2} ${y + 1.2} L${x} ${y + 7} L${x - 1.2} ${y + 1.2} L${x - 7} ${y} L${x - 1.2} ${y - 1.2} Z" fill="#ffe9a0" opacity="0.7"/>
        </g>`
    )
    .join("");

  return `${chipSvg}${sparkSvg}`;
}

function lightBeams(): string {
  return `
  <g opacity="0.22">
    <path d="M540 760 L420 180 L460 180 Z" fill="url(#beamGold)"/>
    <path d="M540 760 L500 160 L540 160 Z" fill="url(#beamGold)"/>
    <path d="M540 760 L580 160 L620 160 Z" fill="url(#beamGold)"/>
    <path d="M540 760 L660 180 L700 180 Z" fill="url(#beamGold)"/>
  </g>`;
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
  const climbTips = input.climbTips ?? buildPublicLeaderboardClimbTips({ includeWheel: false });

  const ordered = [...input.standings]
    .filter((s) => s.rank >= 1 && s.rank <= 10)
    .sort((a, b) => a.rank - b.rank);

  const first = ordered.find((s) => s.rank === 1) ?? null;
  const second = ordered.find((s) => s.rank === 2) ?? null;
  const third = ordered.find((s) => s.rank === 3) ?? null;
  const rest = ordered.filter((s) => s.rank >= 4 && s.rank <= 10);

  const rowsStartY = 900;
  const podium = renderPodium(first, second, third, fonts.family);
  const rowsBlock = renderRows(rest, fonts.family, rowsStartY);
  const rowsBottom =
    rest.length === 0
      ? ordered.length === 0
        ? 860
        : 900
      : rowsStartY + 10 + rest.length * 58 + 10;
  const climbStartY = rowsBottom + 36;
  const climbTipCount = climbTips.length;
  const climbPanelH = climbTipCount === 0 ? 0 : 52 + climbTipCount * 42 + 12;
  const climb = renderClimbTips(climbTips, fonts.family, climbStartY);
  const bannerY = Math.min(
    climbTipCount === 0 ? climbStartY + 20 : climbStartY + climbPanelH + 28,
    1680
  );
  const empty =
    ordered.length === 0
      ? `<text x="540" y="780" text-anchor="middle" fill="#d7c58a" font-family="${fonts.family}" font-size="34" font-weight="700">The race starts here.</text>
         <text x="540" y="828" text-anchor="middle" fill="#9aa3b2" font-family="${fonts.family}" font-size="24">Be the first on the board.</text>`
      : "";

  const statusBadge = accent.label
    ? `<rect x="380" y="248" width="320" height="34" rx="17" fill="${accent.badge}" opacity="0.95"/>
       <text x="540" y="271" text-anchor="middle" fill="#f8fafc" font-family="${fonts.family}" font-size="15" font-weight="700" letter-spacing="2">${escapeSvgText(accent.label)}</text>`
    : "";

  const prizeFrameCy = 390;
  const prizeTextY = prizeFrameCy + prizeSize * 0.35;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${LEADERBOARD_CARD_WIDTH}" height="${LEADERBOARD_CARD_HEIGHT}" viewBox="0 0 ${LEADERBOARD_CARD_WIDTH} ${LEADERBOARD_CARD_HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.2" y2="1">
      <stop offset="0%" stop-color="#120e08"/>
      <stop offset="35%" stop-color="#0c0a07"/>
      <stop offset="70%" stop-color="#080706"/>
      <stop offset="100%" stop-color="#050403"/>
    </linearGradient>
    <radialGradient id="stageGlow" cx="50%" cy="42%" r="55%">
      <stop offset="0%" stop-color="${accent.glow}" stop-opacity="0.34"/>
      <stop offset="45%" stop-color="#d4af37" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="floorGlow" cx="50%" cy="78%" r="40%">
      <stop offset="0%" stop-color="#d4af37" stop-opacity="0.22"/>
      <stop offset="60%" stop-color="#d4af37" stop-opacity="0.05"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="vignette" cx="50%" cy="50%" r="74%">
      <stop offset="50%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.55"/>
    </radialGradient>
    <linearGradient id="beamGold" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0%" stop-color="#f6d56a" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#f6d56a" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="goldMetal" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#fff8dc"/>
      <stop offset="18%" stop-color="#ffe9a0"/>
      <stop offset="42%" stop-color="#f0d060"/>
      <stop offset="62%" stop-color="#d4af37"/>
      <stop offset="82%" stop-color="#a67c1a"/>
      <stop offset="100%" stop-color="#6b4e12"/>
    </linearGradient>
    <linearGradient id="goldMetalBright" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#fffcef"/>
      <stop offset="35%" stop-color="#ffe37a"/>
      <stop offset="70%" stop-color="#d4af37"/>
      <stop offset="100%" stop-color="#8a6914"/>
    </linearGradient>
    <linearGradient id="titleMetal" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#fff9e6"/>
      <stop offset="25%" stop-color="#f7e08a"/>
      <stop offset="50%" stop-color="#e0b83a"/>
      <stop offset="75%" stop-color="#b8922a"/>
      <stop offset="100%" stop-color="#7a5c16"/>
    </linearGradient>
    <linearGradient id="frameOuter" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#fff4c8"/>
      <stop offset="40%" stop-color="#d4af37"/>
      <stop offset="100%" stop-color="#7a5c16"/>
    </linearGradient>
    <linearGradient id="panel" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1a160f"/>
      <stop offset="50%" stop-color="#100e0a"/>
      <stop offset="100%" stop-color="#0a0907"/>
    </linearGradient>
    <linearGradient id="marqueeFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#2a2212"/>
      <stop offset="50%" stop-color="#16120a"/>
      <stop offset="100%" stop-color="#0e0b07"/>
    </linearGradient>
    <linearGradient id="podiumGoldFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#3a3018"/>
      <stop offset="35%" stop-color="#241c0e"/>
      <stop offset="100%" stop-color="#120e08"/>
    </linearGradient>
    <linearGradient id="podiumSilverFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#2a3038"/>
      <stop offset="50%" stop-color="#171b22"/>
      <stop offset="100%" stop-color="#0f1216"/>
    </linearGradient>
    <linearGradient id="podiumBronzeFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#3a2414"/>
      <stop offset="50%" stop-color="#1c140e"/>
      <stop offset="100%" stop-color="#100c09"/>
    </linearGradient>
    <linearGradient id="silverMetal" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#f5f7fa"/>
      <stop offset="45%" stop-color="#c5ccd6"/>
      <stop offset="100%" stop-color="#7a8494"/>
    </linearGradient>
    <linearGradient id="bronzeMetal" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#f3c9a0"/>
      <stop offset="45%" stop-color="#cd7f32"/>
      <stop offset="100%" stop-color="#7a4518"/>
    </linearGradient>
    <linearGradient id="rowFillA" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1c1810"/>
      <stop offset="100%" stop-color="#14110c"/>
    </linearGradient>
    <linearGradient id="rowFillB" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#16130e"/>
      <stop offset="100%" stop-color="#100e0a"/>
    </linearGradient>
    <linearGradient id="bannerFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#3a2e14"/>
      <stop offset="50%" stop-color="#1f180c"/>
      <stop offset="100%" stop-color="#14100a"/>
    </linearGradient>
    <linearGradient id="chipGold" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffe9a0"/>
      <stop offset="50%" stop-color="#d4af37"/>
      <stop offset="100%" stop-color="#8a6914"/>
    </linearGradient>
    <linearGradient id="quilt" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.07"/>
      <stop offset="50%" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.04"/>
    </linearGradient>
    <filter id="softGlow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="3.2" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
    <filter id="titleGlow" x="-20%" y="-40%" width="140%" height="180%">
      <feGaussianBlur stdDeviation="2.4" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
    <filter id="cardShadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#000000" flood-opacity="0.65"/>
    </filter>
    <filter id="leaderShadow" x="-30%" y="-30%" width="160%" height="170%">
      <feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#000000" flood-opacity="0.72"/>
    </filter>
    <style><![CDATA[
${fonts.css}
    ]]></style>
  </defs>

  <rect width="100%" height="100%" fill="url(#bg)"/>
  <rect width="100%" height="100%" fill="url(#stageGlow)"/>
  <rect x="120" y="900" width="840" height="520" fill="url(#floorGlow)"/>
  ${lightBeams()}
  <rect width="100%" height="100%" fill="url(#vignette)"/>
  ${edgeDecor()}

  <!-- Outer casino frame -->
  <rect x="36" y="36" width="1008" height="1728" rx="42" fill="none" stroke="url(#frameOuter)" stroke-width="3"/>
  <rect x="48" y="48" width="984" height="1704" rx="36" fill="url(#panel)" stroke="#3a3018" stroke-width="1.5"/>
  <rect x="56" y="56" width="968" height="1688" rx="32" fill="none" stroke="#fff4c8" stroke-opacity="0.08" stroke-width="1"/>

  <!-- Brand -->
  <text x="540" y="98" text-anchor="middle" fill="url(#goldMetal)" font-size="26">👑</text>
  <text x="540" y="132" text-anchor="middle" fill="#f4f0e6" font-family="${fonts.family}" font-size="22" font-weight="700" letter-spacing="6">${escapeSvgText(brand)}</text>
  <line x1="360" y1="148" x2="720" y2="148" stroke="url(#goldMetal)" stroke-opacity="0.55" stroke-width="1.5"/>

  <!-- Title: metallic LEADERBOARD hero -->
  <text x="540" y="188" text-anchor="middle" fill="#f7f1df" font-family="${fonts.family}" font-size="34" font-weight="700" letter-spacing="8">BIWEEKLY</text>
  <text x="542" y="248" text-anchor="middle" fill="#3a2a0a" font-family="${fonts.family}" font-size="58" font-weight="700" letter-spacing="5" opacity="0.55">LEADERBOARD</text>
  <text x="540" y="246" text-anchor="middle" fill="url(#titleMetal)" font-family="${fonts.family}" font-size="58" font-weight="700" letter-spacing="5" filter="url(#titleGlow)">LEADERBOARD</text>
  ${statusBadge}

  <!-- Prize marquee -->
  <text x="540" y="300" text-anchor="middle" fill="#e6cb72" font-family="${fonts.family}" font-size="18" font-weight="700" letter-spacing="6">PRIZE POOL</text>
  <rect x="250" y="318" width="580" height="148" rx="28" fill="url(#marqueeFill)" stroke="url(#frameOuter)" stroke-width="4" filter="url(#softGlow)"/>
  <rect x="262" y="330" width="556" height="124" rx="22" fill="none" stroke="#fff4c8" stroke-opacity="0.18" stroke-width="1.5"/>
  ${marqueeBulbs(540, 392, 560, 128, 28)}
  <text x="540" y="${prizeTextY}" text-anchor="middle" fill="url(#goldMetal)" font-family="${fonts.family}" font-size="${prizeSize}" font-weight="700" filter="url(#softGlow)" opacity="0.35">${escapeSvgText(prize)}</text>
  <text x="540" y="${prizeTextY}" text-anchor="middle" fill="url(#goldMetalBright)" font-family="${fonts.family}" font-size="${prizeSize}" font-weight="700">${escapeSvgText(prize)}</text>

  <!-- Countdown -->
  <text x="540" y="512" text-anchor="middle" fill="#fff6d8" font-family="${fonts.family}" font-size="30" font-weight="700" letter-spacing="2.5">⏱  ${escapeSvgText(countdown)}</text>
  <text x="540" y="544" text-anchor="middle" fill="#c9b88a" font-family="${fonts.family}" font-size="18" font-weight="600" letter-spacing="1.5">${escapeSvgText(endsLine)}</text>

  ${ordered.length === 0 ? empty : podium}
  ${rowsBlock}
  ${climb}

  <!-- Live banner footer -->
  <rect x="120" y="${bannerY}" width="840" height="64" rx="18" fill="url(#bannerFill)" stroke="url(#goldMetal)" stroke-width="2"/>
  <text x="540" y="${bannerY + 40}" text-anchor="middle" fill="#ffe9a0" font-family="${fonts.family}" font-size="22" font-weight="700" letter-spacing="1.5">👑  COMPETITION IS LIVE · KEEP CLIMBING!  👑</text>

  <!-- Suit footer -->
  <text x="540" y="${Math.min(bannerY + 100, 1768)}" text-anchor="middle" fill="#8a7a4a" font-family="${fonts.family}" font-size="15" letter-spacing="4">♠  ♦  ${escapeSvgText(brand)}  ♥  ♣</text>
</svg>`;
}

function renderPodium(
  first: LeaderboardCardStanding | null,
  second: LeaderboardCardStanding | null,
  third: LeaderboardCardStanding | null,
  fontFamily: string
): string {
  if (!first && !second && !third) return "";

  const slot = (
    standing: LeaderboardCardStanding | null,
    opts: {
      x: number;
      y: number;
      width: number;
      height: number;
      medal: string;
      fill: string;
      stroke: string;
      strokeWidth: number;
      nameSize: number;
      ptsSize: number;
      ptsFill: string;
      elevate: boolean;
      shadow: string;
    }
  ): string => {
    const cx = opts.x + opts.width / 2;
    if (!standing) {
      return `<rect x="${opts.x}" y="${opts.y}" width="${opts.width}" height="${opts.height}" rx="22" fill="#16120c" stroke="#2a2418" stroke-width="1" opacity="0.5"/>
        <text x="${cx}" y="${opts.y + opts.height / 2 + 6}" text-anchor="middle" fill="#4b5563" font-family="${fontFamily}" font-size="22">—</text>`;
    }
    const name = escapeSvgText(truncateLeaderboardName(standing.displayName, PODIUM_NAME_MAX));
    const pts = `${Math.trunc(Number.isFinite(standing.points) ? standing.points : 0)} PTS`;
    const move = formatRankMovementLabel(standing.movement);
    const moveCol = movementColor(standing.movement?.kind);
    const crown = opts.elevate
      ? `<g>
          <ellipse cx="${cx}" cy="${opts.y - 6}" rx="40" ry="12" fill="#d4af37" opacity="0.28"/>
          <text x="${cx}" y="${opts.y - 8}" text-anchor="middle" fill="url(#goldMetal)" font-size="34" font-weight="700">👑</text>
        </g>`
      : "";
    const quilt = opts.elevate
      ? `<rect x="${opts.x + 8}" y="${opts.y + 8}" width="${opts.width - 16}" height="${opts.height - 16}" rx="16" fill="url(#quilt)"/>`
      : `<rect x="${opts.x + 3}" y="${opts.y + 3}" width="${opts.width - 6}" height="${Math.max(30, opts.height * 0.28)}" rx="18" fill="#ffffff" opacity="0.04"/>`;
    const platform = opts.elevate
      ? `<ellipse cx="${cx}" cy="${opts.y + opts.height + 10}" rx="${opts.width * 0.42}" ry="14" fill="#d4af37" opacity="0.22"/>`
      : "";
    return `
      ${platform}
      ${crown}
      <rect x="${opts.x}" y="${opts.y}" width="${opts.width}" height="${opts.height}" rx="24" fill="${opts.fill}" stroke="${opts.stroke}" stroke-width="${opts.strokeWidth}" filter="url(#${opts.shadow})"/>
      ${quilt}
      <circle cx="${cx}" cy="${opts.y + 42}" r="18" fill="#0a0907" stroke="${opts.stroke}" stroke-width="1.8"/>
      <text x="${cx}" y="${opts.y + 48}" text-anchor="middle" fill="${opts.stroke}" font-family="${fontFamily}" font-size="16" font-weight="700">${opts.medal}</text>
      <text x="${cx}" y="${opts.y + 98}" text-anchor="middle" fill="#ffffff" font-family="${fontFamily}" font-size="${opts.nameSize}" font-weight="700">${name}</text>
      <text x="${cx}" y="${opts.y + 140}" text-anchor="middle" fill="${opts.ptsFill}" font-family="${fontFamily}" font-size="${opts.ptsSize}" font-weight="700">${escapeSvgText(pts)}</text>
      ${
        move
          ? `<text x="${cx}" y="${opts.y + 172}" text-anchor="middle" fill="${moveCol}" font-family="${fontFamily}" font-size="18" font-weight="700">${escapeSvgText(move)}</text>`
          : ""
      }
      <text x="${cx}" y="${opts.y + opts.height - 14}" text-anchor="middle" fill="${opts.stroke}" font-size="12" opacity="0.7">★</text>`;
  };

  const y1 = 575;
  const y23 = 635;
  return `
  <g>
    <!-- stage floor glow under podium -->
    <ellipse cx="540" cy="860" rx="380" ry="36" fill="#d4af37" opacity="0.14"/>
    ${slot(second, {
      x: 68,
      y: y23,
      width: 300,
      height: 220,
      medal: "2",
      fill: "url(#podiumSilverFill)",
      stroke: "url(#silverMetal)",
      strokeWidth: 2.2,
      nameSize: 28,
      ptsSize: 26,
      ptsFill: "url(#silverMetal)",
      elevate: false,
      shadow: "cardShadow"
    })}
    ${slot(first, {
      x: 348,
      y: y1,
      width: 384,
      height: 268,
      medal: "1",
      fill: "url(#podiumGoldFill)",
      stroke: "url(#goldMetal)",
      strokeWidth: 3.2,
      nameSize: 36,
      ptsSize: 32,
      ptsFill: "url(#goldMetal)",
      elevate: true,
      shadow: "leaderShadow"
    })}
    ${slot(third, {
      x: 712,
      y: y23,
      width: 300,
      height: 220,
      medal: "3",
      fill: "url(#podiumBronzeFill)",
      stroke: "url(#bronzeMetal)",
      strokeWidth: 2.2,
      nameSize: 28,
      ptsSize: 26,
      ptsFill: "url(#bronzeMetal)",
      elevate: false,
      shadow: "cardShadow"
    })}
  </g>`;
}

function renderRows(
  rows: readonly LeaderboardCardStanding[],
  fontFamily: string,
  startY: number
): string {
  if (rows.length === 0) return "";
  const rowH = 50;
  const gap = 8;
  const panelH = rows.length * (rowH + gap) - gap + 20;

  const body = rows
    .map((row, index) => {
      const y = startY + 10 + index * (rowH + gap);
      const fill = index % 2 === 0 ? "url(#rowFillA)" : "url(#rowFillB)";
      const rank = String(row.rank).padStart(2, "0");
      const name = escapeSvgText(truncateLeaderboardName(row.displayName, ROW_NAME_MAX));
      const move = formatRankMovementLabel(row.movement);
      const moveCol = movementColor(row.movement?.kind);
      const pts = Math.trunc(Number.isFinite(row.points) ? row.points : 0);
      return `
      <g>
        <rect x="92" y="${y}" width="896" height="${rowH}" rx="12" fill="${fill}" stroke="#3a3018" stroke-opacity="0.55" stroke-width="1"/>
        <circle cx="128" cy="${y + rowH / 2}" r="16" fill="#0a0907" stroke="url(#goldMetal)" stroke-width="1.5"/>
        <text x="128" y="${y + rowH / 2 + 6}" text-anchor="middle" fill="#e6cb72" font-family="${fontFamily}" font-size="15" font-weight="700">${rank}</text>
        <text x="168" y="${y + rowH / 2 + 7}" fill="#f5f1e6" font-family="${fontFamily}" font-size="22" font-weight="700">${name}</text>
        ${
          move
            ? `<text x="700" y="${y + rowH / 2 + 7}" text-anchor="middle" fill="${moveCol}" font-family="${fontFamily}" font-size="17" font-weight="700">${escapeSvgText(move)}</text>`
            : ""
        }
        <text x="948" y="${y + rowH / 2 + 7}" text-anchor="end" fill="url(#goldMetal)" font-family="${fontFamily}" font-size="20" font-weight="700">${pts} PTS</text>
      </g>`;
    })
    .join("\n");

  return `
  <g>
    <rect x="78" y="${startY}" width="924" height="${panelH}" rx="20" fill="#0c0a07" stroke="url(#goldMetal)" stroke-opacity="0.45" stroke-width="1.5"/>
    ${body}
  </g>`;
}

function renderClimbTips(
  tips: readonly LeaderboardClimbTip[],
  fontFamily: string,
  startY: number
): string {
  if (tips.length === 0) return "";
  const rowH = 42;
  const panelH = 52 + tips.length * rowH + 12;

  const lines = tips
    .map((tip, i) => {
      const y = startY + 56 + i * rowH;
      return `
      <text x="110" y="${y}" fill="#ffe9a0" font-size="20">${escapeSvgText(tip.icon)}</text>
      <text x="148" y="${y}" fill="#f0e6c8" font-family="${fontFamily}" font-size="18" font-weight="700" letter-spacing="1">${escapeSvgText(tip.title)}</text>
      <text x="970" y="${y}" text-anchor="end" fill="#c9b88a" font-family="${fontFamily}" font-size="17" font-weight="600">${escapeSvgText(tip.detail)}</text>
      ${
        i < tips.length - 1
          ? `<line x1="110" y1="${y + 14}" x2="970" y2="${y + 14}" stroke="#3a3018" stroke-opacity="0.7" stroke-width="1"/>`
          : ""
      }`;
    })
    .join("\n");

  return `
  <g>
    <rect x="78" y="${startY}" width="924" height="${panelH}" rx="18" fill="#120e08" stroke="url(#goldMetal)" stroke-opacity="0.5" stroke-width="1.5"/>
    <text x="540" y="${startY + 34}" text-anchor="middle" fill="url(#goldMetal)" font-family="${fontFamily}" font-size="20" font-weight="700" letter-spacing="3">⚡  HOW TO CLIMB</text>
    ${lines}
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
