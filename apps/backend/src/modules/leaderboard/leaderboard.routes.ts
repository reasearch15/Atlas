import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  leaderboardCompetitionParamsSchema,
  leaderboardContactParamsSchema,
  leaderboardDepositBodySchema,
  leaderboardEligibilityBodySchema,
  leaderboardEnabledBodySchema,
  leaderboardEventParamsSchema,
  leaderboardEventsQuerySchema,
  leaderboardFinalizeBodySchema,
  leaderboardGiveInfoBodySchema,
  leaderboardPayoutMarkBodySchema,
  leaderboardPayoutParamsSchema,
  leaderboardPlayerSearchQuerySchema,
  leaderboardPoolRateBodySchema,
  leaderboardPromotionBodySchema,
  leaderboardReferralBodySchema,
  leaderboardReferralOverrideBodySchema,
  leaderboardReferralParamsSchema,
  leaderboardReverseEventBodySchema,
  leaderboardStandingsQuerySchema,
  leaderboardTelegramChannelBodySchema,
  leaderboardTelegramConnectBodySchema,
  leaderboardTelegramDisconnectBodySchema,
  leaderboardTelegramPostingBodySchema,
  leaderboardTelegramRotateTokenBodySchema
} from "@atlas/shared";
import { AppError } from "../../utils/errors";
import { LeaderboardError } from "./leaderboard.errors";
import { LeaderboardApiService } from "./leaderboard.api-service";
import { mapLeaderboardError } from "./leaderboard.http-errors";
import {
  leaderboardAdminReadGuard,
  leaderboardBindGuard,
  leaderboardDepositGuard,
  leaderboardEligibilityReviewGuard,
  leaderboardFinalizeGuard,
  leaderboardGiveInfoGuard,
  leaderboardPayoutMarkGuard,
  leaderboardPromotionGuard,
  leaderboardReadGuard,
  leaderboardReferralGuard,
  leaderboardReferralOverrideGuard,
  leaderboardReverseGuard,
  leaderboardSettingsGuard,
  leaderboardTelegramManageGuard,
  leaderboardTelegramVerifyGuard
} from "./leaderboard.permissions";

const bindBodySchema = z.object({
  crmContactId: z.string().uuid()
});

const eligibilityParamsSchema = z.object({
  competitionId: z.string().uuid(),
  crmContactId: z.string().uuid()
});

const payoutsQuerySchema = z.object({
  competitionId: z.string().uuid().optional()
});

/**
 * Registers leaderboard HTTP routes under `/api/leaderboard`.
 * Catches LeaderboardError → HTTP AppError; AppError passes through.
 */
export async function leaderboardRoutes(app: FastifyInstance): Promise<void> {
  const service = new LeaderboardApiService(app);

  const handle = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof LeaderboardError) throw mapLeaderboardError(error);
      throw error;
    }
  };

  app.get("/current", { preHandler: [leaderboardReadGuard(app)] }, async (request) =>
    handle(() => service.getCurrentBoard(request.user!))
  );

  app.get("/standings", { preHandler: [leaderboardReadGuard(app)] }, async (request) =>
    handle(async () => {
      const query = leaderboardStandingsQuerySchema.parse(request.query);
      return service.listStandings(request.user!, {
        filter: query.filter,
        page: query.page,
        pageSize: query.pageSize,
        ...(query.q !== undefined ? { q: query.q } : {})
      });
    })
  );

  app.get("/player/:crmContactId", { preHandler: [leaderboardReadGuard(app)] }, async (request) =>
    handle(async () => {
      const params = leaderboardContactParamsSchema.parse(request.params);
      return service.getPlayerStatus(request.user!, params.crmContactId);
    })
  );

  app.get("/players/search", { preHandler: [leaderboardReadGuard(app)] }, async (request) =>
    handle(async () => {
      const query = leaderboardPlayerSearchQuerySchema.parse(request.query);
      return service.searchPlayers(
        request.user!,
        query.q,
        query.excludeContactId,
        query.limit
      );
    })
  );

  app.post("/participants/bind", { preHandler: [leaderboardBindGuard(app)] }, async (request) =>
    handle(async () => {
      const body = bindBodySchema.parse(request.body);
      return service.bindParticipant(request.user!, body.crmContactId);
    })
  );

  app.post("/deposits", { preHandler: [leaderboardDepositGuard(app)] }, async (request) =>
    handle(async () => {
      const body = leaderboardDepositBodySchema.parse(request.body);
      return service.recordDeposit(request.user!, {
        crmContactId: body.crmContactId,
        amountCents: body.amountCents,
        idempotencyKey: body.idempotencyKey,
        ...(body.reason !== undefined ? { reason: body.reason } : {})
      });
    })
  );

  app.put("/referrals", { preHandler: [leaderboardReferralGuard(app)] }, async (request) =>
    handle(async () => {
      const body = leaderboardReferralBodySchema.parse(request.body);
      return service.setReferral(request.user!, body);
    })
  );

  app.post("/promotions", { preHandler: [leaderboardPromotionGuard(app)] }, async (request) =>
    handle(async () => {
      const body = leaderboardPromotionBodySchema.parse(request.body);
      return service.recordPromotion(request.user!, {
        crmContactId: body.crmContactId,
        idempotencyKey: body.idempotencyKey,
        ...(body.reason !== undefined ? { reason: body.reason } : {})
      });
    })
  );

  app.post("/give-info", { preHandler: [leaderboardGiveInfoGuard(app)] }, async (request) =>
    handle(async () => {
      const body = leaderboardGiveInfoBodySchema.parse(request.body);
      return service.giveInfo(request.user!, body);
    })
  );

  // --- Phase 3 Coadmin admin routes ---

  app.get("/settings", { preHandler: [leaderboardSettingsGuard(app)] }, async (request) =>
    handle(() => service.getSettings(request.user!))
  );

  app.patch("/settings/enabled", { preHandler: [leaderboardSettingsGuard(app)] }, async (request) =>
    handle(async () => {
      const body = leaderboardEnabledBodySchema.parse(request.body);
      return service.setEnabled(request.user!, body.enabled, body.confirmDisable);
    })
  );

  app.patch("/settings/pool-rate", { preHandler: [leaderboardSettingsGuard(app)] }, async (request) =>
    handle(async () => {
      const body = leaderboardPoolRateBodySchema.parse(request.body);
      return service.setPoolRate(
        request.user!,
        body.poolRateBps,
        body.reason
      );
    })
  );

  app.get(
    "/settings/pool-rate-history",
    { preHandler: [leaderboardSettingsGuard(app)] },
    async (request) => handle(() => service.getPoolRateHistory(request.user!))
  );

  app.get("/admin/competition", { preHandler: [leaderboardAdminReadGuard(app)] }, async (request) =>
    handle(() => service.getAdminCompetition(request.user!))
  );

  app.get("/events", { preHandler: [leaderboardAdminReadGuard(app)] }, async (request) =>
    handle(async () => {
      const query = leaderboardEventsQuerySchema.parse(request.query);
      return service.listEvents(request.user!, {
        page: query.page,
        pageSize: query.pageSize,
        ...(query.type !== undefined ? { type: query.type } : {}),
        ...(query.crmContactId !== undefined ? { crmContactId: query.crmContactId } : {})
      });
    })
  );

  app.post(
    "/events/:eventId/reverse",
    { preHandler: [leaderboardReverseGuard(app)] },
    async (request) =>
      handle(async () => {
        const params = leaderboardEventParamsSchema.parse(request.params);
        const body = leaderboardReverseEventBodySchema.parse(request.body);
        return service.reverseEvent(
          request.user!,
          params.eventId,
          body.reason,
          body.idempotencyKey
        );
      })
  );

  app.get("/referrals", { preHandler: [leaderboardAdminReadGuard(app)] }, async (request) =>
    handle(() => service.listReferrals(request.user!))
  );

  app.post(
    "/referrals/:referralId/override",
    { preHandler: [leaderboardReferralOverrideGuard(app)] },
    async (request) =>
      handle(async () => {
        const params = leaderboardReferralParamsSchema.parse(request.params);
        const body = leaderboardReferralOverrideBodySchema.parse(request.body);
        return service.overrideReferral(
          request.user!,
          params.referralId,
          body.newReferrerCrmContactId,
          body.reason,
          body.idempotencyKey
        );
      })
  );

  app.get(
    "/competitions/:competitionId/review",
    { preHandler: [leaderboardAdminReadGuard(app)] },
    async (request) =>
      handle(async () => {
        const params = leaderboardCompetitionParamsSchema.parse(request.params);
        return service.getCompetitionReview(request.user!, params.competitionId);
      })
  );

  app.post(
    "/competitions/:competitionId/eligibility/:crmContactId",
    { preHandler: [leaderboardEligibilityReviewGuard(app)] },
    async (request) =>
      handle(async () => {
        const params = eligibilityParamsSchema.parse(request.params);
        const body = leaderboardEligibilityBodySchema.parse(request.body);
        return service.setEligibility(request.user!, params.competitionId, params.crmContactId, {
          membershipStatus: body.membershipStatus,
          idempotencyKey: body.idempotencyKey,
          ...(body.reason !== undefined ? { reason: body.reason } : {}),
          ...(body.ineligibilityReason !== undefined
            ? { ineligibilityReason: body.ineligibilityReason }
            : {}),
          ...(body.explicitOverride !== undefined
            ? { explicitOverride: body.explicitOverride }
            : {})
        });
      })
  );

  app.post(
    "/competitions/:competitionId/finalize",
    { preHandler: [leaderboardFinalizeGuard(app)] },
    async (request) =>
      handle(async () => {
        const params = leaderboardCompetitionParamsSchema.parse(request.params);
        const body = leaderboardFinalizeBodySchema.parse(request.body);
        return service.finalize(
          request.user!,
          params.competitionId,
          body.idempotencyKey,
          body.confirm
        );
      })
  );

  app.get("/payouts", { preHandler: [leaderboardAdminReadGuard(app)] }, async (request) =>
    handle(async () => {
      const query = payoutsQuerySchema.parse(request.query);
      return service.listPayouts(request.user!, query.competitionId);
    })
  );

  app.patch("/payouts/:payoutId", { preHandler: [leaderboardPayoutMarkGuard(app)] }, async (request) =>
    handle(async () => {
      const params = leaderboardPayoutParamsSchema.parse(request.params);
      const body = leaderboardPayoutMarkBodySchema.parse(request.body);
      return service.markPayout(
        request.user!,
        params.payoutId,
        body.status,
        body.notes,
        body.confirm,
        body.idempotencyKey
      );
    })
  );

  app.get("/telegram-integration", { preHandler: [leaderboardTelegramManageGuard(app)] }, async (request) =>
    handle(() => service.getTelegramIntegration(request.user!))
  );

  app.post(
    "/telegram-integration/connect",
    { preHandler: [leaderboardTelegramManageGuard(app)] },
    async (request) =>
      handle(async () => {
        const body = leaderboardTelegramConnectBodySchema.parse(request.body);
        return service.connectTelegramBot(request.user!, body.token);
      })
  );

  app.post(
    "/telegram-integration/test",
    { preHandler: [leaderboardTelegramManageGuard(app)] },
    async (request) => handle(() => service.testTelegramConnection(request.user!))
  );

  app.post(
    "/telegram-integration/rotate-token",
    { preHandler: [leaderboardTelegramManageGuard(app)] },
    async (request) =>
      handle(async () => {
        const body = leaderboardTelegramRotateTokenBodySchema.parse(request.body);
        return service.rotateTelegramToken(request.user!, body.token);
      })
  );

  app.patch(
    "/telegram-integration/channel",
    { preHandler: [leaderboardTelegramManageGuard(app)] },
    async (request) =>
      handle(async () => {
        const body = leaderboardTelegramChannelBodySchema.parse(request.body);
        return service.setTelegramChannel(request.user!, body.channelRef);
      })
  );

  app.post(
    "/telegram-integration/verify-channel",
    { preHandler: [leaderboardTelegramManageGuard(app)] },
    async (request) => handle(() => service.verifyTelegramChannel(request.user!))
  );

  app.patch(
    "/telegram-integration/posting",
    { preHandler: [leaderboardTelegramManageGuard(app)] },
    async (request) =>
      handle(async () => {
        const body = leaderboardTelegramPostingBodySchema.parse(request.body);
        return service.setTelegramPosting(request.user!, body.postingEnabled);
      })
  );

  app.delete(
    "/telegram-integration",
    { preHandler: [leaderboardTelegramManageGuard(app)] },
    async (request) =>
      handle(async () => {
        const body = leaderboardTelegramDisconnectBodySchema.parse(request.body ?? { confirm: true });
        return service.disconnectTelegram(request.user!, body.confirm);
      })
  );

  app.post(
    "/competitions/:competitionId/verify-membership",
    { preHandler: [leaderboardTelegramVerifyGuard(app)] },
    async (request) =>
      handle(async () => {
        const params = leaderboardCompetitionParamsSchema.parse(request.params);
        return service.enqueueVerifyMembership(request.user!, params.competitionId);
      })
  );
}
