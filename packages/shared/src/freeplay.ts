export type FreeplayPlayerStatus = "ELIGIBLE" | "NOT_ELIGIBLE" | "ROLLING_LIMIT";

export interface FreeplayPlayerStatusDto {
  readonly status: FreeplayPlayerStatus;
  readonly canSpin: boolean;
  readonly nextAvailableAt: string | null;
  readonly playerMessage: string;
}

export interface FreeplayStaffClaimDto {
  readonly id: string;
  readonly spinId: string;
  readonly crmContactId: string;
  readonly chatId: string | null;
  readonly rewardAmountCents: number;
  readonly status: "UNCLAIMED" | "CLAIMED";
  readonly createdAt: string;
  readonly claimedAt: string | null;
  readonly claimedByUserId: string | null;
  readonly claimedByName: string | null;
  readonly fulfillmentNote: string | null;
}

export interface FreeplayStaffStatusDto {
  readonly eligible: boolean;
  readonly playerStatus: FreeplayPlayerStatus;
  readonly thresholdCents: number;
  readonly qualifyingRemainderCents: number;
  readonly earnedSpinCredits: number;
  readonly consumedSpinCredits: number;
  readonly availableEconomicCredits: number;
  readonly spinsInRollingWindow: number;
  readonly maxSpinsPerWindow: number;
  readonly nextAvailableAt: string | null;
  readonly eligibilityReason: "ELIGIBLE" | "NO_EARNED_CREDIT" | "ROLLING_LIMIT";
  readonly claims: readonly FreeplayStaffClaimDto[];
}

export interface FreeplaySpinResultDto {
  readonly playerStatus: FreeplayPlayerStatusDto;
  readonly spinId: string;
  readonly rewardAmountCents: number;
  readonly claimId: string | null;
  readonly replay: boolean;
}
