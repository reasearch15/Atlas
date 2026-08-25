import { ENGAGEMENT_CALLBACK_PREFIX } from "./engagement.constants";
import { votePercentages, winningOptionIndex } from "./engagement.scoring";

export const OPEN_POLL_HEADING = "🤔 WHICH WOULD YOU CHOOSE?";
export const OPEN_POLL_VOTE_HINT = "👇 Vote below — results in 4 hours";
export const CLOSED_POLL_HEADING = "📊 POLL RESULTS";
export const CLOSED_POLL_NO_VOTES = "No votes this round.";

export function pollUuidToCallbackId(pollId: string): string {
  return pollId.replace(/-/g, "");
}

export function callbackIdToPollUuid(shortId: string): string | null {
  if (!/^[0-9a-f]{32}$/i.test(shortId)) return null;
  const s = shortId.toLowerCase();
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

export function buildVoteCallbackData(pollId: string, optionIndex: number): string {
  return `${ENGAGEMENT_CALLBACK_PREFIX}${pollUuidToCallbackId(pollId)}:${optionIndex}`;
}

export function parseVoteCallbackData(
  data: string
): { readonly pollId: string; readonly optionIndex: number } | null {
  const trimmed = data.trim();
  if (!trimmed.startsWith(ENGAGEMENT_CALLBACK_PREFIX)) return null;
  const rest = trimmed.slice(ENGAGEMENT_CALLBACK_PREFIX.length);
  const match = /^([0-9a-f]{32}):([0-3])$/i.exec(rest);
  if (!match) return null;
  const pollId = callbackIdToPollUuid(match[1]!);
  if (!pollId) return null;
  return { pollId, optionIndex: Number(match[2]) };
}

export function formatOpenPollMessage(question: string): string {
  return `${OPEN_POLL_HEADING}\n\n${question.trim()}\n\n${OPEN_POLL_VOTE_HINT}`;
}

export function formatClosedPollMessage(input: {
  readonly question: string;
  readonly options: readonly [string, string, string, string];
  readonly counts: readonly number[];
}): string {
  const question = input.question.trim();
  const total = input.counts.reduce((sum, n) => sum + n, 0);
  if (total <= 0) {
    return [CLOSED_POLL_HEADING, "", question, "", CLOSED_POLL_NO_VOTES].join("\n");
  }
  const percentages = votePercentages(input.counts);
  const winner = winningOptionIndex(input.counts);
  const lines = input.options.map((option, index) => {
    const prefix = index === winner ? "🥇 " : "";
    return `${prefix}${option} — ${percentages[index] ?? 0}%`;
  });
  return [
    CLOSED_POLL_HEADING,
    "",
    question,
    "",
    ...lines,
    "",
    `🏆 Winning choice: ${input.options[winner]}`
  ].join("\n");
}

export function formatDailyWinnersMessage(input: {
  readonly firstName?: string | null;
  readonly secondName?: string | null;
  readonly thirdName?: string | null;
}): string {
  const lines = ["🏆 DAILY ENGAGEMENT WINNERS", ""];
  if (input.firstName) lines.push(`🥇 ${input.firstName} — $5 Freeplay`);
  if (input.secondName) lines.push(`🥈 ${input.secondName} — $2 Freeplay`);
  if (input.thirdName) lines.push(`🥉 ${input.thirdName} — $1 Freeplay`);
  if (lines.length === 2) lines.push("No eligible engagement winners today.");
  return lines.join("\n");
}

export function formatDailyDrawCaption(input: {
  readonly displayName: string;
  readonly referralWeight: number;
  readonly activeReferralCount: number;
}): string {
  const name = input.displayName.trim() || "Player";
  const lines = [
    `🎉 Congratulations ${name}!`,
    "",
    "You won today's $5 Freeplay Lucky Subscriber Draw."
  ];
  if (input.referralWeight > 0) {
    const boost =
      input.activeReferralCount === 1
        ? "1 active referral boosted today's winning chances!"
        : `${input.activeReferralCount} active referrals boosted today's winning chances!`;
    lines.push("", "🔥 Your successful referrals increased your chances in today's draw.", `🔥 ${boost}`);
  }
  lines.push(
    "",
    "Every eligible registered subscriber has a chance to win.",
    "Successful referrals increase your chance.",
    "Each new successful referral starts with a strong boost, then fades over time.",
    "Refer players to increase your chances in future daily draws."
  );
  return lines.join("\n");
}

export function buildPollInlineKeyboard(
  pollId: string,
  options: readonly [string, string, string, string]
) {
  return {
    inline_keyboard: options.map((text, index) => [
      { text, callback_data: buildVoteCallbackData(pollId, index) }
    ])
  };
}

export const EMPTY_INLINE_KEYBOARD = { inline_keyboard: [] as const };
