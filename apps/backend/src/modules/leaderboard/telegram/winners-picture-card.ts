import sharp from "sharp";
import { DateTime } from "luxon";
import {
  escapeSvgText,
  formatPrizePoolHero,
  LEADERBOARD_CARD_WIDTH
} from "./public-leaderboard-card";

export interface WinnersPictureWinner {
  readonly prizeRank: 1 | 2 | 3;
  readonly displayName: string;
  readonly payoutCents: number;
}

export interface WinnersPictureInput {
  readonly brandName: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly timezone: string;
  readonly prizePoolCents: number;
  readonly winners: readonly WinnersPictureWinner[];
  readonly bonusWinner?: {
    readonly displayName: string;
    readonly leaderboardRank: number;
    readonly rewardAmountCents: number;
  } | null;
}

export async function renderWinnersPictureCard(input: WinnersPictureInput): Promise<Buffer> {
  const svg = buildWinnersPictureSvg(input);
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export function buildWinnersPictureSvg(input: WinnersPictureInput): string {
  const winners = [...input.winners].sort((a, b) => a.prizeRank - b.prizeRank);
  const rowSvg = winners
    .map((winner, index) => {
      const y = 780 + index * 150;
      const medal = winner.prizeRank === 1 ? "#d4af37" : winner.prizeRank === 2 ? "#c5ccd6" : "#cd7f32";
      return `
        <rect x="130" y="${y}" width="820" height="116" rx="24" fill="#17130d" stroke="${medal}" stroke-width="2.5"/>
        <circle cx="206" cy="${y + 58}" r="38" fill="${medal}"/>
        <text x="206" y="${y + 72}" text-anchor="middle" fill="#120e08" font-family="Arial, Helvetica, sans-serif" font-size="38" font-weight="700">${winner.prizeRank}</text>
        <text x="278" y="${y + 50}" fill="#f8fafc" font-family="Arial, Helvetica, sans-serif" font-size="34" font-weight="700">${escapeSvgText(truncate(winner.displayName, 24))}</text>
        <text x="278" y="${y + 86}" fill="#c9b88a" font-family="Arial, Helvetica, sans-serif" font-size="20" font-weight="700">${rankLabel(winner.prizeRank)}</text>
        <text x="900" y="${y + 72}" text-anchor="end" fill="#ffe9a0" font-family="Arial, Helvetica, sans-serif" font-size="38" font-weight="700">${escapeSvgText(formatPrizePoolHero(winner.payoutCents))}</text>`;
    })
    .join("\n");
  const empty =
    winners.length === 0
      ? `<text x="540" y="840" text-anchor="middle" fill="#c9b88a" font-family="Arial, Helvetica, sans-serif" font-size="34" font-weight="700">No ranked winners this round.</text>`
      : "";
  const brand = truncate(input.brandName.trim() || "SAYU GAMING HUB", 32).toUpperCase();
  const range = formatDateRange(input.startsAt, input.endsAt, input.timezone);
  const pool = formatPrizePoolHero(input.prizePoolCents);
  const bonus = input.bonusWinner
    ? `<rect x="130" y="1230" width="820" height="220" rx="24" fill="#17130d" stroke="#d4af37" stroke-width="2.5"/>
  <text x="540" y="1280" text-anchor="middle" fill="#c9b88a" font-family="Arial, Helvetica, sans-serif" font-size="20" font-weight="700" letter-spacing="2">RANDOM FREE PLAY WINNER</text>
  <text x="540" y="1340" text-anchor="middle" fill="#f8fafc" font-family="Arial, Helvetica, sans-serif" font-size="34" font-weight="700">${escapeSvgText(truncate(input.bonusWinner.displayName, 24))}</text>
  <text x="540" y="1382" text-anchor="middle" fill="#ffe9a0" font-family="Arial, Helvetica, sans-serif" font-size="30" font-weight="700">${escapeSvgText(formatFreeplay(input.bonusWinner.rewardAmountCents))} FREE PLAY</text>
  <text x="540" y="1420" text-anchor="middle" fill="#c9b88a" font-family="Arial, Helvetica, sans-serif" font-size="18" font-weight="700">LEADERBOARD RANK #${input.bonusWinner.leaderboardRank}</text>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${LEADERBOARD_CARD_WIDTH}" height="1580" viewBox="0 0 ${LEADERBOARD_CARD_WIDTH} 1580">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#140818"/>
      <stop offset="40%" stop-color="#07060a"/>
      <stop offset="100%" stop-color="#09060f"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="28%" r="52%">
      <stop offset="0%" stop-color="#d4af37" stop-opacity="0.32"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#fff8dc"/>
      <stop offset="45%" stop-color="#d4af37"/>
      <stop offset="100%" stop-color="#7a5c16"/>
    </linearGradient>
    <linearGradient id="curtain" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#3a1468"/>
      <stop offset="100%" stop-color="#1a082e"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#bg)"/>
  <rect width="100%" height="100%" fill="url(#glow)"/>
  <path d="M0 0 C70 120 20 360 60 700 C20 1040 70 1320 0 1580 Z" fill="url(#curtain)" opacity="0.9"/>
  <path d="M1080 0 C1010 120 1060 360 1020 700 C1060 1040 1010 1320 1080 1580 Z" fill="url(#curtain)" opacity="0.9"/>
  <rect x="48" y="48" width="984" height="1484" rx="36" fill="none" stroke="url(#gold)" stroke-width="3"/>
  <text x="540" y="118" text-anchor="middle" fill="#f4e7c3" font-family="Arial, Helvetica, sans-serif" font-size="20" font-weight="700" letter-spacing="5">${escapeSvgText(brand)}</text>
  <text x="540" y="210" text-anchor="middle" fill="url(#gold)" font-family="Arial, Helvetica, sans-serif" font-size="58" font-weight="700" letter-spacing="4">COMPETITION</text>
  <text x="540" y="276" text-anchor="middle" fill="url(#gold)" font-family="Arial, Helvetica, sans-serif" font-size="58" font-weight="700" letter-spacing="4">WINNERS</text>
  <rect x="190" y="330" width="700" height="176" rx="28" fill="#120e08" stroke="url(#gold)" stroke-width="3"/>
  <text x="540" y="386" text-anchor="middle" fill="#c9b88a" font-family="Arial, Helvetica, sans-serif" font-size="20" font-weight="700" letter-spacing="3">TOTAL PRIZE POOL</text>
  <text x="540" y="468" text-anchor="middle" fill="#ffe9a0" font-family="Arial, Helvetica, sans-serif" font-size="72" font-weight="700">${escapeSvgText(pool)}</text>
  <text x="540" y="560" text-anchor="middle" fill="#f8fafc" font-family="Arial, Helvetica, sans-serif" font-size="26" font-weight="700">${escapeSvgText(range)}</text>
  ${rowSvg}
  ${empty}
  ${bonus}
  <text x="540" y="1520" text-anchor="middle" fill="#c9a85a" font-family="Arial, Helvetica, sans-serif" font-size="16" font-weight="700" letter-spacing="3">FINAL RESULTS ARE IN</text>
</svg>`;
}

function formatFreeplay(cents: number): string {
  return `$${(Math.max(0, Math.trunc(cents)) / 100).toFixed(0)}`;
}

function formatDateRange(startsAt: Date, endsAt: Date, timezone: string): string {
  const start = DateTime.fromJSDate(startsAt, { zone: "utc" }).setZone(timezone);
  const end = DateTime.fromJSDate(endsAt, { zone: "utc" }).setZone(timezone);
  const sameYear = start.year === end.year;
  const left = start.toFormat("LLL d");
  const right = end.toFormat(sameYear ? "LLL d, yyyy" : "LLL d, yyyy");
  return `Competition: ${left} - ${right}`;
}

function rankLabel(rank: 1 | 2 | 3): string {
  if (rank === 1) return "1ST PLACE";
  if (rank === 2) return "2ND PLACE";
  return "3RD PLACE";
}

function truncate(value: string, maxChars: number): string {
  const chars = Array.from((value || "Player").replace(/\s+/g, " ").trim() || "Player");
  if (chars.length <= maxChars) return chars.join("");
  return `${chars.slice(0, maxChars - 1).join("")}...`;
}
