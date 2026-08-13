import type { Role } from "@atlas/shared";
import { hasPermission } from "@atlas/shared";

/**
 * Operational CRM leaderboard capabilities derived from permissions.
 * Never gate Staff ops with `role === "COADMIN"` — use these helpers instead.
 */
export interface CrmGiveawayCapabilities {
  readonly canRead: boolean;
  readonly canDeposit: boolean;
  readonly canReferral: boolean;
  readonly canPromotion: boolean;
  readonly canGiveInfo: boolean;
  readonly canWheelSpin: boolean;
  /** Coadmin-only: bind / auto-bind (backend requires COADMIN). */
  readonly canBind: boolean;
  /** Staff + Coadmin: call ensure-auto-bind heal. */
  readonly canEnsureAutoBind: boolean;
  /** Coadmin-only admin surface — must never appear in CRM player ops. */
  readonly canAdminSettings: boolean;
  readonly canReverse: boolean;
  readonly canReferralOverride: boolean;
  readonly canFinalize: boolean;
  readonly canPayout: boolean;
  readonly canEligibilityReview: boolean;
  readonly canTelegramManage: boolean;
  readonly canWheelManage: boolean;
}

export function crmGiveawayCapabilities(role: Role | null | undefined): CrmGiveawayCapabilities {
  if (!role) {
    return {
      canRead: false,
      canDeposit: false,
      canReferral: false,
      canPromotion: false,
      canGiveInfo: false,
      canWheelSpin: false,
      canBind: false,
      canEnsureAutoBind: false,
      canAdminSettings: false,
      canReverse: false,
      canReferralOverride: false,
      canFinalize: false,
      canPayout: false,
      canEligibilityReview: false,
      canTelegramManage: false,
      canWheelManage: false
    };
  }

  const canAdminSettings = hasPermission(role, "leaderboard:settings");
  return {
    canRead: hasPermission(role, "leaderboard:read"),
    canDeposit: hasPermission(role, "leaderboard:deposit"),
    canReferral: hasPermission(role, "leaderboard:referral:set"),
    canPromotion: hasPermission(role, "leaderboard:promotion"),
    canGiveInfo: hasPermission(role, "leaderboard:give-info"),
    canWheelSpin: hasPermission(role, "leaderboard:wheel:spin"),
    // Manual bind remains Coadmin recovery tooling; auto-heal uses leaderboard:read.
    canBind: canAdminSettings && hasPermission(role, "leaderboard:deposit"),
    /** Staff + Coadmin: deterministic ensure-auto-bind on CRM open. */
    canEnsureAutoBind: hasPermission(role, "leaderboard:read"),
    canAdminSettings,
    canReverse: hasPermission(role, "leaderboard:reverse"),
    canReferralOverride: hasPermission(role, "leaderboard:referral:override"),
    canFinalize: hasPermission(role, "leaderboard:finalize"),
    canPayout: hasPermission(role, "leaderboard:payout:mark"),
    canEligibilityReview: hasPermission(role, "leaderboard:eligibility:review"),
    canTelegramManage: hasPermission(role, "leaderboard:telegram:manage"),
    canWheelManage: hasPermission(role, "leaderboard:wheel:manage")
  };
}

/** True when the role may use the CRM operational leaderboard panel. */
export function canViewCrmGiveawayPanel(role: Role | null | undefined): boolean {
  return crmGiveawayCapabilities(role).canRead;
}
