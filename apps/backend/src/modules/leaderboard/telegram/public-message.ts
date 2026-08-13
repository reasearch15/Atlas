import { formatPrizePoolDisplay } from "../leaderboard.standing-helpers";
import { toPublicLeaderboardDisplayName } from "./public-display-name";

const SUBSCRIPTION_REMINDER =
  "To receive a prize, winners must be subscribed to this channel at the eligibility deadline.";

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
}

/**
 * Formats the persistent public channel leaderboard message.
 * Never includes pool %, rateBps, or internal ids.
 */
export function formatPublicLeaderboardMessage(input: PublicLeaderboardMessageInput): string {
  const rows = [...input.top10]
    .filter((row) => row.rank >= 1 && row.rank <= 10)
    .sort((a, b) => a.rank - b.rank)
    .map((row) => formatStandingLine(row));

  const pool = formatPrizePoolDisplay(input.prizePoolCents);
  const ends = formatEndsLine(input.endsAt, input.timezone);

  return [
    `🏆 ${input.title.trim() || "BIWEEKLY LEADERBOARD"}`,
    "",
    ...rows,
    "",
    `🎁 Current Prize Pool: ${pool}`,
    `⏰ ${ends}`,
    "",
    `📢 ${SUBSCRIPTION_REMINDER}`
  ].join("\n");
}

/**
 * Final public results after finalize. Names only prize winners — never ineligible players.
 */
export function formatPublicResultsMessage(input: PublicResultsMessageInput): string {
  const winners = [...input.winners].sort((a, b) => a.prizeRank - b.prizeRank);
  const lines = winners.map((w) => {
    const name = toPublicLeaderboardDisplayName(w.displayName);
    const medal = medalForRank(w.prizeRank);
    const payout = formatPrizePoolDisplay(w.payoutCents);
    return `${medal}${w.prizeRank}. ${name} — ${payout}`;
  });

  return [
    "🏆 COMPETITION RESULTS",
    "",
    ...lines,
    "",
    `🎁 Prize Pool: ${formatPrizePoolDisplay(input.prizePoolCents)}`
  ].join("\n");
}

/**
 * Short channel announcement for a meaningful rank change.
 */
export function formatRankAnnouncement(input: RankAnnouncementInput): string {
  const name = toPublicLeaderboardDisplayName(input.displayName);
  const from = input.fromRank == null ? "unranked" : `#${input.fromRank}`;
  const reason = input.reason.trim() || "a ranking update";
  return `🔥 ${name} moved from ${from} → #${input.toRank} after ${reason}.`;
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

function formatEndsLine(endsAt: Date, timezone: string): string {
  try {
    const formatted = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || "America/Chicago",
      weekday: "long",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short"
    }).format(endsAt);
    return `Ends ${formatted}`;
  } catch {
    return "Ends Tuesday 9 PM Texas time";
  }
}

export const PUBLIC_LEADERBOARD_SUBSCRIPTION_REMINDER = SUBSCRIPTION_REMINDER;
