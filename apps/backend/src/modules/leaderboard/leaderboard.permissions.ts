import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * Builds route guards for leaderboard reads (current board, standings, player status, search).
 */
export function leaderboardReadGuard(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await app.authenticate(request, reply);
    await app.requireRole(["COADMIN", "STAFF"])(request, reply);
    await app.requirePermission("leaderboard:read")(request, reply);
  };
}

/**
 * Builds route guards for recording deposits.
 */
export function leaderboardDepositGuard(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await app.authenticate(request, reply);
    await app.requireRole(["COADMIN", "STAFF"])(request, reply);
    await app.requirePermission("leaderboard:deposit")(request, reply);
  };
}

/**
 * Builds route guards for setting referral links.
 */
export function leaderboardReferralGuard(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await app.authenticate(request, reply);
    await app.requireRole(["COADMIN", "STAFF"])(request, reply);
    await app.requirePermission("leaderboard:referral:set")(request, reply);
  };
}

/**
 * Builds route guards for recording promotions.
 */
export function leaderboardPromotionGuard(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await app.authenticate(request, reply);
    await app.requireRole(["COADMIN", "STAFF"])(request, reply);
    await app.requirePermission("leaderboard:promotion")(request, reply);
  };
}

/**
 * Builds route guards for Give Info messaging.
 */
export function leaderboardGiveInfoGuard(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await app.authenticate(request, reply);
    await app.requireRole(["COADMIN", "STAFF"])(request, reply);
    await app.requirePermission("leaderboard:give-info")(request, reply);
  };
}

/**
 * Builds route guards for Coadmin-only participant bind (connect player to board).
 * Requires deposit permission (same capability used to operate on the board).
 */
export function leaderboardBindGuard(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await app.authenticate(request, reply);
    await app.requireRole(["COADMIN"])(request, reply);
    await app.requirePermission("leaderboard:deposit")(request, reply);
  };
}

/**
 * Staff + Coadmin: deterministic auto-bind heal (never transfers; never guesses).
 */
export function leaderboardEnsureAutoBindGuard(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await app.authenticate(request, reply);
    await app.requireRole(["COADMIN", "STAFF"])(request, reply);
    await app.requirePermission("leaderboard:read")(request, reply);
  };
}

/**
 * Coadmin-only settings mutations and settings reads.
 */
export function leaderboardSettingsGuard(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await app.authenticate(request, reply);
    await app.requireRole(["COADMIN"])(request, reply);
    await app.requirePermission("leaderboard:settings")(request, reply);
  };
}

/**
 * Coadmin-only event reverse.
 */
export function leaderboardReverseGuard(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await app.authenticate(request, reply);
    await app.requireRole(["COADMIN"])(request, reply);
    await app.requirePermission("leaderboard:reverse")(request, reply);
  };
}

/**
 * Coadmin-only referral override.
 */
export function leaderboardReferralOverrideGuard(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await app.authenticate(request, reply);
    await app.requireRole(["COADMIN"])(request, reply);
    await app.requirePermission("leaderboard:referral:override")(request, reply);
  };
}

/**
 * Coadmin-only competition finalize.
 */
export function leaderboardFinalizeGuard(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await app.authenticate(request, reply);
    await app.requireRole(["COADMIN"])(request, reply);
    await app.requirePermission("leaderboard:finalize")(request, reply);
  };
}

/**
 * Coadmin-only payout mark.
 */
export function leaderboardPayoutMarkGuard(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await app.authenticate(request, reply);
    await app.requireRole(["COADMIN"])(request, reply);
    await app.requirePermission("leaderboard:payout:mark")(request, reply);
  };
}

/**
 * Coadmin-only eligibility review mutations.
 */
export function leaderboardEligibilityReviewGuard(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await app.authenticate(request, reply);
    await app.requireRole(["COADMIN"])(request, reply);
    await app.requirePermission("leaderboard:eligibility:review")(request, reply);
  };
}

/**
 * Coadmin-only admin reads (events, referrals, competition review).
 * Uses settings permission as the admin-read capability.
 */
export function leaderboardAdminReadGuard(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await app.authenticate(request, reply);
    await app.requireRole(["COADMIN"])(request, reply);
    await app.requirePermission("leaderboard:settings")(request, reply);
  };
}

/**
 * Coadmin-only Telegram bot integration management.
 */
export function leaderboardTelegramManageGuard(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await app.authenticate(request, reply);
    await app.requireRole(["COADMIN"])(request, reply);
    await app.requirePermission("leaderboard:telegram:manage")(request, reply);
  };
}

/**
 * Coadmin-only Telegram membership verification enqueue.
 */
export function leaderboardTelegramVerifyGuard(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await app.authenticate(request, reply);
    await app.requireRole(["COADMIN"])(request, reply);
    await app.requirePermission("leaderboard:telegram:verify")(request, reply);
  };
}

/**
 * Staff + Coadmin wheel spin (Atlas UI). Bot Spin callback is DEFERRED.
 */
export function leaderboardWheelSpinGuard(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await app.authenticate(request, reply);
    await app.requireRole(["COADMIN", "STAFF"])(request, reply);
    await app.requirePermission("leaderboard:wheel:spin")(request, reply);
  };
}

/**
 * Coadmin-only wheel configuration management.
 */
export function leaderboardWheelManageGuard(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await app.authenticate(request, reply);
    await app.requireRole(["COADMIN"])(request, reply);
    await app.requirePermission("leaderboard:wheel:manage")(request, reply);
  };
}
