import { LEADERBOARD_TIMEZONE } from "./leaderboard.constants";
import { formatPrizePoolDisplay } from "./leaderboard.standing-helpers";
import { formatCompetitionEndDisplay } from "./telegram/competition-end-display";

export interface GiveInfoMessageInput {
  readonly rank: number;
  readonly totalPoints: number;
  /** For #1: lead over #2; otherwise points behind the rank above. */
  readonly pointsAbove: number | null;
  readonly pointsToTop10: number | null;
  readonly pointsToTop3: number | null;
  readonly prizePoolCents: number;
  readonly competitionEndsAt: Date;
  readonly isFirst: boolean;
  /** Defaults to America/Chicago competition schedule timezone. */
  readonly timezone?: string;
}

const SUBSCRIPTION_REMINDER =
  "Reminder: prize winners must be subscribed to the official leaderboard channel at the eligibility deadline.";

/**
 * Builds the player-facing Give Info Telegram message from authoritative standing gaps.
 * Never mentions pool contribution rates or subscription status.
 */
export function buildGiveInfoMessage(input: GiveInfoMessageInput): string {
  const pool = formatPrizePoolDisplay(input.prizePoolCents);
  const status = buildStatusLine(input);
  const ends = formatCompetitionEndDisplay(
    input.competitionEndsAt,
    input.timezone ?? LEADERBOARD_TIMEZONE
  );
  return [
    status,
    `Current prize pool: ${pool}.`,
    `Competition ends ${ends}.`,
    SUBSCRIPTION_REMINDER
  ].join(" ");
}

function buildStatusLine(input: GiveInfoMessageInput): string {
  if (input.isFirst || input.rank === 1) return "You're #1.";
  if (input.rank <= 3) return `You're #${input.rank} and you're already in Top 3.`;
  return `You're #${input.rank}.`;
}
