/**
 * Deterministic public leaderboard card renderer (SVG → PNG).
 * Pure input → Buffer. No Prisma / network.
 */

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { formatCompetitionEndDisplay } from "./competition-end-display";

export const LEADERBOARD_CARD_WIDTH = 1080;
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
const ROW_NAME_MAX = 18;

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
  if (len <= 4) return 136;
  if (len <= 6) return 116;
  if (len <= 8) return 98;
  if (len <= 10) return 84;
  return 70;
}

function shortEndLabel(endsAt: Date, timezone: string, now: Date): string {
  try {
    const full = formatCompetitionEndDisplay(endsAt, timezone, { now });
    // "Tuesday, Aug 26 at 9:00 PM CDT" → "Tue Aug 26 • 9:00 PM CDT"
    const compact = full
      .replace(/^(\w+),/, (_, w: string) => w.slice(0, 3))
      .replace(" at ", " • ");
    return `Ends ${compact}`;
  } catch {
    return "Ends Tue • 9:00 PM CT";
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
      return { glow: "#d4af37", badge: "#3a2f14", label: "" };
  }
}

function movementColor(kind: RankMovementKind | undefined): string {
  if (kind === "up") return "#3dd68c";
  if (kind === "down") return "#ff6b6b";
  if (kind === "new") return "#5bb8ff";
  return "#9aa3b2";
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

  const ordered = [...input.standings]
    .filter((s) => s.rank >= 1 && s.rank <= 10)
    .sort((a, b) => a.rank - b.rank);

  const first = ordered.find((s) => s.rank === 1) ?? null;
  const second = ordered.find((s) => s.rank === 2) ?? null;
  const third = ordered.find((s) => s.rank === 3) ?? null;
  const rest = ordered.filter((s) => s.rank >= 4 && s.rank <= 10);

  const podium = renderPodium(first, second, third, fonts.family);
  const rows = renderRows(rest, fonts.family);
  const empty =
    ordered.length === 0
      ? `<text x="540" y="640" text-anchor="middle" fill="#a7b0bd" font-family="${fonts.family}" font-size="36" font-weight="400">The race starts here.</text>
         <text x="540" y="688" text-anchor="middle" fill="#7a8494" font-family="${fonts.family}" font-size="24">Be the first on the board.</text>`
      : "";

  const statusBadge = accent.label
    ? `<rect x="390" y="196" width="300" height="34" rx="17" fill="${accent.badge}" opacity="0.95"/>
       <text x="540" y="219" text-anchor="middle" fill="#f8fafc" font-family="${fonts.family}" font-size="15" font-weight="700" letter-spacing="2">${escapeSvgText(accent.label)}</text>`
    : "";

  const prizeY = 286 + prizeSize * 0.78;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${LEADERBOARD_CARD_WIDTH}" height="${LEADERBOARD_CARD_HEIGHT}" viewBox="0 0 ${LEADERBOARD_CARD_WIDTH} ${LEADERBOARD_CARD_HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0%" stop-color="#0d0f14"/>
      <stop offset="40%" stop-color="#12151c"/>
      <stop offset="100%" stop-color="#090a0e"/>
    </linearGradient>
    <linearGradient id="panel" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1c2029"/>
      <stop offset="55%" stop-color="#151821"/>
      <stop offset="100%" stop-color="#10131a"/>
    </linearGradient>
    <linearGradient id="panelStroke" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#3a4252"/>
      <stop offset="50%" stop-color="#2a303c"/>
      <stop offset="100%" stop-color="#1c212b"/>
    </linearGradient>
    <radialGradient id="prizeLight" cx="50%" cy="28%" r="42%">
      <stop offset="0%" stop-color="${accent.glow}" stop-opacity="0.28"/>
      <stop offset="40%" stop-color="${accent.glow}" stop-opacity="0.10"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="leaderLight" cx="50%" cy="48%" r="28%">
      <stop offset="0%" stop-color="#d4af37" stop-opacity="0.18"/>
      <stop offset="55%" stop-color="#d4af37" stop-opacity="0.05"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="vignette" cx="50%" cy="50%" r="72%">
      <stop offset="55%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.45"/>
    </radialGradient>
    <linearGradient id="goldMetal" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#fff4c8"/>
      <stop offset="22%" stop-color="#f0d78a"/>
      <stop offset="48%" stop-color="#d4af37"/>
      <stop offset="72%" stop-color="#b8922a"/>
      <stop offset="100%" stop-color="#7a5c16"/>
    </linearGradient>
    <linearGradient id="goldMetalEdge" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#fff8dc"/>
      <stop offset="100%" stop-color="#c9a227"/>
    </linearGradient>
    <linearGradient id="podiumGoldFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#2a2418"/>
      <stop offset="45%" stop-color="#1a1812"/>
      <stop offset="100%" stop-color="#12100c"/>
    </linearGradient>
    <linearGradient id="podiumSilverFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#22262e"/>
      <stop offset="50%" stop-color="#171b22"/>
      <stop offset="100%" stop-color="#12151b"/>
    </linearGradient>
    <linearGradient id="podiumBronzeFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#261c14"/>
      <stop offset="50%" stop-color="#19140f"/>
      <stop offset="100%" stop-color="#120e0b"/>
    </linearGradient>
    <linearGradient id="silverMetal" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#f2f5f8"/>
      <stop offset="45%" stop-color="#c5ccd6"/>
      <stop offset="100%" stop-color="#8b95a3"/>
    </linearGradient>
    <linearGradient id="bronzeMetal" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#f0c49a"/>
      <stop offset="45%" stop-color="#cd7f32"/>
      <stop offset="100%" stop-color="#8a4f1a"/>
    </linearGradient>
    <linearGradient id="rowFillA" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1a1f29"/>
      <stop offset="100%" stop-color="#151922"/>
    </linearGradient>
    <linearGradient id="rowFillB" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#161a22"/>
      <stop offset="100%" stop-color="#12151c"/>
    </linearGradient>
    <linearGradient id="pillFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#252b38"/>
      <stop offset="100%" stop-color="#1a1f2a"/>
    </linearGradient>
    <filter id="prizeGlow" x="-25%" y="-25%" width="150%" height="150%">
      <feGaussianBlur stdDeviation="2.8" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
    <filter id="cardShadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="8" stdDeviation="10" flood-color="#000000" flood-opacity="0.55"/>
    </filter>
    <filter id="leaderShadow" x="-25%" y="-25%" width="150%" height="160%">
      <feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#000000" flood-opacity="0.65"/>
    </filter>
    <style><![CDATA[
${fonts.css}
    ]]></style>
  </defs>

  <rect width="100%" height="100%" fill="url(#bg)"/>
  <rect x="0" y="0" width="1080" height="560" fill="url(#prizeLight)"/>
  <rect x="220" y="450" width="640" height="340" fill="url(#leaderLight)"/>
  <rect width="100%" height="100%" fill="url(#vignette)"/>

  <!-- Outer frame -->
  <rect x="40" y="40" width="1000" height="1270" rx="38" fill="none" stroke="#0a0b0e" stroke-width="8"/>
  <rect x="48" y="48" width="984" height="1254" rx="34" fill="url(#panel)" stroke="url(#panelStroke)" stroke-width="1.75"/>
  <rect x="52" y="52" width="976" height="1246" rx="31" fill="none" stroke="#ffffff" stroke-opacity="0.04" stroke-width="1"/>

  <!-- Brand -->
  <text x="540" y="102" text-anchor="middle" fill="#f2f4f7" font-family="${fonts.family}" font-size="24" font-weight="700" letter-spacing="5">${escapeSvgText(brand)}</text>
  <line x1="400" y1="118" x2="680" y2="118" stroke="#d4af37" stroke-opacity="0.42" stroke-width="1.35"/>

  <!-- Title -->
  <text x="540" y="164" text-anchor="middle" fill="#f7f8fa" font-family="${fonts.family}" font-size="52" font-weight="700" letter-spacing="6.5">BIWEEKLY</text>
  <text x="540" y="216" text-anchor="middle" fill="#f7f8fa" font-family="${fonts.family}" font-size="52" font-weight="700" letter-spacing="6.5">LEADERBOARD</text>
  ${statusBadge}

  <!-- Prize hero: controlled metallic glow + sharp primary -->
  <text x="540" y="262" text-anchor="middle" fill="#e6cb72" font-family="${fonts.family}" font-size="20" font-weight="700" letter-spacing="5.5">PRIZE POOL</text>
  <text x="540" y="${prizeY}" text-anchor="middle" fill="url(#goldMetal)" font-family="${fonts.family}" font-size="${prizeSize}" font-weight="700" filter="url(#prizeGlow)" opacity="0.38">${escapeSvgText(prize)}</text>
  <text x="540" y="${prizeY}" text-anchor="middle" fill="url(#goldMetalEdge)" font-family="${fonts.family}" font-size="${prizeSize}" font-weight="700">${escapeSvgText(prize)}</text>

  <!-- Countdown -->
  <text x="540" y="418" text-anchor="middle" fill="#f5edd8" font-family="${fonts.family}" font-size="30" font-weight="700" letter-spacing="2.5">${escapeSvgText(countdown)}</text>
  <text x="540" y="448" text-anchor="middle" fill="#c9d1dc" font-family="${fonts.family}" font-size="22" font-weight="500">${escapeSvgText(endsLine)}</text>

  ${ordered.length === 0 ? empty : podium}
  ${rows}

  <!-- Footer (intentionally visible) -->
  <line x1="390" y1="1280" x2="690" y2="1280" stroke="#4a5363" stroke-opacity="0.85" stroke-width="1"/>
  <text x="540" y="1310" text-anchor="middle" fill="#aeb6c4" font-family="${fonts.family}" font-size="16" font-weight="700" letter-spacing="3.5">KEEP CLIMBING</text>
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
      return `<rect x="${opts.x}" y="${opts.y}" width="${opts.width}" height="${opts.height}" rx="20" fill="#161922" stroke="#262b36" stroke-width="1" opacity="0.5"/>
        <text x="${cx}" y="${opts.y + opts.height / 2 + 6}" text-anchor="middle" fill="#4b5563" font-family="${fontFamily}" font-size="22">—</text>`;
    }
    const name = escapeSvgText(truncateLeaderboardName(standing.displayName, PODIUM_NAME_MAX));
    const pts = `${Math.trunc(Number.isFinite(standing.points) ? standing.points : 0)} PTS`;
    const move = formatRankMovementLabel(standing.movement);
    const moveCol = movementColor(standing.movement?.kind);
    const crown = opts.elevate
      ? `<g>
          <ellipse cx="${cx}" cy="${opts.y - 8}" rx="34" ry="10" fill="#d4af37" opacity="0.18"/>
          <text x="${cx}" y="${opts.y - 10}" text-anchor="middle" fill="url(#goldMetal)" font-size="30" font-weight="700">♛</text>
        </g>`
      : "";
    const innerHighlight = `<rect x="${opts.x + 2}" y="${opts.y + 2}" width="${opts.width - 4}" height="${Math.max(28, opts.height * 0.28)}" rx="18" fill="#ffffff" opacity="0.035"/>`;
    return `
      ${crown}
      <rect x="${opts.x}" y="${opts.y}" width="${opts.width}" height="${opts.height}" rx="22" fill="${opts.fill}" stroke="${opts.stroke}" stroke-width="${opts.strokeWidth}" filter="url(#${opts.shadow})"/>
      ${innerHighlight}
      <text x="${cx}" y="${opts.y + 40}" text-anchor="middle" fill="${opts.stroke}" font-family="${fontFamily}" font-size="19" font-weight="700" letter-spacing="2.5">${opts.medal}</text>
      <text x="${cx}" y="${opts.y + 90}" text-anchor="middle" fill="#ffffff" font-family="${fontFamily}" font-size="${opts.nameSize}" font-weight="700">${name}</text>
      <text x="${cx}" y="${opts.y + 134}" text-anchor="middle" fill="${opts.ptsFill}" font-family="${fontFamily}" font-size="${opts.ptsSize}" font-weight="700">${escapeSvgText(pts)}</text>
      ${
        move
          ? `<text x="${cx}" y="${opts.y + 168}" text-anchor="middle" fill="${moveCol}" font-family="${fontFamily}" font-size="20" font-weight="700">${escapeSvgText(move)}</text>`
          : ""
      }`;
  };

  // Tightened vertical composition: prize → countdown → podium
  const y1 = 478;
  const y23 = 526;
  return `
  <g>
    ${slot(second, {
      x: 72,
      y: y23,
      width: 286,
      height: 198,
      medal: "#2",
      fill: "url(#podiumSilverFill)",
      stroke: "url(#silverMetal)",
      strokeWidth: 1.75,
      nameSize: 27,
      ptsSize: 25,
      ptsFill: "url(#silverMetal)",
      elevate: false,
      shadow: "cardShadow"
    })}
    ${slot(first, {
      x: 354,
      y: y1,
      width: 372,
      height: 236,
      medal: "#1",
      fill: "url(#podiumGoldFill)",
      stroke: "url(#goldMetal)",
      strokeWidth: 2.75,
      nameSize: 36,
      ptsSize: 32,
      ptsFill: "url(#goldMetal)",
      elevate: true,
      shadow: "leaderShadow"
    })}
    ${slot(third, {
      x: 722,
      y: y23,
      width: 286,
      height: 198,
      medal: "#3",
      fill: "url(#podiumBronzeFill)",
      stroke: "url(#bronzeMetal)",
      strokeWidth: 1.75,
      nameSize: 27,
      ptsSize: 25,
      ptsFill: "url(#bronzeMetal)",
      elevate: false,
      shadow: "cardShadow"
    })}
  </g>`;
}

function renderRows(rows: readonly LeaderboardCardStanding[], fontFamily: string): string {
  if (rows.length === 0) return "";
  const startY = 758;
  const rowH = 54;
  const gap = 9;

  return rows
    .map((row, index) => {
      const y = startY + index * (rowH + gap);
      const fill = index % 2 === 0 ? "url(#rowFillA)" : "url(#rowFillB)";
      const rank = String(row.rank).padStart(2, "0");
      const name = escapeSvgText(truncateLeaderboardName(row.displayName, ROW_NAME_MAX));
      const move = formatRankMovementLabel(row.movement) || "—";
      const moveCol = movementColor(row.movement?.kind);
      const pts = Math.trunc(Number.isFinite(row.points) ? row.points : 0);
      return `
      <g>
        <rect x="72" y="${y}" width="936" height="${rowH}" rx="14" fill="${fill}" stroke="#2a313d" stroke-width="1"/>
        <text x="106" y="${y + 35}" fill="#c2c8d2" font-family="${fontFamily}" font-size="23" font-weight="700">${rank}</text>
        <text x="172" y="${y + 35}" fill="#f5f7fa" font-family="${fontFamily}" font-size="24" font-weight="700">${name}</text>
        <text x="700" y="${y + 35}" text-anchor="middle" fill="${moveCol}" font-family="${fontFamily}" font-size="21" font-weight="700">${escapeSvgText(move)}</text>
        <rect x="812" y="${y + 10}" width="172" height="34" rx="17" fill="url(#pillFill)" stroke="#343b4a" stroke-width="1"/>
        <text x="898" y="${y + 34}" text-anchor="middle" fill="#e8d9a0" font-family="${fontFamily}" font-size="21" font-weight="700">${pts}</text>
      </g>`;
    })
    .join("\n");
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
