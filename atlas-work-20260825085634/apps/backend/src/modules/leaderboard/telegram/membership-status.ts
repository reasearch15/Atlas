import type { PrizeMembershipStatus } from "../leaderboard.types";

export interface MembershipMappingResult {
  readonly membershipStatus: PrizeMembershipStatus;
  readonly ineligibilityReason: string | null;
}

/**
 * Maps Telegram Bot API ChatMember.status → domain prize membership status.
 * Technical ambiguity must remain PENDING_REVIEW (never auto-disqualify).
 */
export function mapTelegramChatMemberStatus(status: string | null | undefined): MembershipMappingResult {
  const normalized = (status ?? "").trim().toLowerCase();
  switch (normalized) {
    case "creator":
    case "administrator":
    case "member":
    case "restricted":
      return { membershipStatus: "ELIGIBLE", ineligibilityReason: null };
    case "left":
    case "kicked":
      return { membershipStatus: "NOT_ELIGIBLE", ineligibilityReason: "NOT_SUBSCRIBED" };
    default:
      return { membershipStatus: "PENDING_REVIEW", ineligibilityReason: null };
  }
}
