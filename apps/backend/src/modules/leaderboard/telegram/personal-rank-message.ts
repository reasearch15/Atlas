import { formatPrizePoolDisplay } from "../leaderboard.standing-helpers";
import type { TelegramInlineKeyboardMarkup } from "./leaderboard-telegram.client";
import { formatCompetitionEndDisplay } from "./competition-end-display";
import type { FreeplayPlayerStatusDto } from "@atlas/shared";
import { appendPlayTelegramButton } from "./public-message";

/** Inline keyboard callback_data for player wheel spin. Never includes IDs. */
export const LEADERBOARD_WHEEL_SPIN_CALLBACK_DATA = "leaderboard:wheel:spin";
export const FREEPLAY_WHEEL_OPEN_CALLBACK_DATA = "freeplay:wheel:open";
export const FREEPLAY_WHEEL_SPIN_CALLBACK_DATA = "freeplay:wheel:spin";

const TOP_PRIZE_ZONE_RANK = 3;

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
  /** Optional Phase 6 wheel status lines for /rank. */
  readonly wheelStatus?: PersonalRankWheelStatus | null;
}

export interface WheelSpinResultMessageInput {
  readonly pointsAwarded: number;
  readonly previousRank: number | null;
  readonly resultingRank: number | null;
  readonly totalPoints: number;
  /** Points behind the rank above after spin; omitted when #1 or unavailable. */
  readonly pointsAbove: number | null;
}

/**
 * Inline Spin Now keyboard for /rank when wheel status is AVAILABLE.
 */
export function buildWheelSpinInlineKeyboard(): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "🎡 Spin Now", callback_data: LEADERBOARD_WHEEL_SPIN_CALLBACK_DATA }]
    ]
  };
}

export function buildPersonalRankInlineKeyboard(input: {
  readonly leaderboardWheelAvailable: boolean;
  readonly playTelegramUsername?: string | null;
}): TelegramInlineKeyboardMarkup {
  const keyboard = {
    inline_keyboard: [
      ...(input.leaderboardWheelAvailable
        ? [[{ text: "🎡 Spin Now", callback_data: LEADERBOARD_WHEEL_SPIN_CALLBACK_DATA }]]
        : []),
      [{ text: "🎁 Freeplay Wheel", callback_data: FREEPLAY_WHEEL_OPEN_CALLBACK_DATA }]
    ]
  };
  return appendPlayTelegramButton(keyboard, input.playTelegramUsername) ?? keyboard;
}

export function buildFreeplayStatusInlineKeyboard(
  status: FreeplayPlayerStatusDto,
  playTelegramUsername?: string | null
): TelegramInlineKeyboardMarkup | undefined {
  const keyboard = status.canSpin
    ? {
        inline_keyboard: [
          [{ text: "🎡 Spin", callback_data: FREEPLAY_WHEEL_SPIN_CALLBACK_DATA }]
        ]
      }
    : undefined;
  return appendPlayTelegramButton(keyboard, playTelegramUsername);
}

export function formatFreeplayStatusMessage(status: FreeplayPlayerStatusDto): string {
  return status.playerMessage;
}

export function formatFreeplaySpinResultMessage(input: {
  readonly rewardAmountCents: number;
  readonly nextStatus: FreeplayPlayerStatusDto;
}): string {
  const result =
    input.rewardAmountCents > 0
      ? `🎉 You won $${Math.trunc(input.rewardAmountCents / 100)} Freeplay!\nYour reward is waiting for staff to load.`
      : "🍀 No Freeplay this time.\nKeep earning leaderboard points and check back for your next chance.";
  if (input.nextStatus.status === "ROLLING_LIMIT") {
    return `${result}\n\n${input.nextStatus.playerMessage}`;
  }
  return result;
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
  const points =
    input.totalPoints != null ? `\nPoints: ${Math.trunc(input.totalPoints)}` : "";
  const provenMove =
    input.fromRank != null && input.toRank > 0 && input.fromRank > input.toRank;
  const nowRank = input.toRank > 0 ? `#${input.toRank}` : null;
  const openRank = "Open /rank for your latest standing.";

  switch (input.kind) {
    case "REACHED_NUMBER_1":
      return provenMove
        ? `🥇 You reached #1!\nMoved from #${input.fromRank} → #1.${points}`
        : `🥇 You reached #1!${points}\n${openRank}`;
    case "ENTER_TOP_3":
      return provenMove
        ? `🏅 You entered Top 3!\nMoved from #${input.fromRank} → #${input.toRank}.${points}`
        : nowRank
          ? `🏅 You're now ${nowRank} on the leaderboard.${points}\n${openRank}`
          : `🏅 Leaderboard update.${points}\n${openRank}`;
    case "ENTER_TOP_10":
      return provenMove
        ? `🔥 You entered Top 10!\nMoved from #${input.fromRank} → #${input.toRank}.${points}`
        : nowRank
          ? `🔥 You're now ${nowRank} on the leaderboard.${points}\n${openRank}`
          : `🔥 Leaderboard update.${points}\n${openRank}`;
    case "TOP_3_ORDER_CHANGED":
      return provenMove
        ? `↕️ Top 3 reorder: you moved from #${input.fromRank} → #${input.toRank}.${points}`
        : nowRank
          ? `↕️ You're now ${nowRank} on the leaderboard.${points}\n${openRank}`
          : `↕️ Leaderboard update.${points}\n${openRank}`;
    case "REFERRAL_MILESTONE":
      return [
        "🤝 Your referral reached a milestone.",
        input.totalPoints != null ? `+${Math.trunc(input.totalPoints)} leaderboard points!` : null,
        openRank
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");
    case "WHEEL_SPIN":
      return [
        "🎡 Wheel spin complete!",
        input.totalPoints != null ? `You won +${Math.trunc(input.totalPoints)} wheel points.` : null,
        openRank
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");
    default:
      return provenMove
        ? `📈 Rank update: #${input.fromRank} → #${input.toRank}.${points}\nOpen /rank for details.`
        : nowRank
          ? `📈 You're now ${nowRank}.${points}\nOpen /rank for details.`
          : `📈 Rank update.${points}\nOpen /rank for details.`;
  }
}

/**
 * Formats the private wheel result DM after a successful Telegram spin.
 */
export function formatWheelSpinResultMessage(input: WheelSpinResultMessageInput): string {
  const points = Math.trunc(input.pointsAwarded);
  const total = Math.trunc(input.totalPoints);
  const prev = input.previousRank;
  const next = input.resultingRank;
  const enteredPrizeZone =
    next != null &&
    next <= TOP_PRIZE_ZONE_RANK &&
    (prev == null || prev > TOP_PRIZE_ZONE_RANK);

  if (points === 0) {
    const stillRank = next != null ? `You're still #${next}.` : prev != null ? `You're still #${prev}.` : null;
    return [
      "🎡 WHEEL RESULT",
      "",
      "0 POINTS",
      "",
      "No points this spin.",
      ...(stillRank ? ["", stillRank] : []),
      "Keep earning through deposits, referrals and promotions."
    ].join("\n");
  }

  const lines = [
    "🎡 WHEEL RESULT",
    "",
    `+${points} POINTS!`,
    ""
  ];

  if (prev != null && next != null) {
    lines.push(`#${prev} → #${next}`);
    lines.push("");
  } else if (next != null) {
    lines.push(`You're now #${next}.`);
    lines.push("");
  }

  if (enteredPrizeZone) {
    lines.push("🏆 You're now in the prize zone!");
    lines.push("");
  } else if (
    next != null &&
    next > 1 &&
    input.pointsAbove != null &&
    input.pointsAbove > 0
  ) {
    lines.push(`You're now ${input.pointsAbove} points behind #${next - 1}.`);
    lines.push("");
  }

  lines.push(`Total points: ${total}`);
  return lines.join("\n");
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
    return ["🎡 Wheel Spin Available!"];
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
  return `Ends ${formatCompetitionEndDisplay(endsAt, timezone)}`;
}

export const PERSONAL_RANK_PRIZE_REMINDER = PRIZE_REMINDER;
