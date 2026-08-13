import { formatPrizePoolDisplay } from "./leaderboard.standing-helpers";

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
}

const ENDS_COPY = "Competition ends Tuesday at 9 PM Texas time.";
const SUBSCRIPTION_REMINDER =
  "Reminder: prize winners must be subscribed to the official leaderboard channel at the eligibility deadline.";

/**
 * Builds the player-facing Give Info Telegram message from authoritative standing gaps.
 * Never mentions pool contribution rates or subscription status.
 */
export function buildGiveInfoMessage(input: GiveInfoMessageInput): string {
  const pool = formatPrizePoolDisplay(input.prizePoolCents);
  const status = buildStatusLine(input);
  return [
    status,
    `Current prize pool: ${pool}.`,
    ENDS_COPY,
    SUBSCRIPTION_REMINDER
  ].join(" ");
}

function buildStatusLine(input: GiveInfoMessageInput): string {
  const pointsLabel = `${input.totalPoints} point${input.totalPoints === 1 ? "" : "s"}`;

  if (input.isFirst || input.rank === 1) {
    const lead =
      input.pointsAbove != null && input.pointsAbove > 0
        ? ` — leading by ${input.pointsAbove} point${input.pointsAbove === 1 ? "" : "s"} over #2`
        : "";
    return `You're #1 with ${pointsLabel}${lead}.`;
  }

  if (input.rank > 10) {
    const need =
      input.pointsToTop10 != null && input.pointsToTop10 > 0
        ? `you need ${input.pointsToTop10} more point${input.pointsToTop10 === 1 ? "" : "s"} to reach Top 10`
        : "keep earning points to reach Top 10";
    return `You're #${input.rank} with ${pointsLabel} — ${need}.`;
  }

  const behindRank = input.rank - 1;
  const behind =
    input.pointsAbove != null && input.pointsAbove > 0
      ? `${input.pointsAbove} point${input.pointsAbove === 1 ? "" : "s"} behind #${behindRank}`
      : `just behind #${behindRank}`;
  const top3 =
    input.rank <= 3
      ? "you're already in Top 3"
      : input.pointsToTop3 != null && input.pointsToTop3 > 0
        ? `${input.pointsToTop3} point${input.pointsToTop3 === 1 ? "" : "s"} away from Top 3`
        : "close to Top 3";
  return `You're #${input.rank} with ${pointsLabel} — ${behind}, and ${top3}.`;
}
