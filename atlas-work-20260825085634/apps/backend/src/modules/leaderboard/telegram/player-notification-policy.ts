import type { AnnouncementKind } from "./announcement-policy";

export type PlayerNotificationKind =
  | AnnouncementKind
  | "REFERRAL_MILESTONE"
  | "FINAL_RESULT_WINNER"
  | "FINAL_RESULT_INELIGIBLE"
  | "FINAL_RESULT"
  | "SIGNIFICANT_TOP_MOVE";

export interface PlayerNotificationDecision {
  readonly shouldNotify: boolean;
  readonly kind: PlayerNotificationKind;
  readonly dedupeKey: string;
}

/**
 * Decides whether a personal bot DM should be enqueued for a player.
 * Conservative: announce threshold crossings / milestones / finals — not every point tick.
 */
export function decidePlayerNotification(input: {
  readonly competitionId: string;
  readonly crmContactId: string;
  readonly kind: PlayerNotificationKind;
  readonly hasPlayerLink: boolean;
  /** Owner of the player's board — must match the bot that will send. */
  readonly ownerCoadminUserId: string;
  readonly botOwnerCoadminUserId: string;
}): PlayerNotificationDecision {
  const dedupeKey = `lb:pdm:${input.ownerCoadminUserId}:${input.competitionId}:${input.crmContactId}:${input.kind}`;

  if (!input.hasPlayerLink) {
    return { shouldNotify: false, kind: input.kind, dedupeKey };
  }
  // Never send via B's bot for A's player.
  if (input.ownerCoadminUserId !== input.botOwnerCoadminUserId) {
    return { shouldNotify: false, kind: input.kind, dedupeKey };
  }

  const allowed: ReadonlySet<PlayerNotificationKind> = new Set([
    "ENTER_TOP_10",
    "ENTER_TOP_3",
    "REACHED_NUMBER_1",
    "TOP_3_ORDER_CHANGED",
    "CLIMBED_IN_TOP_10",
    "SIGNIFICANT_TOP_MOVE",
    "REFERRAL_MILESTONE",
    "FINAL_RESULT_WINNER",
    "FINAL_RESULT_INELIGIBLE",
    "FINAL_RESULT"
  ]);

  return {
    shouldNotify: allowed.has(input.kind),
    kind: input.kind,
    dedupeKey: dedupeKey.slice(0, 320)
  };
}

/**
 * Maps channel announcement kinds to personal DM kinds (1:1 for Phase 5).
 */
export function announcementKindToPlayerKind(kind: AnnouncementKind): PlayerNotificationKind {
  return kind;
}
