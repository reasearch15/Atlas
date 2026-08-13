import { formatPrizePoolDisplay } from "../leaderboard.standing-helpers";

export interface PersonalRankWheelStatus {
  readonly qualifyingDepositCents: number;
  readonly qualificationCentsRequired: number;
  readonly available: boolean;
  readonly consumed: boolean;
  readonly pointsAwarded: number | null;
  readonly cycleSequence: number | null;
}

export interface PersonalRankMessageInput {
  readonly rank: number;
  readonly totalPoints: number;
  /** Points behind the rank above; for #1 = lead over #2. */
  readonly pointsAbove: number | null;
  readonly pointsToTop3: number | null;
  readonly prizePoolCents: number;
  readonly endsAt: Date;
  readonly timezone: string;
  readonly isFirst: boolean;
  /** Optional Phase 6 wheel status lines for /rank (bot Spin callback DEFERRED). */
  readonly wheelStatus?: PersonalRankWheelStatus | null;
}

export interface PersonalFinalResultMessageInput {
  readonly leaderboardRank: number;
  readonly totalPoints: number;
  readonly prizeRank: number | null;
  readonly payoutCents: number | null;
  readonly membershipStatus: "ELIGIBLE" | "NOT_ELIGIBLE" | "PENDING_REVIEW";
  readonly ineligibilityReason: string | null;
  readonly prizePoolCents: number;
}

const PRIZE_REMINDER =
  "You must be subscribed to the official leaderboard channel at the eligibility deadline to receive a prize.";

/**
 * Formats the personal /rank bot DM. Never includes pool %.
 */
export function formatPersonalRankMessage(input: PersonalRankMessageInput): string {
  const gapLines = buildGapLines(input);
  const ends = formatEndsLine(input.endsAt, input.timezone);
  const wheelLines = buildWheelStatusLines(input.wheelStatus);

  return [
    "🏆 YOUR LEADERBOARD",
    "",
    `Rank: #${input.rank}`,
    `Points: ${Math.trunc(input.totalPoints)}`,
    "",
    ...gapLines,
    ...(wheelLines.length > 0 ? ["", ...wheelLines] : []),
    "",
    `🎁 Current Prize Pool: ${formatPrizePoolDisplay(input.prizePoolCents)}`,
    `⏰ ${ends}`,
    "",
    "Prize reminder:",
    PRIZE_REMINDER
  ].join("\n");
}

/**
 * Formats a personal final-result DM. Preserves leaderboardRank vs prizeRank.
 * Never tells an ineligible #1 that they "finished #2".
 */
export function formatPersonalFinalResultMessage(input: PersonalFinalResultMessageInput): string {
  const points = Math.trunc(input.totalPoints);
  const notSubscribed =
    input.membershipStatus === "NOT_ELIGIBLE" &&
    (input.ineligibilityReason === "NOT_SUBSCRIBED" ||
      /not.?subscrib/i.test(input.ineligibilityReason ?? ""));

  if (input.prizeRank != null && input.payoutCents != null) {
    const lines = [
      "🏆 YOU WON!",
      "",
      `You finished #${input.leaderboardRank} on the leaderboard with ${points} points.`,
      ""
    ];
    if (input.prizeRank !== input.leaderboardRank) {
      lines.push(
        `You received Prize #${input.prizeRank} because a higher-ranked player was not prize-eligible.`
      );
      lines.push("");
    } else {
      lines.push(`You received Prize #${input.prizeRank}.`);
      lines.push("");
    }
    lines.push(`Prize: ${formatPrizePoolDisplay(input.payoutCents)}`);
    return lines.join("\n");
  }

  if (notSubscribed) {
    return [
      "🏁 FINAL RESULT",
      "",
      `You finished #${input.leaderboardRank} with ${points} points.`,
      "",
      "However, you were not subscribed to the required leaderboard channel at the eligibility deadline, so you were not eligible for the prize.",
      "",
      `Your #${input.leaderboardRank} leaderboard finish remains recorded.`
    ].join("\n");
  }

  if (input.membershipStatus === "NOT_ELIGIBLE") {
    return [
      "🏁 FINAL RESULT",
      "",
      `You finished #${input.leaderboardRank} with ${points} points.`,
      "",
      input.ineligibilityReason?.trim() ||
        "You were not eligible for a prize at the eligibility deadline.",
      "",
      `Your #${input.leaderboardRank} leaderboard finish remains recorded.`
    ].join("\n");
  }

  return [
    "🏁 FINAL RESULT",
    "",
    `You finished #${input.leaderboardRank} with ${points} points.`,
    "",
    "You did not receive a prize this round.",
    "",
    `🎁 Prize Pool: ${formatPrizePoolDisplay(input.prizePoolCents)}`
  ].join("\n");
}

export function formatPersonalAnnouncementDm(input: {
  readonly kind: string;
  readonly fromRank: number | null;
  readonly toRank: number;
  readonly totalPoints?: number;
}): string {
  const from = input.fromRank == null ? "unranked" : `#${input.fromRank}`;
  const points =
    input.totalPoints != null ? `\nPoints: ${Math.trunc(input.totalPoints)}` : "";
  switch (input.kind) {
    case "REACHED_NUMBER_1":
      return `🥇 You reached #1!\nMoved from ${from} → #1.${points}`;
    case "ENTER_TOP_3":
      return `🏅 You entered Top 3!\nMoved from ${from} → #${input.toRank}.${points}`;
    case "ENTER_TOP_10":
      return `🔥 You entered Top 10!\nMoved from ${from} → #${input.toRank}.${points}`;
    case "TOP_3_ORDER_CHANGED":
      return `↕️ Top 3 reorder: you moved from ${from} → #${input.toRank}.${points}`;
    case "REFERRAL_MILESTONE":
      return [
        "🤝 Your referral reached a milestone.",
        input.totalPoints != null ? `+${Math.trunc(input.totalPoints)} leaderboard points!` : null,
        "Open /rank for your latest standing."
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");
    case "WHEEL_SPIN":
      return [
        "🎡 Wheel spin complete!",
        input.totalPoints != null ? `You won +${Math.trunc(input.totalPoints)} wheel points.` : null,
        "Open /rank for your latest standing.",
        // Bot Spin callback DEFERRED — Atlas UI is the spin surface.
        "(Spin in Atlas — bot Spin button coming later.)"
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");
    default:
      return `📈 Rank update: ${from} → #${input.toRank}.${points}\nOpen /rank for details.`;
  }
}

function buildWheelStatusLines(wheel: PersonalRankWheelStatus | null | undefined): string[] {
  if (!wheel) return [];
  const have = (wheel.qualifyingDepositCents / 100).toFixed(0);
  const need = (wheel.qualificationCentsRequired / 100).toFixed(0);
  const remaining = Math.max(0, wheel.qualificationCentsRequired - wheel.qualifyingDepositCents);
  const remainingDollars = (remaining / 100).toFixed(0);

  if (wheel.consumed) {
    return [
      "🎡 Wheel: Used for this cycle",
      "Next opportunity begins at the next 48h cycle."
    ];
  }
  if (wheel.available) {
    return ["🎡 Wheel Spin Available!", "Open Atlas to spin."];
  }
  return [
    `🎡 Wheel: $${have} / $${need}`,
    `$${remainingDollars} more qualifying deposits needed this cycle.`
  ];
}

function buildGapLines(input: PersonalRankMessageInput): string[] {
  if (input.isFirst || input.rank === 1) {
    if (input.pointsAbove != null && input.pointsAbove > 0) {
      return [`🥇 Leading by ${input.pointsAbove} points over #2`];
    }
    return ["🥇 You're #1"];
  }

  const lines: string[] = [];
  if (input.pointsAbove != null && input.pointsAbove > 0) {
    lines.push(`⬆️ ${input.pointsAbove} points behind #${input.rank - 1}`);
  }
  if (input.rank <= 3) {
    lines.push("🏅 You're in Top 3");
  } else if (input.pointsToTop3 != null && input.pointsToTop3 > 0) {
    lines.push(`🏅 ${input.pointsToTop3} points away from Top 3`);
  }
  return lines.length > 0 ? lines : [`Rank: #${input.rank}`];
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

export const PERSONAL_RANK_PRIZE_REMINDER = PRIZE_REMINDER;
