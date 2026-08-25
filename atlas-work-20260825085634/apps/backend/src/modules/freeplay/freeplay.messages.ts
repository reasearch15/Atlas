import type { FreeplayPlayerStatus, FreeplayPlayerStatusDto } from "@atlas/shared";

export function buildFreeplayPlayerMessage(status: FreeplayPlayerStatus, nextAvailableAt: string | null): string {
  if (status === "ELIGIBLE") {
    return "🎁 Your Freeplay Wheel is ready!\nTry your luck and see what you win.";
  }
  if (status === "ROLLING_LIMIT") {
    return [
      "⏳ You've used your Freeplay Wheel chances for now.",
      "Your next chance becomes available when your 24-hour window opens again.",
      nextAvailableAt ? `Next spin: ${nextAvailableAt}` : null
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
  }
  return "🎁 No Freeplay Wheel available yet.\n⭐ Keep earning leaderboard points and playing with us — you're getting closer!";
}

export function toFreeplayPlayerStatusDto(input: {
  readonly status: FreeplayPlayerStatus;
  readonly nextAvailableAt: string | null;
}): FreeplayPlayerStatusDto {
  return {
    status: input.status,
    canSpin: input.status === "ELIGIBLE",
    nextAvailableAt: input.status === "ROLLING_LIMIT" ? input.nextAvailableAt : null,
    playerMessage: buildFreeplayPlayerMessage(input.status, input.nextAvailableAt)
  };
}

export function formatFreeplaySpinResultMessage(rewardAmountCents: number): string {
  if (rewardAmountCents <= 0) {
    return "No Freeplay this time 🍀\nKeep earning leaderboard points and check back for your next chance.";
  }
  return `🎉 You won $${Math.trunc(rewardAmountCents / 100)} Freeplay!\nYour reward is waiting for staff to load.`;
}
