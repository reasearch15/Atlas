import sharp from "sharp";
import { escapeSvgText, LEADERBOARD_CARD_WIDTH } from "../leaderboard/telegram/public-leaderboard-card";

export interface DailyDrawCardInput {
  readonly displayName: string;
  readonly activeReferralCount: number;
  readonly referralWeight: number;
}

export async function renderDailyDrawWinnerCard(input: DailyDrawCardInput): Promise<Buffer> {
  const svg = buildDailyDrawWinnerCardSvg(input);
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export function buildDailyDrawWinnerCardSvg(input: DailyDrawCardInput): string {
  const name = truncate(input.displayName.trim() || "Player", 22);
  const showBoost = input.referralWeight > 0;
  const boostCount = Math.max(0, input.activeReferralCount);
  const boostLine = boostCount === 1 ? "1 ACTIVE REFERRAL BOOST" : `${boostCount} ACTIVE REFERRAL BOOSTS`;
  const boostBlock = showBoost
    ? `
  <rect x="150" y="980" width="780" height="150" rx="28" fill="#17130d" stroke="#ff8a3d" stroke-width="3"/>
  <text x="540" y="1038" text-anchor="middle" fill="#ffb347" font-family="Arial, Helvetica, sans-serif" font-size="28" font-weight="700" letter-spacing="3">REFERRAL BOOST 🔥</text>
  <text x="540" y="1092" text-anchor="middle" fill="#ffe9a0" font-family="Arial, Helvetica, sans-serif" font-size="32" font-weight="700">${escapeSvgText(boostLine)}</text>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${LEADERBOARD_CARD_WIDTH}" height="1350" viewBox="0 0 ${LEADERBOARD_CARD_WIDTH} 1350">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.2" y2="1">
      <stop offset="0%" stop-color="#120e08"/>
      <stop offset="60%" stop-color="#080706"/>
      <stop offset="100%" stop-color="#050403"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="28%" r="55%">
      <stop offset="0%" stop-color="#d4af37" stop-opacity="0.42"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#fff8dc"/>
      <stop offset="45%" stop-color="#d4af37"/>
      <stop offset="100%" stop-color="#7a5c16"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#bg)"/>
  <rect width="100%" height="100%" fill="url(#glow)"/>
  <rect x="48" y="48" width="984" height="1254" rx="36" fill="none" stroke="url(#gold)" stroke-width="4"/>
  <text x="540" y="140" text-anchor="middle" fill="#f4f0e6" font-family="Arial, Helvetica, sans-serif" font-size="28" font-weight="700" letter-spacing="8">SAYU GAMING HUB</text>
  <text x="540" y="250" text-anchor="middle" fill="#ffe9a0" font-family="Arial, Helvetica, sans-serif" font-size="42" font-weight="700">🎉 DAILY $5 FREEPLAY WINNER 🎉</text>
  <text x="540" y="330" text-anchor="middle" fill="url(#gold)" font-family="Arial, Helvetica, sans-serif" font-size="58" font-weight="700" letter-spacing="6">DAILY WINNER</text>
  <rect x="160" y="400" width="760" height="220" rx="32" fill="#17130d" stroke="#d4af37" stroke-width="4"/>
  <text x="540" y="490" text-anchor="middle" fill="#c9b88a" font-family="Arial, Helvetica, sans-serif" font-size="26" font-weight="700" letter-spacing="4">$5 FREEPLAY</text>
  <text x="540" y="575" text-anchor="middle" fill="#ffe9a0" font-family="Arial, Helvetica, sans-serif" font-size="72" font-weight="700">$5</text>
  <text x="540" y="720" text-anchor="middle" fill="#c9b88a" font-family="Arial, Helvetica, sans-serif" font-size="24" font-weight="700" letter-spacing="4">WINNER</text>
  <text x="540" y="810" text-anchor="middle" fill="#f8fafc" font-family="Arial, Helvetica, sans-serif" font-size="56" font-weight="700">${escapeSvgText(name)}</text>
  <text x="540" y="900" text-anchor="middle" fill="#c9b88a" font-family="Arial, Helvetica, sans-serif" font-size="26" font-weight="700">Lucky Subscriber Draw</text>
  ${boostBlock}
  <text x="540" y="1248" text-anchor="middle" fill="#8d8068" font-family="Arial, Helvetica, sans-serif" font-size="20" font-weight="700">Every eligible registered subscriber has a chance</text>
</svg>`;
}

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
