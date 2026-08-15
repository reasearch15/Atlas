import { formatPrizePoolDisplay } from "../leaderboard.standing-helpers";
import type { AnnouncementKind } from "./announcement-policy";
import { formatCompetitionEndDisplay } from "./competition-end-display";
import type { TelegramInlineKeyboardMarkup } from "./leaderboard-telegram.client";
import { toPublicLeaderboardDisplayName } from "./public-display-name";

const RULE_LINE = "━━━━━━━━━━━━━━━━━━";

const SUBSCRIPTION_REMINDER =
  "Winners must be subscribed to this channel at the eligibility deadline.";

export interface PublicLeaderboardRow {
  readonly rank: number;
  readonly displayName: string;
  readonly points: number;
}

export interface PublicLeaderboardMessageInput {
  readonly title: string;
  readonly top10: readonly PublicLeaderboardRow[];
  readonly prizePoolCents: number;
  readonly endsAt: Date;
  readonly timezone: string;
  /** Optional Coadmin bot username for persistent personal-rank CTA. */
  readonly botUsername?: string | null;
}

export interface PublicResultsWinner {
  readonly prizeRank: 1 | 2 | 3;
  readonly displayName: string;
  readonly payoutCents: number;
}

export interface PublicResultsMessageInput {
  readonly winners: readonly PublicResultsWinner[];
  readonly prizePoolCents: number;
}

export interface RankAnnouncementInput {
  readonly displayName: string;
  readonly fromRank: number | null;
  readonly toRank: number;
  readonly reason: string;
  readonly kind?: AnnouncementKind;
  readonly totalPoints?: number | null;
  readonly pointsGained?: number | null;
  readonly pointsBehindNext?: number | null;
}

/**
 * Formats the persistent public channel leaderboard message.
 * Never includes pool %, rateBps, or internal ids.
 */
export function formatPublicLeaderboardMessage(input: PublicLeaderboardMessageInput): string {
  const rows = [...input.top10]
    .filter((row) => row.rank >= 1 && row.rank <= 10)
    .sort((a, b) => a.rank - b.rank);

  const allZero =
    rows.length > 0 && rows.every((row) => !Number.isFinite(row.points) || Math.trunc(row.points) === 0);

  const standingLines = rows.map((row) => formatStandingLine(row));
  const pool = formatPrizePoolDisplay(input.prizePoolCents);
  const ends = formatCompetitionEndDisplay(input.endsAt, input.timezone);
  const botUsername = normalizeBotUsername(input.botUsername);
  const cta = botUsername
    ? `➡️ Check your personal rank:\nhttps://t.me/${botUsername}?start=rank`
    : "";

  const title = input.title.trim() || "BIWEEKLY LEADERBOARD";

  const lines = [
    `🏆 ${title}`,
    RULE_LINE,
    "",
    "💰 PRIZE POOL",
    `💵 ${pool}`,
    "",
    `⏰ Ends ${ends}`,
    RULE_LINE,
    ...standingLines,
    RULE_LINE,
    "",
    allZero
      ? "🔥 The competition has started — every point matters."
      : "🔥 Keep climbing.\nEvery qualifying deposit, referral, promotion and wheel result can move you up.",
    "",
    "📢 Prize eligibility:",
    SUBSCRIPTION_REMINDER
  ];

  if (cta) {
    lines.push("", cta);
  }

  return lines.join("\n");
}

/**
 * Final public results after finalize. Names only prize winners — never ineligible players.
 */
export function formatPublicResultsMessage(input: PublicResultsMessageInput): string {
  const winners = [...input.winners].sort((a, b) => a.prizeRank - b.prizeRank);
  const winnerLines = winners.map((w) => {
    const name = toPublicLeaderboardDisplayName(w.displayName);
    const medal = medalForRank(w.prizeRank);
    const payout = formatPrizePoolDisplay(w.payoutCents);
    return `${medal}${w.prizeRank}. ${name} — ${payout}`;
  });

  return [
    "🏆 COMPETITION RESULTS",
    RULE_LINE,
    "",
    "💰 PRIZE POOL",
    `💵 ${formatPrizePoolDisplay(input.prizePoolCents)}`,
    "",
    ...winnerLines
  ].join("\n");
}

export interface CurrentStateRankAnnouncementInput {
  readonly displayName: string;
  readonly rank: number;
  readonly totalPoints: number;
  readonly pointsBehindNext: number | null;
  /** Proven historical rank only. Omit when the original movement snapshot is unreliable. */
  readonly fromRank?: number | null;
}

/**
 * Public channel copy from send-time standings. Never uses frozen outbox rank/gap.
 * Historical movement is included only when `fromRank` is a proven worse rank.
 */
export function formatCurrentStateRankAnnouncement(input: CurrentStateRankAnnouncementInput): string {
  const name = toPublicLeaderboardDisplayName(input.displayName);
  const rank = input.rank;
  const points = Number.isFinite(input.totalPoints) ? Math.trunc(input.totalPoints) : 0;

  if (rank === 1) {
    return `🔥 ${name} is now #1!\nLeading the leaderboard with ${points} PTS.`;
  }

  const provenMove = input.fromRank != null && input.fromRank > rank;
  const headline = provenMove
    ? `🔥 ${name} moved #${input.fromRank} → #${rank}!`
    : `🔥 ${name} is now #${rank}!`;
  const behind =
    input.pointsBehindNext != null &&
    Number.isFinite(input.pointsBehindNext) &&
    input.pointsBehindNext >= 0
      ? Math.trunc(input.pointsBehindNext)
      : null;
  if (behind != null) {
    return `${headline}\n${behind} points behind #${rank - 1}.`;
  }
  return headline;
}

/**
 * Short channel announcement for a meaningful rank change.
 */
export function formatRankAnnouncement(input: RankAnnouncementInput): string {
  const name = toPublicLeaderboardDisplayName(input.displayName);
  const kind = input.kind;
  const total =
    input.totalPoints != null && Number.isFinite(input.totalPoints)
      ? Math.trunc(input.totalPoints)
      : null;
  const gained =
    input.pointsGained != null && Number.isFinite(input.pointsGained) && input.pointsGained > 0
      ? Math.trunc(input.pointsGained)
      : null;
  const behind =
    input.pointsBehindNext != null &&
    Number.isFinite(input.pointsBehindNext) &&
    input.pointsBehindNext >= 0
      ? Math.trunc(input.pointsBehindNext)
      : null;

  if (kind === "REACHED_NUMBER_1" || input.toRank === 1) {
    const pts = total != null ? ` with ${total} points` : "";
    return `👑 NEW #1\n${name} just took the top spot${pts}.`;
  }

  const from = input.fromRank == null ? "unranked" : `#${input.fromRank}`;
  const lines = [`🔥 ${name} moved ${from} → #${input.toRank}!`];
  if (gained != null) {
    lines.push(`+${gained} points`);
  }
  if (behind != null && input.toRank > 1) {
    lines.push(`Now only ${behind} points behind #${input.toRank - 1}.`);
  } else if (!gained) {
    const reason = input.reason.trim() || "a ranking update";
    lines.push(`After ${reason}.`);
  }
  return lines.join("\n");
}

function formatStandingLine(row: PublicLeaderboardRow): string {
  const name = toPublicLeaderboardDisplayName(row.displayName);
  const medal = medalForRank(row.rank);
  const points = Number.isFinite(row.points) ? Math.trunc(row.points) : 0;
  return `${medal}${row.rank}. ${name} — ${points} pts`;
}

function medalForRank(rank: number): string {
  if (rank === 1) return "🥇 ";
  if (rank === 2) return "🥈 ";
  if (rank === 3) return "🥉 ";
  return "";
}

export const PUBLIC_LEADERBOARD_SUBSCRIPTION_REMINDER = SUBSCRIPTION_REMINDER;
export const PLAY_BUTTON_TEXT = "🔴 PLAY";

/** Concise caption for the premium image board (no prize/top10/links duplication). */
export function formatPublicLeaderboardCaption(input?: {
  readonly competitionStatus?: string;
}): string {
  const status = (input?.competitionStatus ?? "ACTIVE").trim().toUpperCase();
  if (status === "FROZEN") return "🧊 Standings are frozen. Results coming soon.";
  if (status === "FINALIZED" || status === "COMPLETED" || status === "ENDED") {
    return "🏆 Competition complete.";
  }
  return "🔥 Competition is live. Keep climbing.";
}

/**
 * Public channel inline keyboard for the PLAY destination and My Rank deep-link.
 * Earn Points / Prize Rules omitted until safe existing callbacks exist.
 */
export function buildPublicLeaderboardKeyboard(
  botUsername: string | null | undefined,
  playTelegramUsername?: string | null | undefined
): TelegramInlineKeyboardMarkup | null {
  const user = normalizeBotUsername(botUsername);
  const playButton = buildPlayTelegramButton(playTelegramUsername);
  const rows = [
    ...(playButton ? [[playButton]] : []),
    ...(user ? [[{ text: "🏆 My Rank / 🎡 Lucky Wheel", url: `https://t.me/${user}?start=rank` }]] : [])
  ];
  if (rows.length === 0) return null;
  return {
    inline_keyboard: rows
  };
}

export function buildPlayTelegramButton(playTelegramUsername: string | null | undefined) {
  const url = resolvePlayTelegramUrl(playTelegramUsername);
  return url ? { text: PLAY_BUTTON_TEXT, url } : null;
}

export function buildPlayTelegramKeyboard(playTelegramUsername: string | null | undefined): TelegramInlineKeyboardMarkup | undefined {
  const button = buildPlayTelegramButton(playTelegramUsername);
  if (!button) return undefined;
  return { inline_keyboard: [[button]] };
}

export function appendPlayTelegramButton(
  keyboard: TelegramInlineKeyboardMarkup | undefined,
  playTelegramUsername: string | null | undefined
): TelegramInlineKeyboardMarkup | undefined {
  const button = buildPlayTelegramButton(playTelegramUsername);
  if (!button) return keyboard;
  if (!keyboard?.inline_keyboard.length) return { inline_keyboard: [[button]] };
  return {
    inline_keyboard: [...keyboard.inline_keyboard, [button]]
  };
}

export function resolvePlayTelegramUrl(playTelegramUsername: string | null | undefined): string | null {
  const username = normalizePlayTelegramUsername(playTelegramUsername);
  return username ? `https://t.me/${username}` : null;
}

export function normalizePlayTelegramUsername(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const withoutProtocol = trimmed.match(/^https:\/\/t\.me\/([^/?#]+)\/?$/i)?.[1] ?? trimmed;
  const username = withoutProtocol.replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) return null;
  return username;
}

function normalizeBotUsername(username: string | null | undefined): string | null {
  if (!username) return null;
  const trimmed = username.trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{5,}$/.test(trimmed)) return null;
  return trimmed;
}
