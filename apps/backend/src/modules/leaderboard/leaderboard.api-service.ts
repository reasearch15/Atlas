import type { FastifyInstance } from "fastify";
import type {
  LeaderboardAdminCompetitionDto,
  LeaderboardCompetitionReviewDto,
  LeaderboardCompetitionSummaryDto,
  LeaderboardCurrentBoardDto,
  LeaderboardDepositResultDto,
  LeaderboardEligibilityCandidateDto,
  LeaderboardEventRowDto,
  LeaderboardEventsPageDto,
  LeaderboardGiveInfoResultDto,
  LeaderboardPayoutDto,
  LeaderboardPlayerSearchHitDto,
  LeaderboardPlayerStatusDto,
  LeaderboardPoolRateHistoryDto,
  LeaderboardPromotionResultDto,
  LeaderboardReferralAdminRowDto,
  LeaderboardReferralResultDto,
  LeaderboardSettingsDto,
  LeaderboardStandingFilter,
  LeaderboardStandingRowDto,
  LeaderboardStandingsPageDto,
  LeaderboardTelegramIntegrationDto,
  LeaderboardWheelConfigVersionDto,
  LeaderboardWheelSettingsDto,
  LeaderboardWheelSpinResultDto,
  LeaderboardWheelStatusDto,
  LeaderboardWheelQualificationCreditPolicy,
  Role
} from "@atlas/shared";
import { customerPrivacyCapabilities } from "@atlas/shared";
import type { RequestUser } from "../auth/auth.types";
import { AuditService } from "../audit/audit.service";
import { TelegramService } from "../telegram/telegram.service";
import { AppError, forbidden } from "../../utils/errors";
import { buildGiveInfoMessage } from "./give-info-message";
import { ALLOWED_POOL_RATE_BPS } from "./leaderboard.constants";
import {
  eventAlreadyReversed,
  eventNotFound,
  eventNotReversible,
  LeaderboardError,
  missingReason,
  ownerMismatch,
  referralNotFound
} from "./leaderboard.errors";
import { leaderboardOwnerUnresolved } from "./leaderboard.http-errors";
import { PrismaLeaderboardService } from "./leaderboard.prisma-service";
import { computeStandingGaps } from "./leaderboard.standing-helpers";
import {
  normalizePlayerSearchQuery,
  playerMatchesSearchQuery,
  selectPlayerSearchHits
} from "./player-search";
import { selectPrizeWinnersFromEligibility } from "./prize-eligibility";
import { withRanks } from "./ranking";
import { tryAutoBindForActingCoadmin, tryAutoBindParticipant } from "./auto-bind";
import { backfillLeaderboardParticipants } from "./backfill-participants";
import { resolveDeterministicLeaderboardOwner } from "./ownership-resolution";
import { decidePlayerNotification } from "./telegram/player-notification-policy";
import type { LeaderboardTelegramIntegrationService } from "./telegram/leaderboard-telegram.integration-service";
import type { LeaderboardTelegramOutboxService } from "./telegram/leaderboard-telegram.outbox";
import { PrismaWheelService } from "./wheel.prisma-service";
import { createCryptoWheelRng, type WheelRng } from "./wheel-rng";
import { formatPersonalAnnouncementDm } from "./telegram/personal-rank-message";

export interface LeaderboardEventsQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly type?: string | undefined;
  readonly crmContactId?: string | undefined;
}

export interface LeaderboardSettingsWithHistoryDto extends LeaderboardSettingsDto {
  readonly history: readonly LeaderboardPoolRateHistoryDto[];
}

export interface LeaderboardStandingsQuery {
  readonly filter: LeaderboardStandingFilter;
  readonly q?: string | undefined;
  readonly page: number;
  readonly pageSize: number;
}

type RankedStanding = {
  rank: number;
  crmContactId: string;
  displayName: string;
  telegramUsername: string | null;
  totalPoints: number;
  depositPoints: number;
  referralPoints: number;
  promotionPoints: number;
  wheelPoints: number;
  qualifyingDepositCents: number;
  successfulReferralCount: number;
  lastEventAt: Date | null;
  lastEventReason: string | null;
  pointsReachedAt: Date;
};

/**
 * Filters ranked standings for list endpoints (pure; exported for tests).
 */
export function applyStandingFilterRows<T extends RankedStanding>(
  ranked: readonly T[],
  filter: LeaderboardStandingFilter
): T[] {
  switch (filter) {
    case "TOP_10":
      return ranked.filter((row) => row.rank <= 10);
    case "TOP_50":
      return ranked.filter((row) => row.rank <= 50);
    case "REFERRERS":
      return ranked.filter((row) => row.successfulReferralCount > 0);
    case "RECENTLY_CHANGED":
      return [...ranked]
        .filter((row) => row.lastEventAt != null)
        .sort((a, b) => (b.lastEventAt?.getTime() ?? 0) - (a.lastEventAt?.getTime() ?? 0));
    case "ALL":
    default:
      return [...ranked];
  }
}

/**
 * HTTP orchestration for Atlas Leaderboard Phase 2.
 *
 * Staff board owner is always Workspace.primaryCoadminId (never a client-supplied id).
 * Coadmin board owner is always the authenticated coadmin's user id.
 */
export class LeaderboardApiService {
  private readonly domain: PrismaLeaderboardService;
  private readonly wheel: PrismaWheelService;
  private readonly audit: AuditService;
  private readonly outbox: LeaderboardTelegramOutboxService | undefined;
  private readonly telegramIntegration: LeaderboardTelegramIntegrationService | undefined;

  public constructor(private readonly app: FastifyInstance) {
    const decorated = app as FastifyInstance & {
      leaderboardTelegramOutbox?: LeaderboardTelegramOutboxService;
      leaderboardTelegramIntegration?: LeaderboardTelegramIntegrationService;
    };
    this.outbox = decorated.leaderboardTelegramOutbox;
    this.telegramIntegration = decorated.leaderboardTelegramIntegration;
    this.domain = new PrismaLeaderboardService(app.prisma, {
      projectionHooks: {
        onFrozen: async (info) => {
          await this.outbox?.enqueueRefresh(info.workspaceId, info.ownerCoadminUserId, info.competitionId);
          await this.outbox?.enqueueVerifyMembership(
            info.workspaceId,
            info.ownerCoadminUserId,
            info.competitionId
          );
        }
      }
    });
    this.wheel = new PrismaWheelService(app.prisma);
    this.audit = new AuditService(app.prisma);
  }

  private async projectAfterMutation(
    workspaceId: string,
    ownerCoadminUserId: string,
    competitionId: string | null | undefined
  ): Promise<void> {
    if (!this.outbox || !competitionId) return;
    try {
      await this.outbox.enqueueRefresh(workspaceId, ownerCoadminUserId, competitionId);
      const frozenPending = await this.app.prisma.leaderboardCompetition.findFirst({
        where: {
          workspaceId,
          ownerCoadminUserId,
          status: "FROZEN",
          eligibilityCandidates: { some: { membershipStatus: "PENDING_REVIEW" } }
        },
        select: { id: true }
      });
      if (frozenPending) {
        await this.outbox.enqueueVerifyMembership(workspaceId, ownerCoadminUserId, frozenPending.id);
      }
    } catch {
      // Projection must not fail the domain mutation response.
    }
  }

  private async projectStandingsForOwner(workspaceId: string, ownerCoadminUserId: string): Promise<void> {
    if (!this.outbox) return;
    try {
      const competition = await this.findActiveCompetition(workspaceId, ownerCoadminUserId, new Date());
      await this.projectAfterMutation(workspaceId, ownerCoadminUserId, competition?.id);
    } catch {
      // Tests / partial prisma mocks must not break domain mutations.
    }
  }

  /**
   * Resolves the board owner for the actor.
   * COADMIN → self. STAFF → workspace.primaryCoadminId only.
   */
  public async resolveBoardOwner(user: RequestUser): Promise<string> {
    this.assertStaffOrCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);

    if (user.role === "COADMIN") {
      return user.id;
    }

    const workspace = await this.app.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { primaryCoadminId: true }
    });
    if (!workspace?.primaryCoadminId) {
      throw leaderboardOwnerUnresolved();
    }
    return workspace.primaryCoadminId;
  }

  /**
   * Ensures the actor may mutate a player bound to `ownerCoadminUserId`.
   * COADMIN: owner must be self.
   * STAFF: owner must be the workspace primary coadmin (COADMIN in same workspace).
   */
  public async assertActorMayMutatePlayer(
    user: RequestUser,
    ownerCoadminUserId: string
  ): Promise<void> {
    this.assertStaffOrCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);

    if (user.role === "COADMIN") {
      if (ownerCoadminUserId !== user.id) {
        throw ownerMismatch();
      }
      return;
    }

    const workspace = await this.app.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { primaryCoadminId: true }
    });
    if (!workspace?.primaryCoadminId) {
      throw leaderboardOwnerUnresolved();
    }

    const owner = await this.app.prisma.user.findFirst({
      where: {
        id: ownerCoadminUserId,
        workspaceId,
        role: "COADMIN",
        status: "ACTIVE"
      },
      select: { id: true }
    });
    if (!owner || ownerCoadminUserId !== workspace.primaryCoadminId) {
      throw ownerMismatch();
    }
  }

  public async getCurrentBoard(user: RequestUser): Promise<LeaderboardCurrentBoardDto> {
    const workspaceId = this.requireWorkspaceId(user);
    const owner = await this.resolveBoardOwner(user);

    const settings = await this.domain.ensureSettings(workspaceId, owner, user.id);
    const now = new Date();
    const competition = settings.enabled
      ? await this.domain.ensureCurrentCompetition(workspaceId, owner, now)
      : await this.findActiveCompetition(workspaceId, owner, now);

    if (!competition) {
      return { competition: null, prizePoolCents: 0 };
    }

    const summary = this.toCompetitionSummary(competition);
    return { competition: summary, prizePoolCents: summary.prizePoolCents };
  }

  public async getPlayerStatus(
    user: RequestUser,
    crmContactId: string
  ): Promise<LeaderboardPlayerStatusDto> {
    const workspaceId = this.requireWorkspaceId(user);

    let owner: string;
    try {
      owner = await this.domain.resolveLeaderboardOwner(workspaceId, crmContactId);
    } catch (error) {
      if (error instanceof LeaderboardError && error.code === "PARTICIPANT_NOT_BOUND") {
        return {
          bound: false,
          crmContactId,
          competition: null,
          rank: null,
          totalPoints: null,
          depositPoints: null,
          referralPoints: null,
          promotionPoints: null,
          wheelPoints: null,
          qualifyingDepositCents: null,
          successfulReferralCount: null,
          lastEventAt: null,
          lastEventReason: null,
          unboundReason: "PARTICIPANT_NOT_BOUND",
          wheel: null
        };
      }
      throw error;
    }

    await this.assertActorMayMutatePlayer(user, owner);

    const settings = await this.domain.ensureSettings(workspaceId, owner, user.id);
    const now = new Date();
    const competition = settings.enabled
      ? await this.domain.ensureCurrentCompetition(workspaceId, owner, now)
      : await this.findActiveCompetition(workspaceId, owner, now);

    let wheel: LeaderboardWheelStatusDto | null = null;
    try {
      wheel = await this.wheel.getStatus(workspaceId, owner, crmContactId, now);
    } catch {
      wheel = null;
    }

    if (!competition) {
      return {
        bound: true,
        crmContactId,
        competition: null,
        rank: null,
        totalPoints: null,
        depositPoints: null,
        referralPoints: null,
        promotionPoints: null,
        wheelPoints: null,
        qualifyingDepositCents: null,
        successfulReferralCount: null,
        lastEventAt: null,
        lastEventReason: null,
        wheel
      };
    }

    const ranked = await this.loadRankedStandings(competition.id, owner, workspaceId);
    const standing = ranked.find((row) => row.crmContactId === crmContactId);

    return {
      bound: true,
      crmContactId,
      competition: this.toCompetitionSummary(competition),
      rank: standing?.rank ?? null,
      totalPoints: standing?.totalPoints ?? null,
      depositPoints: standing?.depositPoints ?? null,
      referralPoints: standing?.referralPoints ?? null,
      promotionPoints: standing?.promotionPoints ?? null,
      wheelPoints: standing?.wheelPoints ?? null,
      qualifyingDepositCents: standing?.qualifyingDepositCents ?? null,
      successfulReferralCount: standing?.successfulReferralCount ?? null,
      lastEventAt: standing?.lastEventAt?.toISOString() ?? null,
      lastEventReason: standing?.lastEventReason ?? null,
      wheel
    };
  }

  public async listStandings(
    user: RequestUser,
    query: LeaderboardStandingsQuery
  ): Promise<LeaderboardStandingsPageDto> {
    const workspaceId = this.requireWorkspaceId(user);
    const owner = await this.resolveBoardOwner(user);

    const settings = await this.domain.ensureSettings(workspaceId, owner, user.id);
    const now = new Date();
    const competition = settings.enabled
      ? await this.domain.ensureCurrentCompetition(workspaceId, owner, now)
      : await this.findActiveCompetition(workspaceId, owner, now);

    if (!competition) {
      throw new AppError(404, "COMPETITION_NOT_FOUND", "No active leaderboard competition was found.");
    }

    const ranked = await this.loadRankedStandings(competition.id, owner, workspaceId);
    const caps = customerPrivacyCapabilities(user.role as Role);
    let filtered = applyStandingFilterRows(ranked, query.filter);

    if (query.q?.trim()) {
      const needle = query.q.trim().toLowerCase();
      filtered = filtered.filter((row) => row.displayName.toLowerCase().includes(needle));
    }

    const total = filtered.length;
    const start = (query.page - 1) * query.pageSize;
    const pageRows = filtered.slice(start, start + query.pageSize);

    const rows: LeaderboardStandingRowDto[] = pageRows.map((row) => {
      const gaps = computeStandingGaps(ranked, row.crmContactId);
      return {
        rank: row.rank,
        crmContactId: row.crmContactId,
        displayName: row.displayName,
        telegramUsername: caps.canViewTelegramUsername ? row.telegramUsername : null,
        totalPoints: row.totalPoints,
        depositPoints: row.depositPoints,
        referralPoints: row.referralPoints,
        promotionPoints: row.promotionPoints,
        wheelPoints: row.wheelPoints,
        qualifyingDepositCents: row.qualifyingDepositCents,
        successfulReferralCount: row.successfulReferralCount,
        lastEventAt: row.lastEventAt?.toISOString() ?? null,
        lastEventReason: row.lastEventReason,
        gapToNextRankPoints: gaps?.gapToNextRankPoints ?? null,
        gapToTop3Points: gaps?.gapToTop3Points ?? null
      };
    });

    return {
      competition: this.toCompetitionSummary(competition),
      filter: query.filter,
      page: query.page,
      pageSize: query.pageSize,
      total,
      rows
    };
  }

  public async searchPlayers(
    user: RequestUser,
    q: string,
    excludeContactId?: string,
    limit = 25
  ): Promise<readonly LeaderboardPlayerSearchHitDto[]> {
    const workspaceId = this.requireWorkspaceId(user);
    const owner = await this.resolveBoardOwner(user);
    const caps = customerPrivacyCapabilities(user.role as Role);
    const needle = normalizePlayerSearchQuery(q);
    const take = Math.max(1, Math.min(limit, 50));

    // Pull owner-scoped PRIVATE participants; rank/filter in memory so username,
    // chat names, and combined first+last are searchable with 1-char contains.
    const participants = await this.app.prisma.leaderboardParticipant.findMany({
      where: {
        workspaceId,
        ownerCoadminUserId: owner,
        ...(excludeContactId ? { crmContactId: { not: excludeContactId } } : {}),
        crmContact: {
          kind: "PRIVATE",
          ...(needle
            ? {
                OR: [
                  { displayName: { contains: needle, mode: "insensitive" } },
                  { username: { contains: needle, mode: "insensitive" } },
                  {
                    chats: {
                      some: {
                        OR: [
                          { firstName: { contains: needle, mode: "insensitive" } },
                          { lastName: { contains: needle, mode: "insensitive" } },
                          { username: { contains: needle, mode: "insensitive" } }
                        ]
                      }
                    }
                  }
                ]
              }
            : {})
        }
      },
      // Over-fetch slightly so ranking can prefer exact/startsWith before slice.
      take: Math.min(200, Math.max(take * 4, 40)),
      orderBy: { crmContact: { displayName: "asc" } },
      include: {
        crmContact: {
          select: {
            id: true,
            displayName: true,
            username: true,
            chats: {
              select: { firstName: true, lastName: true, username: true },
              orderBy: { updatedAt: "desc" },
              take: 3
            }
          }
        }
      }
    });

    const sources = participants.map((row) => ({
      crmContactId: row.crmContact.id,
      displayName: row.crmContact.displayName,
      username: row.crmContact.username,
      chatFirstNames: row.crmContact.chats
        .map((c) => c.firstName)
        .filter((v): v is string => Boolean(v)),
      chatLastNames: row.crmContact.chats
        .map((c) => c.lastName)
        .filter((v): v is string => Boolean(v)),
      chatUsernames: row.crmContact.chats
        .map((c) => c.username)
        .filter((v): v is string => Boolean(v))
    }));

    // Combined first+last may match only after in-memory filter when DB OR missed it.
    const matched = needle
      ? sources.filter((row) => playerMatchesSearchQuery(row, needle))
      : sources;

    const ranked = selectPlayerSearchHits(matched, needle, take);

    return ranked.map((row) => ({
      crmContactId: row.crmContactId,
      displayName: row.displayName,
      telegramUsername: caps.canViewTelegramUsername ? row.username : null,
      shortId: row.crmContactId.slice(0, 8)
    }));
  }

  /**
   * Binds a contact to the Coadmin's board.
   * Creates settings if missing (enabled stays false). Never auto-enables.
   */
  public async bindParticipant(user: RequestUser, crmContactId: string) {
    if (user.role !== "COADMIN") {
      throw forbidden("Only coadmins can connect players to a leaderboard.");
    }
    const workspaceId = this.requireWorkspaceId(user);
    const owner = user.id;
    await this.domain.ensureSettings(workspaceId, owner, user.id);

    const row = await this.domain.bindParticipant({
      workspaceId,
      ownerCoadminUserId: owner,
      crmContactId,
      createdByUserId: user.id
    });
    return { crmContactId: row.crmContactId, ownerCoadminUserId: row.ownerCoadminUserId };
  }

  /**
   * Coadmin CRM hook: try deterministic auto-bind for a contact (never transfers).
   */
  public async ensureAutoBindForContact(user: RequestUser, crmContactId: string) {
    this.assertCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);
    const result = await tryAutoBindParticipant(this.app.prisma, {
      workspaceId,
      crmContactId,
      ownerCoadminUserId: user.id,
      source: "CRM",
      actorUserId: user.id
    }, this.domain);
    return {
      crmContactId,
      status: result.status,
      ownerCoadminUserId: "ownerCoadminUserId" in result ? result.ownerCoadminUserId : user.id,
      ...(result.status === "SKIPPED" || result.status === "FAILED"
        ? { reason: result.reason }
        : {}),
      ...(result.status === "TRANSFER_REJECTED"
        ? { existingOwnerId: result.existingOwnerId }
        : {})
    };
  }

  /**
   * Coadmin-only backfill for sole-owner workspaces (dryRun supported).
   */
  public async backfillParticipants(user: RequestUser, dryRun: boolean) {
    this.assertCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);
    const deterministic = await resolveDeterministicLeaderboardOwner(this.app.prisma, workspaceId);
    if (deterministic != null && deterministic !== user.id) {
      throw forbidden("Backfill is only available when you are the sole ACTIVE coadmin.");
    }
    return backfillLeaderboardParticipants(
      this.app.prisma,
      {
        workspaceId,
        ownerCoadminUserId: user.id,
        dryRun,
        actorUserId: user.id
      },
      this.domain
    );
  }

  public async recordDeposit(
    user: RequestUser,
    body: {
      crmContactId: string;
      amountCents: number;
      idempotencyKey: string;
      reason?: string | undefined;
    }
  ): Promise<LeaderboardDepositResultDto> {
    const workspaceId = this.requireWorkspaceId(user);
    let owner: string;
    try {
      owner = await this.domain.resolveLeaderboardOwner(workspaceId, body.crmContactId);
    } catch (error) {
      if (
        error instanceof LeaderboardError &&
        error.code === "PARTICIPANT_NOT_BOUND" &&
        user.role === "COADMIN"
      ) {
        const auto = await tryAutoBindForActingCoadmin(this.app.prisma, {
          workspaceId,
          crmContactId: body.crmContactId,
          actingCoadminUserId: user.id
        });
        if (auto.status !== "BOUND" && auto.status !== "ALREADY_BOUND") {
          throw error;
        }
        owner = user.id;
      } else {
        throw error;
      }
    }
    await this.assertActorMayMutatePlayer(user, owner);

    const previousRank = await this.rankForContact(workspaceId, owner, body.crmContactId);

    const event = await this.domain.recordDeposit({
      workspaceId,
      crmContactId: body.crmContactId,
      amountCents: body.amountCents,
      actorUserId: user.id,
      idempotencyKey: body.idempotencyKey,
      ...(body.reason !== undefined ? { reason: body.reason } : {})
    });

    const competition = await this.app.prisma.leaderboardCompetition.findUniqueOrThrow({
      where: { id: event.competitionId }
    });
    const ranked = await this.loadRankedStandings(competition.id, owner, workspaceId);
    const standing = ranked.find((row) => row.crmContactId === body.crmContactId);
    if (!standing) {
      throw new AppError(500, "STANDING_MISSING", "Standing was not found after deposit.");
    }

    await this.projectAfterMutation(workspaceId, owner, competition.id);
    await this.enqueueRecentReferralMilestoneDms(workspaceId, owner, competition.id);
    await this.safeRecomputeWheelQualification({
      workspaceId,
      ownerCoadminUserId: owner,
      competitionId: competition.id,
      crmContactId: body.crmContactId
    });

    return {
      amountCents: body.amountCents,
      pointsAdded: event.pointsDelta,
      totalPoints: standing.totalPoints,
      depositPoints: standing.depositPoints,
      qualifyingDepositCents: standing.qualifyingDepositCents,
      prizePoolCents: competition.prizePoolCents,
      previousRank,
      newRank: standing.rank,
      competitionEndsAt: competition.endsAt.toISOString()
    };
  }

  public async setReferral(
    user: RequestUser,
    body: {
      referrerCrmContactId: string;
      referredCrmContactId: string;
      idempotencyKey: string;
    }
  ): Promise<LeaderboardReferralResultDto> {
    const workspaceId = this.requireWorkspaceId(user);
    const owner = await this.domain.resolveLeaderboardOwner(workspaceId, body.referredCrmContactId);
    await this.assertActorMayMutatePlayer(user, owner);
    const referrerOwner = await this.domain.resolveLeaderboardOwner(
      workspaceId,
      body.referrerCrmContactId
    );
    await this.assertActorMayMutatePlayer(user, referrerOwner);

    await this.domain.setReferral({
      workspaceId,
      referrerCrmContactId: body.referrerCrmContactId,
      referredCrmContactId: body.referredCrmContactId,
      actorUserId: user.id,
      idempotencyKey: body.idempotencyKey
    });

    await this.projectStandingsForOwner(workspaceId, owner);
    const competition = await this.findActiveCompetition(workspaceId, owner, new Date());
    if (competition) {
      await this.enqueueRecentReferralMilestoneDms(workspaceId, owner, competition.id);
    }

    return {
      referrerCrmContactId: body.referrerCrmContactId,
      referredCrmContactId: body.referredCrmContactId,
      linked: true
    };
  }

  public async recordPromotion(
    user: RequestUser,
    body: { crmContactId: string; idempotencyKey: string; reason?: string | undefined }
  ): Promise<LeaderboardPromotionResultDto> {
    const workspaceId = this.requireWorkspaceId(user);
    let owner: string;
    try {
      owner = await this.domain.resolveLeaderboardOwner(workspaceId, body.crmContactId);
    } catch (error) {
      if (
        error instanceof LeaderboardError &&
        error.code === "PARTICIPANT_NOT_BOUND" &&
        user.role === "COADMIN"
      ) {
        const auto = await tryAutoBindForActingCoadmin(this.app.prisma, {
          workspaceId,
          crmContactId: body.crmContactId,
          actingCoadminUserId: user.id
        });
        if (auto.status !== "BOUND" && auto.status !== "ALREADY_BOUND") {
          throw error;
        }
        owner = user.id;
      } else {
        throw error;
      }
    }
    await this.assertActorMayMutatePlayer(user, owner);

    const previousRank = await this.rankForContact(workspaceId, owner, body.crmContactId);

    const event = await this.domain.recordPromotion({
      workspaceId,
      crmContactId: body.crmContactId,
      actorUserId: user.id,
      idempotencyKey: body.idempotencyKey,
      ...(body.reason !== undefined ? { reason: body.reason } : {})
    });

    const competition = await this.app.prisma.leaderboardCompetition.findUniqueOrThrow({
      where: { id: event.competitionId }
    });
    const ranked = await this.loadRankedStandings(competition.id, owner, workspaceId);
    const standing = ranked.find((row) => row.crmContactId === body.crmContactId);
    if (!standing) {
      throw new AppError(500, "STANDING_MISSING", "Standing was not found after promotion.");
    }

    await this.projectAfterMutation(workspaceId, owner, competition.id);

    return {
      pointsAwarded: event.pointsDelta,
      totalPoints: standing.totalPoints,
      previousRank,
      newRank: standing.rank,
      competitionEndsAt: competition.endsAt.toISOString()
    };
  }

  public async giveInfo(
    user: RequestUser,
    body: { crmContactId: string; chatId: string; idempotencyKey: string }
  ): Promise<LeaderboardGiveInfoResultDto> {
    const workspaceId = this.requireWorkspaceId(user);
    const owner = await this.domain.resolveLeaderboardOwner(workspaceId, body.crmContactId);
    await this.assertActorMayMutatePlayer(user, owner);

    const chat = await this.app.prisma.telegramChat.findFirst({
      where: { id: body.chatId, workspaceId },
      select: { id: true, crmContactId: true }
    });
    if (!chat) {
      throw new AppError(404, "CHAT_NOT_FOUND", "Chat was not found in this workspace.");
    }
    if (chat.crmContactId !== body.crmContactId) {
      throw new AppError(
        400,
        "CHAT_CONTACT_MISMATCH",
        "This chat does not belong to the selected leaderboard player."
      );
    }

    const settings = await this.domain.ensureSettings(workspaceId, owner, user.id);
    const now = new Date();
    const competition = settings.enabled
      ? await this.domain.ensureCurrentCompetition(workspaceId, owner, now)
      : await this.findActiveCompetition(workspaceId, owner, now);
    if (!competition) {
      throw new AppError(404, "COMPETITION_NOT_FOUND", "No active leaderboard competition was found.");
    }

    let ranked = await this.loadRankedStandings(competition.id, owner, workspaceId);
    let standing = ranked.find((row) => row.crmContactId === body.crmContactId);
    if (!standing) {
      const contact = await this.app.prisma.crmContact.findFirst({
        where: { id: body.crmContactId, workspaceId },
        select: { displayName: true, username: true }
      });
      if (!contact) {
        throw new AppError(404, "CONTACT_NOT_FOUND", "CrmContact was not found in this workspace.");
      }
      const virtual: RankedStanding = {
        rank: ranked.length + 1,
        crmContactId: body.crmContactId,
        displayName: contact.displayName,
        telegramUsername: contact.username,
        totalPoints: 0,
        depositPoints: 0,
        referralPoints: 0,
        promotionPoints: 0,
        wheelPoints: 0,
        qualifyingDepositCents: 0,
        successfulReferralCount: 0,
        lastEventAt: null,
        lastEventReason: null,
        pointsReachedAt: now
      };
      ranked = [...ranked, virtual];
      standing = virtual;
    }

    const gaps = computeStandingGaps(ranked, body.crmContactId);
    const messageText = buildGiveInfoMessage({
      rank: standing.rank,
      totalPoints: standing.totalPoints,
      pointsAbove: gaps?.pointsAbove ?? null,
      pointsToTop10: gaps?.pointsToTop10 ?? null,
      pointsToTop3: gaps?.pointsToTop3 ?? null,
      prizePoolCents: competition.prizePoolCents,
      competitionEndsAt: competition.endsAt,
      isFirst: gaps?.isFirst ?? standing.rank === 1
    });

    const telegram = new TelegramService(this.app);
    const sendResult = await telegram.sendTextByChatId(user, body.chatId, {
      text: messageText,
      idempotencyKey: body.idempotencyKey
    });

    await this.audit.record({
      workspaceId,
      actorId: user.id,
      action: "leaderboard.give_info",
      metadata: {
        crmContactId: body.crmContactId,
        chatId: body.chatId,
        competitionId: competition.id,
        rank: standing.rank,
        idempotencyKey: body.idempotencyKey
      }
    });

    return {
      chatId: body.chatId,
      messageText,
      sendStatusCode: sendResult.statusCode
    };
  }

  // --- Phase 3 Coadmin admin surface (owner always authenticated coadmin) ---

  public async getSettings(user: RequestUser): Promise<LeaderboardSettingsWithHistoryDto> {
    this.assertCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);
    const owner = user.id;
    const settings = await this.domain.ensureSettings(workspaceId, owner, user.id);
    const history = await this.getPoolRateHistory(user);
    return {
      ...this.toSettingsDto(settings),
      history
    };
  }

  public async setEnabled(
    user: RequestUser,
    enabled: boolean,
    confirmDisable?: boolean
  ): Promise<LeaderboardSettingsDto> {
    this.assertCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);
    const owner = user.id;

    if (!enabled) {
      const active = await this.findActiveCompetition(workspaceId, owner, new Date());
      if (active && confirmDisable !== true) {
        throw new AppError(
          400,
          "CONFIRM_DISABLE_REQUIRED",
          "Disabling while an ACTIVE competition exists requires confirmDisable=true."
        );
      }
    }

    const updated = await this.domain.setEnabled(workspaceId, owner, enabled, user.id);
    await this.projectStandingsForOwner(workspaceId, owner);
    return this.toSettingsDto(updated);
  }

  public async setPoolRate(
    user: RequestUser,
    poolRateBps: 200 | 300 | 400 | 500,
    reason?: string
  ): Promise<LeaderboardSettingsDto> {
    this.assertCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);
    const updated = await this.domain.setPoolRate({
      workspaceId,
      ownerCoadminUserId: user.id,
      poolRateBps,
      actorUserId: user.id,
      ...(reason !== undefined ? { reason } : {})
    });
    await this.projectStandingsForOwner(workspaceId, user.id);
    return this.toSettingsDto(updated);
  }

  public async getPoolRateHistory(user: RequestUser): Promise<readonly LeaderboardPoolRateHistoryDto[]> {
    this.assertCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);
    const rows = await this.app.prisma.poolRateHistory.findMany({
      where: { workspaceId, ownerCoadminUserId: user.id },
      orderBy: { effectiveFrom: "desc" }
    });
    return rows.map((row) => ({
      id: row.id,
      rateBps: row.rateBps,
      effectiveFrom: row.effectiveFrom.toISOString(),
      changedByUserId: row.changedByUserId,
      reason: row.reason
    }));
  }

  public async getAdminCompetition(user: RequestUser): Promise<LeaderboardAdminCompetitionDto | null> {
    this.assertCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);
    const owner = user.id;
    const settings = await this.domain.ensureSettings(workspaceId, owner, user.id);
    const now = new Date();

    let competition = settings.enabled
      ? await this.domain.ensureCurrentCompetition(workspaceId, owner, now)
      : await this.findActiveCompetition(workspaceId, owner, now);

    if (!competition) {
      competition = await this.app.prisma.leaderboardCompetition.findFirst({
        where: { workspaceId, ownerCoadminUserId: owner, status: { in: ["FROZEN", "FINALIZED"] } },
        orderBy: { endsAt: "desc" }
      });
    }
    if (!competition) return null;
    return this.toAdminCompetitionDto(competition, owner, workspaceId);
  }

  public async listEvents(
    user: RequestUser,
    query: LeaderboardEventsQuery
  ): Promise<LeaderboardEventsPageDto> {
    this.assertCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);
    const owner = user.id;

    const where = {
      workspaceId,
      ownerCoadminUserId: owner,
      ...(query.type ? { type: query.type as never } : {}),
      ...(query.crmContactId ? { crmContactId: query.crmContactId } : {})
    };

    const [total, events] = await Promise.all([
      this.app.prisma.leaderboardEvent.count({ where }),
      this.app.prisma.leaderboardEvent.findMany({
        where,
        orderBy: { occurredAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          crmContact: { select: { displayName: true } },
          reversedByEvent: { select: { id: true } }
        }
      })
    ]);

    const rows: LeaderboardEventRowDto[] = events.map((event) => ({
      id: event.id,
      occurredAt: event.occurredAt.toISOString(),
      crmContactId: event.crmContactId,
      displayName: event.crmContact.displayName,
      type: event.type,
      pointsDelta: event.pointsDelta,
      depositAmountCents: event.depositAmountCents,
      poolContributionCents: event.poolContributionCents,
      poolRateBpsApplied: event.poolRateBpsApplied,
      actorUserId: event.actorUserId,
      reason: event.reason,
      reversesEventId: event.reversesEventId,
      reversed: event.reversedByEvent != null
    }));

    return {
      page: query.page,
      pageSize: query.pageSize,
      total,
      rows
    };
  }

  public async reverseEvent(
    user: RequestUser,
    eventId: string,
    reason: string,
    idempotencyKey: string
  ) {
    this.assertCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);
    if (!reason.trim()) throw missingReason();

    const event = await this.app.prisma.leaderboardEvent.findFirst({
      where: { id: eventId, workspaceId }
    });
    if (!event) throw eventNotFound();
    if (event.ownerCoadminUserId !== user.id) throw ownerMismatch();

    const alreadyReversed = await this.app.prisma.leaderboardEvent.findFirst({
      where: { reversesEventId: event.id }
    });
    if (alreadyReversed) throw eventAlreadyReversed();

    if (event.type === "DEPOSIT") {
      const reversed = await this.domain.reverseDeposit({
        workspaceId,
        depositEventId: event.id,
        actorUserId: user.id,
        idempotencyKey,
        reason
      });
      await this.projectAfterMutation(workspaceId, user.id, event.competitionId);
      await this.safeRecomputeWheelQualification({
        workspaceId,
        ownerCoadminUserId: user.id,
        competitionId: event.competitionId,
        crmContactId: event.crmContactId
      });
      return reversed;
    }
    if (event.type === "PROMOTION") {
      const reversed = await this.domain.reversePromotion({
        workspaceId,
        promotionEventId: event.id,
        actorUserId: user.id,
        idempotencyKey,
        reason
      });
      await this.projectAfterMutation(workspaceId, user.id, event.competitionId);
      return reversed;
    }
    throw eventNotReversible(event.type);
  }

  public async listReferrals(user: RequestUser): Promise<readonly LeaderboardReferralAdminRowDto[]> {
    this.assertCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);
    const owner = user.id;

    const referrals = await this.app.prisma.leaderboardReferral.findMany({
      where: { workspaceId, ownerCoadminUserId: owner },
      orderBy: { createdAt: "desc" },
      include: {
        referrer: { select: { displayName: true } },
        referred: { select: { displayName: true } },
        milestoneAwards: {
          where: { status: "ACTIVE" },
          orderBy: { awardedAt: "asc" }
        }
      }
    });

    const stats = await this.app.prisma.leaderboardPlayerStats.findMany({
      where: {
        workspaceId,
        ownerCoadminUserId: owner,
        crmContactId: { in: referrals.map((r) => r.referredCrmContactId) }
      }
    });
    const lifetimeByContact = new Map(
      stats.map((s) => [s.crmContactId, s.lifetimeQualifyingDepositCents] as const)
    );

    return referrals.map((row) => ({
      id: row.id,
      referrerCrmContactId: row.referrerCrmContactId,
      referrerDisplayName: row.referrer.displayName,
      referredCrmContactId: row.referredCrmContactId,
      referredDisplayName: row.referred.displayName,
      createdAt: row.createdAt.toISOString(),
      lifetimeQualifyingDepositCents: lifetimeByContact.get(row.referredCrmContactId) ?? 0,
      milestones: row.milestoneAwards.map((m) => ({
        code: m.milestoneCode,
        points: m.points,
        status: m.status,
        awardedAt: m.awardedAt.toISOString()
      })),
      overriddenAt: row.overriddenAt?.toISOString() ?? null,
      overrideReason: row.overrideReason
    }));
  }

  public async overrideReferral(
    user: RequestUser,
    referralId: string,
    newReferrerCrmContactId: string,
    reason: string,
    idempotencyKey: string
  ) {
    this.assertCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);
    if (!reason.trim()) throw missingReason();

    const referral = await this.app.prisma.leaderboardReferral.findFirst({
      where: { id: referralId, workspaceId }
    });
    if (!referral) throw referralNotFound();
    if (referral.ownerCoadminUserId !== user.id) throw ownerMismatch();

    const updated = await this.domain.overrideReferral({
      workspaceId,
      referredCrmContactId: referral.referredCrmContactId,
      newReferrerCrmContactId,
      actorUserId: user.id,
      reason,
      idempotencyKey
    });
    await this.projectStandingsForOwner(workspaceId, user.id);
    return updated;
  }

  public async getCompetitionReview(
    user: RequestUser,
    competitionId: string
  ): Promise<LeaderboardCompetitionReviewDto> {
    this.assertCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);
    const owner = user.id;

    const competition = await this.app.prisma.leaderboardCompetition.findFirst({
      where: { id: competitionId, workspaceId, ownerCoadminUserId: owner }
    });
    if (!competition) {
      throw new AppError(404, "COMPETITION_NOT_FOUND", "Competition was not found.");
    }

    const snapshot = await this.app.prisma.competitionSnapshot.findUnique({
      where: { competitionId }
    });
    const adminCompetition = await this.toAdminCompetitionDto(competition, owner, workspaceId);

    const ranked = await this.loadRankedStandings(competition.id, owner, workspaceId);
    const top10FromSnapshot = Array.isArray(snapshot?.top10Json)
      ? (snapshot!.top10Json as Array<{ crmContactId: string; rank: number }>)
      : ranked.filter((r) => r.rank <= 10).map((r) => ({ crmContactId: r.crmContactId, rank: r.rank }));

    const leaderboardTop10: LeaderboardStandingRowDto[] = top10FromSnapshot.map((entry) => {
      const row = ranked.find((r) => r.crmContactId === entry.crmContactId);
      const gaps = row ? computeStandingGaps(ranked, row.crmContactId) : null;
      return {
        rank: entry.rank,
        crmContactId: entry.crmContactId,
        displayName: row?.displayName ?? entry.crmContactId.slice(0, 8),
        telegramUsername: row?.telegramUsername ?? null,
        totalPoints: row?.totalPoints ?? 0,
        depositPoints: row?.depositPoints ?? 0,
        referralPoints: row?.referralPoints ?? 0,
        promotionPoints: row?.promotionPoints ?? 0,
        wheelPoints: row?.wheelPoints ?? 0,
        qualifyingDepositCents: row?.qualifyingDepositCents ?? 0,
        successfulReferralCount: row?.successfulReferralCount ?? 0,
        lastEventAt: row?.lastEventAt?.toISOString() ?? null,
        lastEventReason: row?.lastEventReason ?? null,
        gapToNextRankPoints: gaps?.gapToNextRankPoints ?? null,
        gapToTop3Points: gaps?.gapToTop3Points ?? null
      };
    });

    const candidates = await this.app.prisma.giveawayEligibilityCandidate.findMany({
      where: { competitionId, ownerCoadminUserId: owner },
      orderBy: { leaderboardRank: "asc" },
      include: { crmContact: { select: { displayName: true } } }
    });

    const selection = selectPrizeWinnersFromEligibility(candidates);
    const prizeRankByContact = new Map<string, number>();
    if (selection.ok) {
      for (const winner of selection.winners) {
        prizeRankByContact.set(winner.crmContactId, winner.prizeRank);
      }
    }

    const eligibilityCandidates: LeaderboardEligibilityCandidateDto[] = candidates.map((c) => ({
      crmContactId: c.crmContactId,
      displayName: c.crmContact.displayName,
      leaderboardRank: c.leaderboardRank,
      totalPoints: c.totalPoints,
      membershipStatus: c.membershipStatus,
      ineligibilityReason: c.ineligibilityReason,
      prizeRank: prizeRankByContact.get(c.crmContactId) ?? null,
      verificationSource: c.verificationSource,
      telegramChatMemberStatus: c.telegramChatMemberStatus,
      verificationCheckedAt: c.verificationCheckedAt?.toISOString() ?? null,
      verificationErrorCode: c.verificationErrorCode
    }));

    const prizeWinnersPreview = eligibilityCandidates.filter((c) => c.prizeRank != null);

    let canFinalize = competition.status === "FROZEN";
    let finalizeBlockReason: string | null = null;
    if (competition.status !== "FROZEN") {
      canFinalize = false;
      finalizeBlockReason = `Competition status is ${competition.status}; only FROZEN competitions can be finalized.`;
    } else if (!selection.ok) {
      canFinalize = false;
      finalizeBlockReason = `Pending membership review blocks prize selection for: ${selection.pendingCrmContactIds.join(", ")}`;
    }

    return {
      competition: adminCompetition,
      frozenAt: competition.frozenAt?.toISOString() ?? snapshot?.frozenAt.toISOString() ?? null,
      prizePoolCents: snapshot?.prizePoolCents ?? competition.prizePoolCents,
      leaderboardTop10,
      eligibilityCandidates,
      prizeWinnersPreview,
      canFinalize,
      finalizeBlockReason,
      winnersLocked: snapshot?.winnersJson != null
    };
  }

  public async setEligibility(
    user: RequestUser,
    competitionId: string,
    crmContactId: string,
    body: {
      membershipStatus: "ELIGIBLE" | "NOT_ELIGIBLE" | "PENDING_REVIEW";
      reason?: string | undefined;
      ineligibilityReason?: string | undefined;
      idempotencyKey: string;
      explicitOverride?: boolean | undefined;
    }
  ) {
    this.assertCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);
    return this.domain.setMembershipEligibility({
      workspaceId,
      ownerCoadminUserId: user.id,
      competitionId,
      crmContactId,
      membershipStatus: body.membershipStatus,
      actorUserId: user.id,
      idempotencyKey: body.idempotencyKey,
      verificationSource: "MANUAL",
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
      ...(body.ineligibilityReason !== undefined
        ? { ineligibilityReason: body.ineligibilityReason }
        : {}),
      ...(body.explicitOverride !== undefined ? { explicitOverride: body.explicitOverride } : {})
    });
  }

  public async finalize(user: RequestUser, competitionId: string, idempotencyKey: string, confirm: true) {
    this.assertCoadmin(user);
    if (confirm !== true) {
      throw new AppError(400, "CONFIRM_REQUIRED", "Finalization requires confirm=true.");
    }
    const workspaceId = this.requireWorkspaceId(user);
    const finalized = await this.domain.finalizeCompetition({
      workspaceId,
      ownerCoadminUserId: user.id,
      competitionId,
      actorUserId: user.id,
      idempotencyKey
    });
    try {
      await this.outbox?.enqueuePostResults(workspaceId, user.id, competitionId);
      await this.outbox?.enqueueRefresh(workspaceId, user.id, competitionId);
      await this.enqueueFinalResultDms(workspaceId, user.id, competitionId);
    } catch {
      // ignore projection errors
    }
    return finalized;
  }

  public async registerTelegramWebhook(user: RequestUser): Promise<LeaderboardTelegramIntegrationDto> {
    this.assertCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);
    return this.requireTelegramIntegration().registerWebhook(workspaceId, user.id, user.id);
  }

  public async getTelegramIntegration(user: RequestUser): Promise<LeaderboardTelegramIntegrationDto> {
    this.assertCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);
    return this.requireTelegramIntegration().getIntegration(workspaceId, user.id);
  }

  public async connectTelegramBot(
    user: RequestUser,
    token: string
  ): Promise<LeaderboardTelegramIntegrationDto> {
    this.assertCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);
    return this.requireTelegramIntegration().connect(workspaceId, user.id, token, user.id);
  }

  public async testTelegramConnection(user: RequestUser): Promise<LeaderboardTelegramIntegrationDto> {
    this.assertCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);
    return this.requireTelegramIntegration().testConnection(workspaceId, user.id);
  }

  public async rotateTelegramToken(
    user: RequestUser,
    token: string
  ): Promise<LeaderboardTelegramIntegrationDto> {
    this.assertCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);
    return this.requireTelegramIntegration().rotateToken(workspaceId, user.id, token, user.id);
  }

  public async setTelegramChannel(
    user: RequestUser,
    channelRef: string
  ): Promise<LeaderboardTelegramIntegrationDto> {
    this.assertCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);
    return this.requireTelegramIntegration().setChannel(workspaceId, user.id, channelRef, user.id);
  }

  public async verifyTelegramChannel(user: RequestUser): Promise<LeaderboardTelegramIntegrationDto> {
    this.assertCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);
    return this.requireTelegramIntegration().verifyChannel(workspaceId, user.id, user.id);
  }

  public async setTelegramPosting(
    user: RequestUser,
    postingEnabled: boolean
  ): Promise<LeaderboardTelegramIntegrationDto> {
    this.assertCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);
    return this.requireTelegramIntegration().setPostingEnabled(
      workspaceId,
      user.id,
      postingEnabled,
      user.id
    );
  }

  public async sendLatestTelegramLeaderboard(user: RequestUser) {
    this.assertCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);
    return this.requireTelegramIntegration().sendLatestLeaderboard(workspaceId, user.id, user.id);
  }

  public async disconnectTelegram(user: RequestUser, confirm: true) {
    this.assertCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);
    return this.requireTelegramIntegration().disconnect(workspaceId, user.id, user.id, confirm);
  }

  public async enqueueVerifyMembership(user: RequestUser, competitionId: string) {
    this.assertCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);
    const competition = await this.app.prisma.leaderboardCompetition.findFirst({
      where: { id: competitionId, workspaceId, ownerCoadminUserId: user.id }
    });
    if (!competition) {
      throw new AppError(404, "COMPETITION_NOT_FOUND", "Competition was not found.");
    }
    if (competition.status !== "FROZEN") {
      throw new AppError(409, "COMPETITION_NOT_FROZEN", "Only FROZEN competitions can verify membership.");
    }
    const jobId = await this.requireOutbox().enqueueVerifyMembership(workspaceId, user.id, competitionId);
    return { queued: true, jobId, competitionId };
  }

  private requireTelegramIntegration(): LeaderboardTelegramIntegrationService {
    if (!this.telegramIntegration) {
      throw new AppError(503, "TELEGRAM_INTEGRATION_UNAVAILABLE", "Leaderboard Telegram plugin is not loaded.");
    }
    return this.telegramIntegration;
  }

  private requireOutbox(): LeaderboardTelegramOutboxService {
    if (!this.outbox) {
      throw new AppError(503, "TELEGRAM_OUTBOX_UNAVAILABLE", "Leaderboard Telegram outbox is not loaded.");
    }
    return this.outbox;
  }

  public async listPayouts(
    user: RequestUser,
    competitionId?: string
  ): Promise<readonly LeaderboardPayoutDto[]> {
    this.assertCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);
    const payouts = await this.app.prisma.giveawayPayout.findMany({
      where: {
        workspaceId,
        ownerCoadminUserId: user.id,
        ...(competitionId ? { competitionId } : {})
      },
      orderBy: [{ competitionId: "desc" }, { prizeRank: "asc" }],
      include: { crmContact: { select: { displayName: true } } }
    });

    return payouts.map((p) => ({
      id: p.id,
      competitionId: p.competitionId,
      prizeRank: p.prizeRank,
      leaderboardRank: p.leaderboardRank,
      crmContactId: p.crmContactId,
      displayName: p.crmContact.displayName,
      points: p.points,
      payoutCents: p.payoutCents,
      status: p.status,
      paidAt: p.paidAt?.toISOString() ?? null,
      paidByUserId: p.paidByUserId,
      notes: p.notes
    }));
  }

  public async markPayout(
    user: RequestUser,
    payoutId: string,
    status: "PAID" | "VOID",
    notes: string | undefined,
    confirm: true,
    idempotencyKey: string
  ): Promise<LeaderboardPayoutDto> {
    this.assertCoadmin(user);
    if (confirm !== true) {
      throw new AppError(400, "CONFIRM_REQUIRED", "Marking payout requires confirm=true.");
    }
    const workspaceId = this.requireWorkspaceId(user);
    const updated = await this.domain.markPayout({
      workspaceId,
      ownerCoadminUserId: user.id,
      payoutId,
      status,
      actorUserId: user.id,
      idempotencyKey,
      ...(notes !== undefined ? { notes } : {})
    });

    const contact = await this.app.prisma.crmContact.findFirst({
      where: { id: updated.crmContactId, workspaceId },
      select: { displayName: true }
    });

    return {
      id: updated.id,
      competitionId: updated.competitionId,
      prizeRank: updated.prizeRank,
      leaderboardRank: updated.leaderboardRank,
      crmContactId: updated.crmContactId,
      displayName: contact?.displayName ?? updated.crmContactId.slice(0, 8),
      points: updated.points,
      payoutCents: updated.payoutCents,
      status: updated.status,
      paidAt: updated.paidAt?.toISOString() ?? null,
      paidByUserId: updated.paidByUserId,
      notes: updated.notes
    };
  }

  /**
   * Binding and reads may create settings rows with enabled=false.
   * Activation is an explicit Coadmin Phase 3 settings action only.
   */
  private async findActiveCompetition(workspaceId: string, ownerCoadminUserId: string, now: Date) {
    return this.app.prisma.leaderboardCompetition.findFirst({
      where: {
        workspaceId,
        ownerCoadminUserId,
        status: "ACTIVE",
        startsAt: { lte: now },
        endsAt: { gt: now }
      }
    });
  }

  private async loadRankedStandings(
    competitionId: string,
    ownerCoadminUserId: string,
    workspaceId: string
  ): Promise<RankedStanding[]> {
    const rows = await this.app.prisma.leaderboardStanding.findMany({
      where: { competitionId, ownerCoadminUserId, workspaceId },
      include: {
        crmContact: { select: { displayName: true, username: true } }
      }
    });

    return withRanks(
      rows.map((row) => ({
        crmContactId: row.crmContactId,
        totalPoints: row.totalPoints,
        pointsReachedAt: row.pointsReachedAt,
        displayName: row.crmContact.displayName,
        telegramUsername: row.crmContact.username,
        depositPoints: row.depositPoints,
        referralPoints: row.referralPoints,
        promotionPoints: row.promotionPoints,
        wheelPoints: row.wheelPoints,
        qualifyingDepositCents: row.qualifyingDepositCents,
        successfulReferralCount: row.successfulReferralCount,
        lastEventAt: row.lastEventAt,
        lastEventReason: row.lastEventReason
      }))
    );
  }

  private async rankForContact(
    workspaceId: string,
    ownerCoadminUserId: string,
    crmContactId: string
  ): Promise<number | null> {
    const now = new Date();
    const competition = await this.findActiveCompetition(workspaceId, ownerCoadminUserId, now);
    if (!competition) return null;
    const ranked = await this.loadRankedStandings(competition.id, ownerCoadminUserId, workspaceId);
    return ranked.find((row) => row.crmContactId === crmContactId)?.rank ?? null;
  }

  private toCompetitionSummary(competition: {
    id: string;
    status: string;
    startsAt: Date;
    endsAt: Date;
    prizePoolCents: number;
  }): LeaderboardCompetitionSummaryDto {
    return {
      competitionId: competition.id,
      status: competition.status as LeaderboardCompetitionSummaryDto["status"],
      startsAt: competition.startsAt.toISOString(),
      endsAt: competition.endsAt.toISOString(),
      prizePoolCents: competition.prizePoolCents
    };
  }

  private toSettingsDto(settings: {
    enabled: boolean;
    poolRateBps: number;
    timezone: string;
    updatedAt: Date;
  }): LeaderboardSettingsDto {
    const rate = settings.poolRateBps as (typeof ALLOWED_POOL_RATE_BPS)[number];
    if (!(ALLOWED_POOL_RATE_BPS as readonly number[]).includes(rate)) {
      throw new AppError(500, "INVALID_POOL_RATE", "Stored pool rate is invalid.");
    }
    return {
      enabled: settings.enabled,
      poolRateBps: rate,
      timezone: settings.timezone,
      updatedAt: settings.updatedAt.toISOString()
    };
  }

  private async toAdminCompetitionDto(
    competition: {
      id: string;
      sequence: number;
      status: string;
      startsAt: Date;
      endsAt: Date;
      prizePoolCents: number;
    },
    ownerCoadminUserId: string,
    workspaceId: string
  ): Promise<LeaderboardAdminCompetitionDto> {
    const ranked = await this.loadRankedStandings(competition.id, ownerCoadminUserId, workspaceId);
    const standingsAgg = await this.app.prisma.leaderboardStanding.aggregate({
      where: { competitionId: competition.id, ownerCoadminUserId, workspaceId },
      _sum: { qualifyingDepositCents: true },
      _count: { _all: true }
    });

    const toRow = (row: RankedStanding): LeaderboardStandingRowDto => {
      const gaps = computeStandingGaps(ranked, row.crmContactId);
      return {
        rank: row.rank,
        crmContactId: row.crmContactId,
        displayName: row.displayName,
        telegramUsername: row.telegramUsername,
        totalPoints: row.totalPoints,
        depositPoints: row.depositPoints,
        referralPoints: row.referralPoints,
        promotionPoints: row.promotionPoints,
        wheelPoints: row.wheelPoints,
        qualifyingDepositCents: row.qualifyingDepositCents,
        successfulReferralCount: row.successfulReferralCount,
        lastEventAt: row.lastEventAt?.toISOString() ?? null,
        lastEventReason: row.lastEventReason,
        gapToNextRankPoints: gaps?.gapToNextRankPoints ?? null,
        gapToTop3Points: gaps?.gapToTop3Points ?? null
      };
    };

    return {
      competitionId: competition.id,
      sequence: competition.sequence,
      status: competition.status as LeaderboardAdminCompetitionDto["status"],
      startsAt: competition.startsAt.toISOString(),
      endsAt: competition.endsAt.toISOString(),
      prizePoolCents: competition.prizePoolCents,
      playerCount: standingsAgg._count._all,
      totalQualifyingDepositCents: standingsAgg._sum.qualifyingDepositCents ?? 0,
      top3: ranked.filter((r) => r.rank <= 3).map(toRow),
      top10: ranked.filter((r) => r.rank <= 10).map(toRow)
    };
  }

  private async enqueueRecentReferralMilestoneDms(
    workspaceId: string,
    ownerCoadminUserId: string,
    competitionId: string
  ): Promise<void> {
    if (!this.outbox) return;
    try {
      const since = new Date(Date.now() - 15_000);
      const events = await this.app.prisma.leaderboardEvent.findMany({
        where: {
          workspaceId,
          ownerCoadminUserId,
          competitionId,
          type: "REFERRAL_MILESTONE",
          occurredAt: { gte: since }
        },
        select: { crmContactId: true, pointsDelta: true }
      });
      for (const event of events) {
        const link = await this.app.prisma.leaderboardBotPlayerLink.findFirst({
          where: { ownerCoadminUserId, crmContactId: event.crmContactId },
          select: { id: true }
        });
        const decision = decidePlayerNotification({
          competitionId,
          crmContactId: event.crmContactId,
          kind: "REFERRAL_MILESTONE",
          hasPlayerLink: link != null,
          ownerCoadminUserId,
          botOwnerCoadminUserId: ownerCoadminUserId
        });
        if (!decision.shouldNotify) continue;
        await this.outbox.enqueuePlayerDm({
          workspaceId,
          ownerCoadminUserId,
          competitionId,
          crmContactId: event.crmContactId,
          kind: "REFERRAL_MILESTONE",
          totalPoints: event.pointsDelta,
          dedupeKey: `${decision.dedupeKey}:${event.pointsDelta}:${since.toISOString().slice(0, 13)}`
        });
      }
    } catch {
      // Personal DMs must never affect scoring.
    }
  }

  private async enqueueFinalResultDms(
    workspaceId: string,
    ownerCoadminUserId: string,
    competitionId: string
  ): Promise<void> {
    if (!this.outbox) return;
    const candidates = await this.app.prisma.giveawayEligibilityCandidate.findMany({
      where: { workspaceId, ownerCoadminUserId, competitionId },
      select: { crmContactId: true, membershipStatus: true }
    });
    const payouts = await this.app.prisma.giveawayPayout.findMany({
      where: { workspaceId, ownerCoadminUserId, competitionId },
      select: { crmContactId: true }
    });
    const payoutIds = new Set(payouts.map((p) => p.crmContactId));

    for (const candidate of candidates) {
      const isWinner = payoutIds.has(candidate.crmContactId);
      const kind = isWinner
        ? ("FINAL_RESULT_WINNER" as const)
        : candidate.membershipStatus === "NOT_ELIGIBLE"
          ? ("FINAL_RESULT_INELIGIBLE" as const)
          : ("FINAL_RESULT" as const);

      const link = await this.app.prisma.leaderboardBotPlayerLink.findFirst({
        where: { ownerCoadminUserId, crmContactId: candidate.crmContactId },
        select: { id: true }
      });
      const decision = decidePlayerNotification({
        competitionId,
        crmContactId: candidate.crmContactId,
        kind,
        hasPlayerLink: link != null,
        ownerCoadminUserId,
        botOwnerCoadminUserId: ownerCoadminUserId
      });
      if (!decision.shouldNotify) continue;

      await this.outbox.enqueueFinalResultDm({
        workspaceId,
        ownerCoadminUserId,
        competitionId,
        crmContactId: candidate.crmContactId,
        kind
      });
    }
  }

  public async getWheelStatus(
    user: RequestUser,
    crmContactId: string
  ): Promise<LeaderboardWheelStatusDto> {
    const workspaceId = this.requireWorkspaceId(user);
    const owner = await this.domain.resolveLeaderboardOwner(workspaceId, crmContactId);
    await this.assertActorMayMutatePlayer(user, owner);
    return this.wheel.getStatus(workspaceId, owner, crmContactId, new Date());
  }

  public async spinWheel(
    user: RequestUser,
    body: { crmContactId: string; idempotencyKey: string },
    rng?: WheelRng
  ): Promise<LeaderboardWheelSpinResultDto> {
    const workspaceId = this.requireWorkspaceId(user);
    const owner = await this.domain.resolveLeaderboardOwner(workspaceId, body.crmContactId);
    await this.assertActorMayMutatePlayer(user, owner);

    const result = await this.wheel.spin({
      workspaceId,
      crmContactId: body.crmContactId,
      idempotencyKey: body.idempotencyKey,
      actorUserId: user.id,
      rng: rng ?? createCryptoWheelRng()
    });

    await this.projectAfterMutation(workspaceId, result.ownerCoadminUserId, result.spin.competitionId);

    if (!result.replay) {
      try {
        const link = await this.app.prisma.leaderboardBotPlayerLink.findFirst({
          where: {
            ownerCoadminUserId: result.ownerCoadminUserId,
            crmContactId: body.crmContactId
          },
          select: { id: true }
        });
        if (link && this.outbox) {
          const text = formatPersonalAnnouncementDm({
            kind: "WHEEL_SPIN",
            fromRank: result.spin.previousRank,
            toRank: result.spin.resultingRank ?? result.spin.previousRank ?? 0,
            totalPoints: result.spin.pointsAwarded
          });
          await this.outbox.enqueuePlayerDm({
            workspaceId,
            ownerCoadminUserId: result.ownerCoadminUserId,
            competitionId: result.spin.competitionId,
            crmContactId: body.crmContactId,
            kind: "WHEEL_SPIN",
            fromRank: result.spin.previousRank,
            ...(result.spin.resultingRank != null
              ? { toRank: result.spin.resultingRank }
              : {}),
            totalPoints: result.standing.totalPoints,
            text,
            dedupeKey: `lb:pdm:${result.ownerCoadminUserId}:${result.spin.competitionId}:${body.crmContactId}:WHEEL_SPIN:${result.spin.id}`
          });
        }
      } catch {
        // DM enqueue must not fail spin response.
      }
    }

    const cycle = await this.app.prisma.leaderboardWheelCycle.findUnique({
      where: { id: result.spin.cycleId },
      select: { sequence: true }
    });

    return {
      pointsAwarded: result.spin.pointsAwarded,
      totalPoints: result.standing.totalPoints,
      wheelPoints: result.standing.wheelPoints,
      previousRank: result.spin.previousRank,
      resultingRank: result.spin.resultingRank,
      cycleSequence: cycle?.sequence ?? 0,
      replay: result.replay,
      spinId: result.spin.id
    };
  }

  public async getWheelSettings(user: RequestUser): Promise<LeaderboardWheelSettingsDto> {
    this.assertCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);
    const config = await this.wheel.ensureConfig(workspaceId, user.id);
    const versions = await this.app.prisma.leaderboardWheelConfigVersion.findMany({
      where: { ownerCoadminUserId: user.id, workspaceId },
      orderBy: { createdAt: "desc" }
    });
    const mapped: LeaderboardWheelConfigVersionDto[] = versions.map((v) => {
      const dist = Array.isArray(v.rewardDistributionJson)
        ? (v.rewardDistributionJson as Array<{ points: number; weight: number }>)
        : [];
      return {
        id: v.id,
        createdAt: v.createdAt.toISOString(),
        createdByUserId: v.createdByUserId,
        activatedAt: v.activatedAt?.toISOString() ?? null,
        distribution: dist,
        isActive: config.activeVersionId === v.id
      };
    });
    return {
      enabled: config.enabled,
      qualificationCreditPolicy: config.qualificationCreditPolicy,
      enabledAt: config.enabledAt?.toISOString() ?? null,
      activeVersionId: config.activeVersionId,
      needsConfiguration: config.activeVersionId == null,
      versions: mapped
    };
  }

  public async ensureApprovedWheelDistribution(
    user: RequestUser
  ): Promise<LeaderboardWheelSettingsDto> {
    this.assertCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);
    await this.wheel.ensureApprovedDistributionVersion({
      workspaceId,
      ownerCoadminUserId: user.id,
      createdByUserId: user.id
    });
    await this.audit.record({
      workspaceId,
      actorId: user.id,
      action: "leaderboard.wheel.ensure_approved_distribution",
      metadata: {}
    });
    return this.getWheelSettings(user);
  }

  public async patchWheelSettings(
    user: RequestUser,
    body: {
      enabled?: boolean;
      /** Ignored — Phase 6.1 locks CYCLE_DEPOSITS_ALL server-side. */
      qualificationCreditPolicy?: LeaderboardWheelQualificationCreditPolicy;
    }
  ): Promise<LeaderboardWheelSettingsDto> {
    this.assertCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);
    await this.wheel.patchSettings({
      workspaceId,
      ownerCoadminUserId: user.id,
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {})
    });
    await this.audit.record({
      workspaceId,
      actorId: user.id,
      action: "leaderboard.wheel.settings",
      metadata: { enabled: body.enabled }
    });
    return this.getWheelSettings(user);
  }

  public async createWheelConfigVersion(
    user: RequestUser,
    distribution: Array<{ points: number; weight: number }>
  ): Promise<LeaderboardWheelConfigVersionDto> {
    this.assertCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);
    const version = await this.wheel.createVersion({
      workspaceId,
      ownerCoadminUserId: user.id,
      createdByUserId: user.id,
      distribution
    });
    return {
      id: version.id,
      createdAt: version.createdAt.toISOString(),
      createdByUserId: version.createdByUserId,
      activatedAt: version.activatedAt?.toISOString() ?? null,
      distribution: version.rewardDistributionJson,
      isActive: false
    };
  }

  public async activateWheelConfigVersion(
    user: RequestUser,
    versionId: string
  ): Promise<LeaderboardWheelSettingsDto> {
    this.assertCoadmin(user);
    await this.wheel.activateVersion({
      ownerCoadminUserId: user.id,
      versionId
    });
    await this.audit.record({
      workspaceId: this.requireWorkspaceId(user),
      actorId: user.id,
      action: "leaderboard.wheel.activate_version",
      metadata: { versionId }
    });
    return this.getWheelSettings(user);
  }

  private async safeRecomputeWheelQualification(input: {
    workspaceId: string;
    ownerCoadminUserId: string;
    competitionId: string;
    crmContactId: string;
  }): Promise<void> {
    try {
      await this.wheel.recomputeAfterDepositMutation(input);
    } catch {
      // Never roll back deposit/reversal on wheel recompute failure.
    }
  }

  private requireWorkspaceId(user: RequestUser): string {
    if (!user.workspaceId) {
      throw forbidden();
    }
    return user.workspaceId;
  }

  private assertStaffOrCoadmin(user: RequestUser): void {
    if (!user.workspaceId || (user.role !== "COADMIN" && user.role !== "STAFF")) {
      throw forbidden();
    }
  }

  private assertCoadmin(user: RequestUser): void {
    if (!user.workspaceId || user.role !== "COADMIN") {
      throw forbidden("Only coadmins can perform leaderboard admin actions.");
    }
  }
}
