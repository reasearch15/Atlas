import type { Prisma, PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { AuditService } from "../audit/audit.service";
import { competitionWindowContaining, isInCompetitionWindow } from "./competition-schedule";
import {
  DEFAULT_POOL_RATE_BPS,
  DEPOSIT_SCORING_RECONCILIATION_REASON,
  LEADERBOARD_TIMEZONE,
  type ReferralMilestoneCodeValue
} from "./leaderboard.constants";
import {
  correctDepositPointsFromLedger,
  depositScoringReconciliationIdempotencyKey,
  reconstructPointsReachedAt,
  validQualifyingDepositCentsFromLedger,
  type DepositScoringReconciliationAdjustment,
  type DepositScoringReconciliationResult
} from "./deposit-scoring-reconciliation";
import {
  candidateNotFound,
  competitionAlreadyFinalized,
  competitionNotFinalized,
  competitionNotFrozen,
  contactNotFound,
  eligibilityLocked,
  eventAlreadyReversed,
  eventNotFound,
  invalidDepositAmount,
  invalidEventType,
  invalidMembershipStatus,
  leaderboardDisabled,
  missingReason,
  ownerMismatch,
  participantIntegrityError,
  participantNotBound,
  participantTransferUnsupported,
  payoutAlreadySettled,
  payoutNotFound,
  pendingReviewBlocksFinalize,
  referralAlreadyExists,
  referralNotFound,
  selfReferralForbidden,
  telegramEligibilityOverrideRequired
} from "./leaderboard.errors";
import { milestonesToAward, milestonesToReverse } from "./milestones";
import { assertAllowedPoolRate, depositPointsFromCumulativeCents, poolContributionCents, splitPrizePool } from "./points-math";
import { createCryptoRandomSource, resolvePromotionPoints, type RandomSource } from "./promotion-points";
import { selectPrizeWinnersFromEligibility } from "./prize-eligibility";
import { sortStandings } from "./ranking";
import type {
  BindParticipantInput,
  DepositInput,
  FinalizeInput,
  MarkPayoutInput,
  OverrideReferralInput,
  PromotionInput,
  ReverseDepositInput,
  ReversePromotionInput,
  SetMembershipEligibilityInput,
  SetPoolRateInput,
  SetReferralInput,
  LeaderboardProjectionHooks,
  PrizeMembershipStatus,
  ReconcileActiveDepositScoringInput
} from "./leaderboard.types";

type Tx = Prisma.TransactionClient;

type PendingLeaderboardAudit = {
  readonly workspaceId: string | null;
  readonly actorId: string | null;
  readonly action: string;
  readonly metadata?: Prisma.InputJsonObject;
};

/**
 * Prisma-backed Phase 1.2 leaderboard domain service (per-coadmin ownership).
 * Uses interactive transactions + SELECT FOR UPDATE for concurrency safety.
 * Raw SQL is limited to row locks (documented below).
 */
export class PrismaLeaderboardService {
  private readonly audit: AuditService;
  private readonly random: RandomSource;
  private readonly projectionHooks: LeaderboardProjectionHooks | undefined;

  public constructor(
    private readonly prisma: PrismaClient,
    options: {
      audit?: AuditService;
      random?: RandomSource;
      projectionHooks?: LeaderboardProjectionHooks;
    } = {}
  ) {
    this.audit = options.audit ?? new AuditService(prisma);
    this.random = options.random ?? createCryptoRandomSource();
    this.projectionHooks = options.projectionHooks;
  }

  private async flushPendingAudits(pending: readonly PendingLeaderboardAudit[]): Promise<void> {
    for (const entry of pending) {
      try {
        await this.audit.record(entry);
      } catch (error) {
        console.error(`${entry.action} audit failed after commit`, {
          workspaceId: entry.workspaceId,
          error
        });
      }
    }
  }

  public async bindParticipant(input: BindParticipantInput) {
    await this.assertContact(input.workspaceId, input.crmContactId);
    const now = input.now ?? new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const pendingAudits: PendingLeaderboardAudit[] = [];
      await this.lockContact(tx, input.crmContactId);
      const existing = await tx.leaderboardParticipant.findMany({
        where: { workspaceId: input.workspaceId, crmContactId: input.crmContactId }
      });
      if (existing.length > 1) throw participantIntegrityError();
      let row = existing[0];
      if (row) {
        if (row.ownerCoadminUserId !== input.ownerCoadminUserId) throw participantTransferUnsupported();
      } else {
        try {
          row = await tx.leaderboardParticipant.create({
            data: {
              workspaceId: input.workspaceId,
              ownerCoadminUserId: input.ownerCoadminUserId,
              crmContactId: input.crmContactId,
              createdByUserId: input.createdByUserId ?? null
            }
          });
          pendingAudits.push({
            workspaceId: input.workspaceId,
            actorId: input.createdByUserId ?? null,
            action: "leaderboard.participant_bound",
            metadata: {
              ownerCoadminUserId: input.ownerCoadminUserId,
              crmContactId: input.crmContactId
            }
          });
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          const raced = await tx.leaderboardParticipant.findMany({
            where: { workspaceId: input.workspaceId, crmContactId: input.crmContactId }
          });
          if (raced.length > 1) throw participantIntegrityError();
          if (raced.length === 0) throw error;
          if (raced[0]!.ownerCoadminUserId !== input.ownerCoadminUserId) throw participantTransferUnsupported();
          row = raced[0]!;
        }
      }

      await this.ensureZeroStandingIfActiveTx(
        tx,
        input.workspaceId,
        input.ownerCoadminUserId,
        input.crmContactId,
        now
      );
      return { row, pendingAudits };
    });
    await this.flushPendingAudits(result.pendingAudits);
    return result.row;
  }

  public async resolveLeaderboardOwner(workspaceId: string, crmContactId: string): Promise<string> {
    const matches = await this.prisma.leaderboardParticipant.findMany({
      where: { workspaceId, crmContactId }
    });
    if (matches.length === 0) throw participantNotBound();
    if (matches.length > 1) throw participantIntegrityError();
    return matches[0]!.ownerCoadminUserId;
  }

  public async ensureSettings(workspaceId: string, ownerCoadminUserId: string, actorUserId?: string) {
    const existing = await this.prisma.leaderboardSettings.findUnique({ where: { ownerCoadminUserId } });
    if (existing) {
      if (existing.workspaceId !== workspaceId) throw ownerMismatch();
      return existing;
    }
    return this.prisma.$transaction(async (tx) => this.ensureSettingsTx(tx, workspaceId, ownerCoadminUserId, actorUserId));
  }

  public async setEnabled(
    workspaceId: string,
    ownerCoadminUserId: string,
    enabled: boolean,
    actorUserId: string,
    now = new Date()
  ) {
    const newlyFrozen: string[] = [];
    const result = await this.prisma.$transaction(async (tx) => {
      const pendingAudits: PendingLeaderboardAudit[] = [];
      await this.ensureSettingsTx(tx, workspaceId, ownerCoadminUserId, actorUserId);
      const settings = await tx.leaderboardSettings.update({
        where: { ownerCoadminUserId },
        data: { enabled, updatedByUserId: actorUserId }
      });

      if (enabled) {
        // Create/resolve current biweekly ACTIVE competition, then seed zero-point standings
        // for every existing participant (idempotent; no fabricated scoring events).
        const competition = await this.ensureCurrentCompetitionTx(
          tx,
          workspaceId,
          ownerCoadminUserId,
          now,
          false,
          newlyFrozen,
          pendingAudits
        );
        await this.ensureZeroPointStandingsForOwnerTx(
          tx,
          workspaceId,
          ownerCoadminUserId,
          competition.id,
          now
        );
      }

      return { settings, pendingAudits };
    });

    await this.flushPendingAudits(result.pendingAudits);
    try {
      await this.audit.record({
        workspaceId,
        actorId: actorUserId,
        action: enabled ? "leaderboard.enabled" : "leaderboard.disabled",
        metadata: { ownerCoadminUserId }
      });
    } catch (error) {
      console.error(
        `${enabled ? "leaderboard.enabled" : "leaderboard.disabled"} audit failed after commit`,
        { workspaceId, ownerCoadminUserId, error }
      );
    }
    await this.emitFrozen(workspaceId, ownerCoadminUserId, newlyFrozen);
    return result.settings;
  }

  public async setPoolRate(input: SetPoolRateInput) {
    assertAllowedPoolRate(input.poolRateBps);
    const now = input.now ?? new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const pendingAudits: PendingLeaderboardAudit[] = [];
      await this.lockWorkspace(tx, input.workspaceId);
      const settings = await this.ensureSettingsTx(
        tx,
        input.workspaceId,
        input.ownerCoadminUserId,
        input.actorUserId
      );
      if (settings.poolRateBps === input.poolRateBps) {
        return { settings, pendingAudits };
      }
      const competition = await this.ensureCurrentCompetitionTx(
        tx,
        input.workspaceId,
        input.ownerCoadminUserId,
        now,
        true,
        undefined,
        pendingAudits
      );
      const updated = await tx.leaderboardSettings.update({
        where: { ownerCoadminUserId: input.ownerCoadminUserId },
        data: { poolRateBps: input.poolRateBps, updatedByUserId: input.actorUserId }
      });
      await tx.poolRateHistory.create({
        data: {
          workspaceId: input.workspaceId,
          ownerCoadminUserId: input.ownerCoadminUserId,
          competitionId: competition.id,
          rateBps: input.poolRateBps,
          effectiveFrom: now,
          changedByUserId: input.actorUserId,
          reason: input.reason ?? null
        }
      });
      pendingAudits.push({
        workspaceId: input.workspaceId,
        actorId: input.actorUserId,
        action: "leaderboard.pool_rate_changed",
        metadata: {
          ownerCoadminUserId: input.ownerCoadminUserId,
          from: settings.poolRateBps,
          to: input.poolRateBps,
          reason: input.reason ?? null
        }
      });
      return { settings: updated, pendingAudits };
    });
    await this.flushPendingAudits(result.pendingAudits);
    return result.settings;
  }

  public async ensureCurrentCompetition(
    workspaceId: string,
    ownerCoadminUserId: string,
    now = new Date()
  ) {
    const newlyFrozen: string[] = [];
    const result = await this.prisma.$transaction(async (tx) => {
      const pendingAudits: PendingLeaderboardAudit[] = [];
      const competition = await this.ensureCurrentCompetitionTx(
        tx,
        workspaceId,
        ownerCoadminUserId,
        now,
        false,
        newlyFrozen,
        pendingAudits
      );
      return { competition, pendingAudits };
    });
    await this.flushPendingAudits(result.pendingAudits);
    await this.emitFrozen(workspaceId, ownerCoadminUserId, newlyFrozen);
    return result.competition;
  }

  public async recordDeposit(input: DepositInput) {
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw invalidDepositAmount();
    const now = input.now ?? new Date();

    // Audit MUST run after commit. AuditService uses the root Prisma client; calling it
    // inside an interactive $transaction blocks until the ~5s timeout (prod HTTP 500).
    const result = await this.prisma.$transaction(async (tx) => {
      const pendingAudits: PendingLeaderboardAudit[] = [];
      const existing = await tx.leaderboardEvent.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (existing) {
        return { event: existing, created: false as const, pendingAudits };
      }

      await this.assertContactTx(tx, input.workspaceId, input.crmContactId);
      const ownerCoadminUserId = await this.resolveLeaderboardOwnerTx(tx, input.workspaceId, input.crmContactId);
      const settings = await this.requireEnabledSettings(tx, input.workspaceId, ownerCoadminUserId);
      // Lock order: workspace (via ensureCurrentCompetitionTx) → contact → competition.
      // Matches setPoolRate / lifecycle paths; avoids contact→workspace deadlock risk.
      const competition = await this.ensureCurrentCompetitionTx(
        tx,
        input.workspaceId,
        ownerCoadminUserId,
        now,
        true,
        undefined,
        pendingAudits
      );
      await this.lockContact(tx, input.crmContactId);
      await this.lockCompetition(tx, competition.id);

      const standing = await this.getOrCreateStandingTx(
        tx,
        input.workspaceId,
        ownerCoadminUserId,
        competition.id,
        input.crmContactId,
        now
      );
      const nextCents = standing.qualifyingDepositCents + input.amountCents;
      const nextDepositPoints = depositPointsFromCumulativeCents(nextCents);
      const pointsDelta = nextDepositPoints - standing.depositPoints;
      const contribution = poolContributionCents(input.amountCents, settings.poolRateBps);

      const event = await tx.leaderboardEvent.create({
        data: {
          workspaceId: input.workspaceId,
          ownerCoadminUserId,
          competitionId: competition.id,
          crmContactId: input.crmContactId,
          type: "DEPOSIT",
          pointsDelta,
          depositAmountCents: input.amountCents,
          poolContributionCents: contribution,
          poolRateBpsApplied: settings.poolRateBps,
          actorUserId: input.actorUserId,
          reason: input.reason ?? "deposit",
          metadataJson: { amountCents: input.amountCents },
          occurredAt: now,
          idempotencyKey: input.idempotencyKey
        }
      });

      await tx.leaderboardStanding.update({
        where: { id: standing.id },
        data: {
          qualifyingDepositCents: nextCents,
          depositPoints: nextDepositPoints,
          totalPoints: { increment: pointsDelta },
          ...(pointsDelta !== 0 ? { pointsReachedAt: now } : {}),
          lastEventId: event.id,
          lastEventAt: now,
          lastEventType: event.type,
          lastEventReason: event.reason
        }
      });

      await tx.leaderboardCompetition.update({
        where: { id: competition.id },
        data: { prizePoolCents: { increment: contribution } }
      });
      await this.bumpLifetimeTx(tx, input.workspaceId, ownerCoadminUserId, input.crmContactId, input.amountCents, now);
      await this.syncReferralMilestonesTx(
        tx,
        input.workspaceId,
        ownerCoadminUserId,
        input.crmContactId,
        now,
        input.actorUserId,
        pendingAudits
      );

      pendingAudits.push({
        workspaceId: input.workspaceId,
        actorId: input.actorUserId,
        action: "leaderboard.deposit",
        metadata: {
          eventId: event.id,
          ownerCoadminUserId,
          amountCents: input.amountCents,
          pointsDelta,
          poolContributionCents: contribution,
          competitionId: competition.id
        }
      });

      return {
        event,
        created: true as const,
        pendingAudits
      };
    });

    await this.flushPendingAudits(result.pendingAudits);
    return result.event;
  }

  public async reverseDeposit(input: ReverseDepositInput) {
    const now = input.now ?? new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const pendingAudits: PendingLeaderboardAudit[] = [];
      const existing = await tx.leaderboardEvent.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (existing) return { event: existing, pendingAudits };

      const original = await tx.leaderboardEvent.findFirst({
        where: { id: input.depositEventId, workspaceId: input.workspaceId }
      });
      if (!original) throw eventNotFound();
      if (original.type !== "DEPOSIT") throw invalidEventType("DEPOSIT");
      const already = await tx.leaderboardEvent.findFirst({ where: { reversesEventId: original.id } });
      if (already) throw eventAlreadyReversed();

      const ownerCoadminUserId = original.ownerCoadminUserId;
      await this.requireEnabledSettings(tx, input.workspaceId, ownerCoadminUserId);
      await this.lockContact(tx, original.crmContactId);
      await this.lockCompetition(tx, original.competitionId);
      await this.requireCompetitionTx(tx, original.competitionId, ownerCoadminUserId);

      const amount = original.depositAmountCents ?? 0;
      const contribution = original.poolContributionCents ?? 0;
      const standing = await this.getOrCreateStandingTx(
        tx,
        input.workspaceId,
        ownerCoadminUserId,
        original.competitionId,
        original.crmContactId,
        now
      );
      const nextCents = standing.qualifyingDepositCents - amount;
      if (nextCents < 0) throw new Error("qualifying deposits cannot go negative");
      const nextDepositPoints = depositPointsFromCumulativeCents(nextCents);
      const pointsDelta = nextDepositPoints - standing.depositPoints;

      const event = await tx.leaderboardEvent.create({
        data: {
          workspaceId: input.workspaceId,
          ownerCoadminUserId,
          competitionId: original.competitionId,
          crmContactId: original.crmContactId,
          type: "DEPOSIT_REVERSAL",
          pointsDelta,
          depositAmountCents: -amount,
          poolContributionCents: -contribution,
          poolRateBpsApplied: original.poolRateBpsApplied,
          actorUserId: input.actorUserId,
          reason: input.reason ?? "deposit_reversal",
          metadataJson: { reversesEventId: original.id },
          occurredAt: now,
          idempotencyKey: input.idempotencyKey,
          reversesEventId: original.id
        }
      });

      await tx.leaderboardStanding.update({
        where: { id: standing.id },
        data: {
          qualifyingDepositCents: nextCents,
          depositPoints: nextDepositPoints,
          totalPoints: { increment: pointsDelta },
          ...(pointsDelta !== 0 ? { pointsReachedAt: now } : {}),
          lastEventId: event.id,
          lastEventAt: now,
          lastEventType: event.type,
          lastEventReason: event.reason
        }
      });
      await tx.leaderboardCompetition.update({
        where: { id: original.competitionId },
        data: { prizePoolCents: { decrement: contribution } }
      });
      await this.bumpLifetimeTx(tx, input.workspaceId, ownerCoadminUserId, original.crmContactId, -amount, now);
      await this.syncReferralMilestonesTx(
        tx,
        input.workspaceId,
        ownerCoadminUserId,
        original.crmContactId,
        now,
        input.actorUserId,
        pendingAudits
      );
      pendingAudits.push({
        workspaceId: input.workspaceId,
        actorId: input.actorUserId,
        action: "leaderboard.deposit_reversal",
        metadata: {
          eventId: event.id,
          ownerCoadminUserId,
          reversesEventId: original.id,
          amountCents: amount,
          poolContributionCents: contribution
        }
      });
      return { event, pendingAudits };
    });
    await this.flushPendingAudits(result.pendingAudits);
    return result.event;
  }

  public async setReferral(input: SetReferralInput) {
    if (input.referrerCrmContactId === input.referredCrmContactId) throw selfReferralForbidden();
    const now = input.now ?? new Date();

    // Audit MUST run after commit. AuditService uses the root Prisma client; calling it
    // inside an interactive $transaction blocks until the ~5s timeout (prod HTTP 500).
    const result = await this.prisma.$transaction(async (tx) => {
      const pendingAudits: PendingLeaderboardAudit[] = [];
      await this.assertContactTx(tx, input.workspaceId, input.referrerCrmContactId);
      await this.assertContactTx(tx, input.workspaceId, input.referredCrmContactId);
      await this.lockContact(tx, input.referredCrmContactId);

      const ownerCoadminUserId = await this.resolveLeaderboardOwnerTx(
        tx,
        input.workspaceId,
        input.referredCrmContactId
      );
      const referrerOwner = await this.resolveLeaderboardOwnerTx(
        tx,
        input.workspaceId,
        input.referrerCrmContactId
      );
      if (referrerOwner !== ownerCoadminUserId) throw ownerMismatch();
      await this.requireEnabledSettings(tx, input.workspaceId, ownerCoadminUserId);

      try {
        const row = await tx.leaderboardReferral.create({
          data: {
            workspaceId: input.workspaceId,
            ownerCoadminUserId,
            referrerCrmContactId: input.referrerCrmContactId,
            referredCrmContactId: input.referredCrmContactId,
            createdByUserId: input.actorUserId,
            originalReferrerCrmContactId: input.referrerCrmContactId
          }
        });
        await this.ensureCurrentCompetitionTx(
          tx,
          input.workspaceId,
          ownerCoadminUserId,
          now,
          true,
          undefined,
          pendingAudits
        );
        await this.syncReferralMilestonesTx(
          tx,
          input.workspaceId,
          ownerCoadminUserId,
          input.referredCrmContactId,
          now,
          input.actorUserId,
          pendingAudits
        );
        pendingAudits.push({
          workspaceId: input.workspaceId,
          actorId: input.actorUserId,
          action: "leaderboard.referral_set",
          metadata: {
            referralId: row.id,
            ownerCoadminUserId,
            referrerCrmContactId: row.referrerCrmContactId,
            referredCrmContactId: row.referredCrmContactId,
            idempotencyKey: input.idempotencyKey
          }
        });
        return { row, pendingAudits };
      } catch (error) {
        if (isUniqueViolation(error)) throw referralAlreadyExists();
        throw error;
      }
    });

    await this.flushPendingAudits(result.pendingAudits);
    return result.row;
  }

  public async overrideReferral(input: OverrideReferralInput) {
    if (input.newReferrerCrmContactId === input.referredCrmContactId) throw selfReferralForbidden();
    const now = input.now ?? new Date();

    // Audit MUST run after commit (same root-client / interactive-tx hazard as deposit + setReferral).
    const result = await this.prisma.$transaction(async (tx) => {
      const pendingAudits: PendingLeaderboardAudit[] = [];
      await this.assertContactTx(tx, input.workspaceId, input.newReferrerCrmContactId);
      await this.assertContactTx(tx, input.workspaceId, input.referredCrmContactId);
      await this.lockContact(tx, input.referredCrmContactId);

      const ownerCoadminUserId = await this.resolveLeaderboardOwnerTx(
        tx,
        input.workspaceId,
        input.referredCrmContactId
      );
      const newReferrerOwner = await this.resolveLeaderboardOwnerTx(
        tx,
        input.workspaceId,
        input.newReferrerCrmContactId
      );
      if (newReferrerOwner !== ownerCoadminUserId) throw ownerMismatch();
      await this.requireEnabledSettings(tx, input.workspaceId, ownerCoadminUserId);

      const row = await tx.leaderboardReferral.findUnique({
        where: {
          ownerCoadminUserId_referredCrmContactId: {
            ownerCoadminUserId,
            referredCrmContactId: input.referredCrmContactId
          }
        }
      });
      if (!row) throw referralNotFound();
      const previous = row.referrerCrmContactId;
      const updated = await tx.leaderboardReferral.update({
        where: { id: row.id },
        data: {
          referrerCrmContactId: input.newReferrerCrmContactId,
          originalReferrerCrmContactId: row.originalReferrerCrmContactId ?? previous,
          overriddenAt: now,
          overriddenByUserId: input.actorUserId,
          overrideReason: input.reason
        }
      });
      await this.ensureCurrentCompetitionTx(
        tx,
        input.workspaceId,
        ownerCoadminUserId,
        now,
        true,
        undefined,
        pendingAudits
      );
      await this.syncReferralMilestonesTx(
        tx,
        input.workspaceId,
        ownerCoadminUserId,
        input.referredCrmContactId,
        now,
        input.actorUserId,
        pendingAudits
      );
      pendingAudits.push({
        workspaceId: input.workspaceId,
        actorId: input.actorUserId,
        action: "leaderboard.referral_override",
        metadata: {
          referralId: updated.id,
          ownerCoadminUserId,
          previousReferrerCrmContactId: previous,
          newReferrerCrmContactId: input.newReferrerCrmContactId,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey
        }
      });
      return { updated, pendingAudits };
    });

    await this.flushPendingAudits(result.pendingAudits);
    return result.updated;
  }

  public async recordPromotion(input: PromotionInput) {
    const now = input.now ?? new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const pendingAudits: PendingLeaderboardAudit[] = [];
      const existing = await tx.leaderboardEvent.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (existing) return { event: existing, created: false as const, pendingAudits };
      await this.assertContactTx(tx, input.workspaceId, input.crmContactId);
      await this.lockContact(tx, input.crmContactId);
      const ownerCoadminUserId = await this.resolveLeaderboardOwnerTx(tx, input.workspaceId, input.crmContactId);
      await this.requireEnabledSettings(tx, input.workspaceId, ownerCoadminUserId);
      const competition = await this.ensureCurrentCompetitionTx(
        tx,
        input.workspaceId,
        ownerCoadminUserId,
        now,
        true,
        undefined,
        pendingAudits
      );
      const prior = await tx.promotionAward.findMany({
        where: { ownerCoadminUserId, crmContactId: input.crmContactId },
        select: { createdAt: true },
        orderBy: { createdAt: "asc" }
      });
      const points = resolvePromotionPoints(
        prior.map((p) => p.createdAt),
        now,
        this.random
      );
      const event = await tx.leaderboardEvent.create({
        data: {
          workspaceId: input.workspaceId,
          ownerCoadminUserId,
          competitionId: competition.id,
          crmContactId: input.crmContactId,
          type: "PROMOTION",
          pointsDelta: points,
          actorUserId: input.actorUserId,
          reason: input.reason ?? "promotion",
          metadataJson: { points },
          occurredAt: now,
          idempotencyKey: input.idempotencyKey
        }
      });
      await tx.promotionAward.create({
        data: {
          workspaceId: input.workspaceId,
          ownerCoadminUserId,
          competitionId: competition.id,
          crmContactId: input.crmContactId,
          points,
          eventId: event.id,
          actorUserId: input.actorUserId,
          idempotencyKey: input.idempotencyKey,
          createdAt: now
        }
      });
      const standing = await this.getOrCreateStandingTx(
        tx,
        input.workspaceId,
        ownerCoadminUserId,
        competition.id,
        input.crmContactId,
        now
      );
      await tx.leaderboardStanding.update({
        where: { id: standing.id },
        data: {
          promotionPoints: { increment: points },
          totalPoints: { increment: points },
          pointsReachedAt: now,
          lastEventId: event.id,
          lastEventAt: now,
          lastEventType: event.type,
          lastEventReason: event.reason
        }
      });
      pendingAudits.push({
        workspaceId: input.workspaceId,
        actorId: input.actorUserId,
        action: "leaderboard.promotion",
        metadata: { eventId: event.id, ownerCoadminUserId, points, competitionId: competition.id }
      });
      return { event, created: true as const, pendingAudits };
    });
    await this.flushPendingAudits(result.pendingAudits);
    return result.event;
  }

  public async reversePromotion(input: ReversePromotionInput) {
    const now = input.now ?? new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const pendingAudits: PendingLeaderboardAudit[] = [];
      const existing = await tx.leaderboardEvent.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (existing) return { event: existing, pendingAudits };
      const original = await tx.leaderboardEvent.findFirst({
        where: { id: input.promotionEventId, workspaceId: input.workspaceId }
      });
      if (!original) throw eventNotFound();
      if (original.type !== "PROMOTION") throw invalidEventType("PROMOTION");
      const already = await tx.leaderboardEvent.findFirst({ where: { reversesEventId: original.id } });
      if (already) throw eventAlreadyReversed();
      const ownerCoadminUserId = original.ownerCoadminUserId;
      await this.requireEnabledSettings(tx, input.workspaceId, ownerCoadminUserId);
      await this.lockContact(tx, original.crmContactId);
      const points = original.pointsDelta;
      const event = await tx.leaderboardEvent.create({
        data: {
          workspaceId: input.workspaceId,
          ownerCoadminUserId,
          competitionId: original.competitionId,
          crmContactId: original.crmContactId,
          type: "PROMOTION_REVERSAL",
          pointsDelta: -points,
          actorUserId: input.actorUserId,
          reason: input.reason ?? "promotion_reversal",
          metadataJson: { reversesEventId: original.id },
          occurredAt: now,
          idempotencyKey: input.idempotencyKey,
          reversesEventId: original.id
        }
      });
      const standing = await this.getOrCreateStandingTx(
        tx,
        input.workspaceId,
        ownerCoadminUserId,
        original.competitionId,
        original.crmContactId,
        now
      );
      await tx.leaderboardStanding.update({
        where: { id: standing.id },
        data: {
          promotionPoints: { decrement: points },
          totalPoints: { increment: -points },
          pointsReachedAt: now,
          lastEventId: event.id,
          lastEventAt: now,
          lastEventType: event.type,
          lastEventReason: event.reason
        }
      });
      pendingAudits.push({
        workspaceId: input.workspaceId,
        actorId: input.actorUserId,
        action: "leaderboard.promotion_reversal",
        metadata: {
          eventId: event.id,
          ownerCoadminUserId,
          reversesEventId: original.id,
          points
        }
      });
      return { event, pendingAudits };
    });
    await this.flushPendingAudits(result.pendingAudits);
    return result.event;
  }

  public async finalizeCompetition(input: FinalizeInput) {
    const now = input.now ?? new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const pendingAudits: PendingLeaderboardAudit[] = [];
      const byKey = await tx.leaderboardCompetition.findFirst({
        where: { finalizationIdempotencyKey: input.idempotencyKey }
      });
      if (byKey) {
        if (byKey.ownerCoadminUserId !== input.ownerCoadminUserId) throw ownerMismatch();
        return { competition: byKey, pendingAudits };
      }

      await this.lockCompetition(tx, input.competitionId);
      const competition = await this.requireCompetitionTx(tx, input.competitionId, input.ownerCoadminUserId);
      if (competition.workspaceId !== input.workspaceId) throw ownerMismatch();
      if (competition.status === "FINALIZED") {
        if (
          competition.finalizationIdempotencyKey &&
          competition.finalizationIdempotencyKey !== input.idempotencyKey
        ) {
          throw competitionAlreadyFinalized();
        }
        const stamped = await tx.leaderboardCompetition.update({
          where: { id: competition.id },
          data: { finalizationIdempotencyKey: input.idempotencyKey }
        });
        return { competition: stamped, pendingAudits };
      }
      if (competition.status !== "FROZEN") throw competitionNotFrozen();

      const snapshot = await tx.competitionSnapshot.findUnique({ where: { competitionId: competition.id } });
      if (!snapshot) throw eventNotFound();

      const candidates = await tx.giveawayEligibilityCandidate.findMany({
        where: { competitionId: competition.id },
        orderBy: { leaderboardRank: "asc" }
      });
      const selection = selectPrizeWinnersFromEligibility(candidates);
      if (!selection.ok) throw pendingReviewBlocksFinalize(selection.pendingCrmContactIds);

      const splits = splitPrizePool(snapshot.prizePoolCents);
      const winnersPayload = selection.winners.map((winner) => {
        const split = splits.find((s) => s.rank === winner.prizeRank)!;
        return {
          prizeRank: winner.prizeRank,
          leaderboardRank: winner.leaderboardRank,
          crmContactId: winner.crmContactId,
          totalPoints: winner.totalPoints,
          payoutCents: split.payoutCents
        };
      });

      if (!snapshot.winnersJson) {
        await tx.competitionSnapshot.update({
          where: { competitionId: competition.id },
          data: { winnersJson: winnersPayload, winnersLockedAt: now }
        });
        for (const winner of winnersPayload) {
          await tx.giveawayPayout.create({
            data: {
              workspaceId: competition.workspaceId,
              ownerCoadminUserId: competition.ownerCoadminUserId,
              competitionId: competition.id,
              prizeRank: winner.prizeRank,
              leaderboardRank: winner.leaderboardRank,
              crmContactId: winner.crmContactId,
              points: winner.totalPoints,
              payoutCents: winner.payoutCents,
              status: "UNPAID"
            }
          });
        }
      }

      const updated = await tx.leaderboardCompetition.updateMany({
        where: { id: competition.id, status: "FROZEN" },
        data: {
          status: "FINALIZED",
          finalizedAt: now,
          finalizedByUserId: input.actorUserId,
          finalizationIdempotencyKey: input.idempotencyKey
        }
      });
      if (updated.count === 0) {
        const again = await tx.leaderboardCompetition.findUniqueOrThrow({ where: { id: competition.id } });
        if (again.finalizationIdempotencyKey === input.idempotencyKey) {
          return { competition: again, pendingAudits };
        }
        throw competitionAlreadyFinalized();
      }
      const finalized = await tx.leaderboardCompetition.findUniqueOrThrow({ where: { id: competition.id } });
      pendingAudits.push({
        workspaceId: input.workspaceId,
        actorId: input.actorUserId,
        action: "leaderboard.competition_finalized",
        metadata: {
          competitionId: competition.id,
          ownerCoadminUserId: input.ownerCoadminUserId,
          winners: winnersPayload
        }
      });
      return { competition: finalized, pendingAudits };
    });
    await this.flushPendingAudits(result.pendingAudits);
    return result.competition;
  }

  public async setMembershipEligibility(input: SetMembershipEligibilityInput) {
    const allowed: PrizeMembershipStatus[] = ["ELIGIBLE", "NOT_ELIGIBLE", "PENDING_REVIEW"];
    if (!allowed.includes(input.membershipStatus)) throw invalidMembershipStatus();
    const now = input.now ?? new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const pendingAudits: PendingLeaderboardAudit[] = [];
      await this.lockCompetition(tx, input.competitionId);
      const competition = await this.requireCompetitionTx(tx, input.competitionId, input.ownerCoadminUserId);
      if (competition.workspaceId !== input.workspaceId) throw ownerMismatch();
      if (competition.status === "FINALIZED") throw eligibilityLocked();
      if (competition.status !== "FROZEN") throw competitionNotFrozen();

      const candidate = await tx.giveawayEligibilityCandidate.findUnique({
        where: {
          competitionId_crmContactId: {
            competitionId: input.competitionId,
            crmContactId: input.crmContactId
          }
        }
      });
      if (!candidate) throw candidateNotFound();
      if (candidate.ownerCoadminUserId !== input.ownerCoadminUserId) throw ownerMismatch();

      const isBotApiTerminal =
        candidate.verificationSource === "TELEGRAM_BOT_API" &&
        (candidate.membershipStatus === "ELIGIBLE" || candidate.membershipStatus === "NOT_ELIGIBLE");
      const source = input.verificationSource ?? "MANUAL";
      if (
        isBotApiTerminal &&
        source === "MANUAL" &&
        !input.allowTelegramOverwrite &&
        input.explicitOverride !== true
      ) {
        throw telegramEligibilityOverrideRequired();
      }
      if (isBotApiTerminal && source === "MANUAL" && input.explicitOverride === true && !input.reason?.trim()) {
        throw missingReason();
      }

      const ineligibilityReason =
        input.membershipStatus === "NOT_ELIGIBLE" ? (input.ineligibilityReason ?? null) : null;

      const updated = await tx.giveawayEligibilityCandidate.update({
        where: { id: candidate.id },
        data: {
          membershipStatus: input.membershipStatus,
          ineligibilityReason,
          resolvedAt: now,
          resolvedByUserId: input.actorUserId,
          resolutionReason: input.reason ?? null,
          verificationSource: source,
          telegramChatMemberStatus:
            input.telegramChatMemberStatus !== undefined
              ? input.telegramChatMemberStatus
              : source === "MANUAL"
                ? null
                : candidate.telegramChatMemberStatus,
          verifiedChannelId:
            input.verifiedChannelId !== undefined ? input.verifiedChannelId : candidate.verifiedChannelId,
          botIntegrationId:
            input.botIntegrationId !== undefined ? input.botIntegrationId : candidate.botIntegrationId,
          verificationCheckedAt: now,
          verificationErrorCode:
            input.verificationErrorCode !== undefined
              ? input.verificationErrorCode
              : source === "MANUAL"
                ? null
                : candidate.verificationErrorCode,
          verificationErrorMessage:
            input.verificationErrorMessage !== undefined
              ? input.verificationErrorMessage
              : source === "MANUAL"
                ? null
                : candidate.verificationErrorMessage
        }
      });
      pendingAudits.push({
        workspaceId: input.workspaceId,
        actorId: input.actorUserId,
        action: "leaderboard.membership_eligibility_set",
        metadata: {
          competitionId: input.competitionId,
          ownerCoadminUserId: input.ownerCoadminUserId,
          crmContactId: input.crmContactId,
          membershipStatus: input.membershipStatus,
          ineligibilityReason,
          reason: input.reason ?? null,
          verificationSource: source,
          explicitOverride: input.explicitOverride === true,
          idempotencyKey: input.idempotencyKey
        }
      });
      return { updated, pendingAudits };
    });
    await this.flushPendingAudits(result.pendingAudits);
    return result.updated;
  }

  public async markPayout(input: MarkPayoutInput) {
    const now = input.now ?? new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const pendingAudits: PendingLeaderboardAudit[] = [];
      await this.lockWorkspace(tx, input.workspaceId);
      const payout = await tx.giveawayPayout.findUnique({ where: { id: input.payoutId } });
      if (!payout) throw payoutNotFound();
      if (payout.workspaceId !== input.workspaceId) throw ownerMismatch();
      if (payout.ownerCoadminUserId !== input.ownerCoadminUserId) throw ownerMismatch();

      const competition = await this.requireCompetitionTx(tx, payout.competitionId, input.ownerCoadminUserId);
      if (competition.status !== "FINALIZED") throw competitionNotFinalized();

      if (payout.status === input.status) {
        return { payout, pendingAudits };
      }
      if (payout.status === "PAID" || payout.status === "VOID") {
        throw payoutAlreadySettled();
      }

      const updated = await tx.giveawayPayout.update({
        where: { id: payout.id },
        data:
          input.status === "PAID"
            ? {
                status: "PAID",
                paidAt: now,
                paidByUserId: input.actorUserId,
                notes: input.notes ?? payout.notes
              }
            : {
                status: "VOID",
                paidAt: null,
                paidByUserId: null,
                notes: input.notes ?? payout.notes
              }
      });

      pendingAudits.push({
        workspaceId: input.workspaceId,
        actorId: input.actorUserId,
        action: "leaderboard.payout_marked",
        metadata: {
          payoutId: updated.id,
          competitionId: updated.competitionId,
          ownerCoadminUserId: input.ownerCoadminUserId,
          status: input.status,
          notes: input.notes ?? null,
          idempotencyKey: input.idempotencyKey
        }
      });
      return { payout: updated, pendingAudits };
    });
    await this.flushPendingAudits(result.pendingAudits);
    return result.payout;
  }

  /**
   * Explicit ACTIVE-only deposit scoring reconciliation ($5=1 → $1=1).
   * Append-only MANUAL_ADJUSTMENT markers; does not rewrite DEPOSIT events or pools.
   */
  public async reconcileActiveDepositScoring(
    input: ReconcileActiveDepositScoringInput
  ): Promise<DepositScoringReconciliationResult> {
    const now = input.now ?? new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const pendingAudits: PendingLeaderboardAudit[] = [];
      if (input.competitionId) {
        await this.lockCompetition(tx, input.competitionId);
        const target = await tx.leaderboardCompetition.findUnique({ where: { id: input.competitionId } });
        if (!target) throw eventNotFound();
        if (target.ownerCoadminUserId !== input.ownerCoadminUserId) throw ownerMismatch();
        if (target.status !== "ACTIVE") {
          return {
            summary: {
              competitionsProcessed: 0,
              playersVisited: 0,
              playersAdjusted: 0,
              playersAlreadyCorrect: 0,
              playersSkippedIdempotent: 0,
              adjustments: []
            },
            pendingAudits
          };
        }
      }

      const competitions = await tx.leaderboardCompetition.findMany({
        where: {
          ownerCoadminUserId: input.ownerCoadminUserId,
          status: "ACTIVE",
          ...(input.competitionId ? { id: input.competitionId } : {})
        }
      });

      const adjustments: DepositScoringReconciliationAdjustment[] = [];
      let playersVisited = 0;
      let playersAdjusted = 0;
      let playersAlreadyCorrect = 0;
      let playersSkippedIdempotent = 0;

      for (const competition of competitions) {
        await this.lockCompetition(tx, competition.id);
        const standings = await tx.leaderboardStanding.findMany({
          where: {
            competitionId: competition.id,
            ownerCoadminUserId: competition.ownerCoadminUserId
          }
        });
        const depositEvents = await tx.leaderboardEvent.findMany({
          where: {
            competitionId: competition.id,
            ownerCoadminUserId: competition.ownerCoadminUserId,
            type: { in: ["DEPOSIT", "DEPOSIT_REVERSAL"] }
          },
          select: { crmContactId: true }
        });
        const contactIds = new Set<string>([
          ...standings.map((s) => s.crmContactId),
          ...depositEvents.map((e) => e.crmContactId)
        ]);

        for (const crmContactId of contactIds) {
          playersVisited += 1;
          const idempotencyKey = depositScoringReconciliationIdempotencyKey(competition.id, crmContactId);
          const existing = await tx.leaderboardEvent.findUnique({ where: { idempotencyKey } });
          if (existing) {
            playersSkippedIdempotent += 1;
            const meta = (existing.metadataJson ?? {}) as Record<string, unknown>;
            adjustments.push({
              competitionId: competition.id,
              ownerCoadminUserId: competition.ownerCoadminUserId,
              crmContactId,
              qualifyingDepositCents: Number(meta.qualifyingDepositCents ?? 0),
              fromDepositPoints: Number(meta.fromDepositPoints ?? 0),
              toDepositPoints: Number(meta.toDepositPoints ?? 0),
              pointsDelta: 0,
              alreadyReconciled: true
            });
            continue;
          }

          await this.lockContact(tx, crmContactId);
          const ledgerEvents = await tx.leaderboardEvent.findMany({
            where: {
              competitionId: competition.id,
              crmContactId,
              ownerCoadminUserId: competition.ownerCoadminUserId
            },
            orderBy: [{ occurredAt: "asc" }, { id: "asc" }]
          });
          const helperEvents = ledgerEvents.map((e) => ({
            id: e.id,
            type: e.type as
              | "DEPOSIT"
              | "DEPOSIT_REVERSAL"
              | "REFERRAL_MILESTONE"
              | "REFERRAL_MILESTONE_REVERSAL"
              | "PROMOTION"
              | "PROMOTION_REVERSAL"
              | "MANUAL_ADJUSTMENT",
            pointsDelta: e.pointsDelta,
            depositAmountCents: e.depositAmountCents,
            occurredAt: e.occurredAt
          }));

          const qualifyingDepositCents = validQualifyingDepositCentsFromLedger(helperEvents);
          const correctDepositPoints = correctDepositPointsFromLedger(helperEvents);

          let standing = await tx.leaderboardStanding.findUnique({
            where: {
              competitionId_crmContactId: {
                competitionId: competition.id,
                crmContactId
              }
            }
          });
          if (!standing) {
            standing = await tx.leaderboardStanding.create({
              data: {
                id: randomUUID(),
                workspaceId: competition.workspaceId,
                ownerCoadminUserId: competition.ownerCoadminUserId,
                competitionId: competition.id,
                crmContactId,
                totalPoints: 0,
                depositPoints: 0,
                referralPoints: 0,
                promotionPoints: 0,
                wheelPoints: 0,
                qualifyingDepositCents: 0,
                successfulReferralCount: 0,
                pointsReachedAt: now
              }
            });
          }

          const fromDepositPoints = standing.depositPoints;
          const pointsDelta = correctDepositPoints - fromDepositPoints;
          const pointsReachedAt = reconstructPointsReachedAt({
            events: helperEvents,
            correctDepositPoints,
            referralPoints: standing.referralPoints,
            promotionPoints: standing.promotionPoints,
            wheelPoints: standing.wheelPoints,
            fallback: standing.pointsReachedAt
          });

          const event = await tx.leaderboardEvent.create({
            data: {
              id: randomUUID(),
              workspaceId: competition.workspaceId,
              ownerCoadminUserId: competition.ownerCoadminUserId,
              competitionId: competition.id,
              crmContactId,
              type: "MANUAL_ADJUSTMENT",
              pointsDelta,
              depositAmountCents: null,
              poolContributionCents: null,
              poolRateBpsApplied: null,
              actorUserId: input.actorUserId ?? null,
              reason: DEPOSIT_SCORING_RECONCILIATION_REASON,
              metadataJson: {
                kind: DEPOSIT_SCORING_RECONCILIATION_REASON,
                fromDepositPoints,
                toDepositPoints: correctDepositPoints,
                qualifyingDepositCents,
                poolUnchanged: true,
                referralUnchanged: true,
                promotionUnchanged: true
              },
              occurredAt: now,
              idempotencyKey
            }
          });

          await tx.leaderboardStanding.update({
            where: { id: standing.id },
            data: {
              qualifyingDepositCents,
              depositPoints: correctDepositPoints,
              totalPoints:
                correctDepositPoints +
                standing.referralPoints +
                standing.promotionPoints +
                standing.wheelPoints,
              pointsReachedAt,
              lastEventId: event.id,
              lastEventAt: now,
              lastEventType: "MANUAL_ADJUSTMENT",
              lastEventReason: DEPOSIT_SCORING_RECONCILIATION_REASON
            }
          });

          if (pointsDelta !== 0) playersAdjusted += 1;
          else playersAlreadyCorrect += 1;

          adjustments.push({
            competitionId: competition.id,
            ownerCoadminUserId: competition.ownerCoadminUserId,
            crmContactId,
            qualifyingDepositCents,
            fromDepositPoints,
            toDepositPoints: correctDepositPoints,
            pointsDelta,
            alreadyReconciled: false
          });
        }
      }

      pendingAudits.push({
        workspaceId: competitions[0]?.workspaceId ?? null,
        actorId: input.actorUserId ?? null,
        action: "leaderboard.active_deposit_scoring_reconciled",
        metadata: {
          ownerCoadminUserId: input.ownerCoadminUserId,
          competitionId: input.competitionId ?? null,
          competitionsProcessed: competitions.length,
          playersVisited,
          playersAdjusted,
          playersAlreadyCorrect,
          playersSkippedIdempotent
        }
      });

      return {
        summary: {
          competitionsProcessed: competitions.length,
          playersVisited,
          playersAdjusted,
          playersAlreadyCorrect,
          playersSkippedIdempotent,
          adjustments
        },
        pendingAudits
      };
    });
    await this.flushPendingAudits(result.pendingAudits);
    return result.summary;
  }

  private async emitFrozen(
    workspaceId: string,
    ownerCoadminUserId: string,
    competitionIds: readonly string[]
  ): Promise<void> {
    if (!this.projectionHooks?.onFrozen || competitionIds.length === 0) return;
    for (const competitionId of competitionIds) {
      try {
        await this.projectionHooks.onFrozen({ workspaceId, ownerCoadminUserId, competitionId });
      } catch {
        // Projection failures must never roll back domain commits.
      }
    }
  }

  private async ensureCurrentCompetitionTx(
    tx: Tx,
    workspaceId: string,
    ownerCoadminUserId: string,
    now: Date,
    skipEnabledCheck: boolean,
    newlyFrozen?: string[],
    pendingAudits?: PendingLeaderboardAudit[]
  ) {
    await this.lockWorkspace(tx, workspaceId);
    await this.ensureSettingsTx(tx, workspaceId, ownerCoadminUserId);
    if (!skipEnabledCheck) await this.requireEnabledSettings(tx, workspaceId, ownerCoadminUserId);

    const expired = await tx.leaderboardCompetition.findMany({
      where: {
        workspaceId,
        ownerCoadminUserId,
        status: "ACTIVE",
        endsAt: { lte: now }
      }
    });
    for (const competition of expired) {
      const frozen = await this.freezeCompetitionTx(tx, competition.id, now, pendingAudits);
      if (frozen.status === "FROZEN") newlyFrozen?.push(frozen.id);
    }

    const window = competitionWindowContaining(now);
    const bySequence = await tx.leaderboardCompetition.findUnique({
      where: {
        ownerCoadminUserId_sequence: {
          ownerCoadminUserId,
          sequence: window.sequence
        }
      }
    });
    if (bySequence && isInCompetitionWindow(now, bySequence.startsAt, bySequence.endsAt)) {
      if (bySequence.workspaceId !== workspaceId) throw ownerMismatch();
      if (bySequence.status === "SCHEDULED") {
        return tx.leaderboardCompetition.update({
          where: { id: bySequence.id },
          data: { status: "ACTIVE" }
        });
      }
      if (bySequence.status === "ACTIVE") return bySequence;
    }

    const active = await tx.leaderboardCompetition.findFirst({
      where: {
        ownerCoadminUserId,
        status: "ACTIVE",
        startsAt: { lte: now },
        endsAt: { gt: now }
      }
    });
    if (active) {
      if (active.workspaceId !== workspaceId) throw ownerMismatch();
      return active;
    }

    try {
      return await tx.leaderboardCompetition.create({
        data: {
          workspaceId,
          ownerCoadminUserId,
          sequence: window.sequence,
          startsAt: window.startsAt,
          endsAt: window.endsAt,
          status: "ACTIVE",
          prizePoolCents: 0
        }
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await tx.leaderboardCompetition.findUnique({
        where: {
          ownerCoadminUserId_sequence: {
            ownerCoadminUserId,
            sequence: window.sequence
          }
        }
      });
      if (!raced) throw error;
      if (raced.workspaceId !== workspaceId) throw ownerMismatch();
      return raced;
    }
  }

  private async freezeCompetitionTx(
    tx: Tx,
    competitionId: string,
    now: Date,
    pendingAudits?: PendingLeaderboardAudit[]
  ) {
    await this.lockCompetition(tx, competitionId);
    const competition = await tx.leaderboardCompetition.findUniqueOrThrow({ where: { id: competitionId } });
    if (competition.status !== "ACTIVE") return competition;

    const existingSnapshot = await tx.competitionSnapshot.findUnique({ where: { competitionId } });
    if (existingSnapshot) {
      return tx.leaderboardCompetition.update({
        where: { id: competitionId },
        data: { status: "FROZEN", frozenAt: competition.frozenAt ?? now }
      });
    }

    const standings = await tx.leaderboardStanding.findMany({ where: { competitionId } });
    const ranked = sortStandings(standings);
    const top10 = ranked.slice(0, 10).map((s, index) => ({
      rank: index + 1,
      crmContactId: s.crmContactId,
      totalPoints: s.totalPoints,
      pointsReachedAt: s.pointsReachedAt.toISOString()
    }));
    const top3 = top10.slice(0, 3);
    const standingsHash = createHash("sha256").update(JSON.stringify(top10)).digest("hex");

    const [depositEvents, promotionEvents, referralMilestoneEvents, reversalEvents] = await Promise.all([
      tx.leaderboardEvent.count({ where: { competitionId, type: "DEPOSIT" } }),
      tx.leaderboardEvent.count({ where: { competitionId, type: "PROMOTION" } }),
      tx.leaderboardEvent.count({ where: { competitionId, type: "REFERRAL_MILESTONE" } }),
      tx.leaderboardEvent.count({
        where: {
          competitionId,
          type: { in: ["DEPOSIT_REVERSAL", "REFERRAL_MILESTONE_REVERSAL", "PROMOTION_REVERSAL"] }
        }
      })
    ]);

    await tx.competitionSnapshot.create({
      data: {
        competitionId,
        workspaceId: competition.workspaceId,
        ownerCoadminUserId: competition.ownerCoadminUserId,
        frozenAt: now,
        prizePoolCents: competition.prizePoolCents,
        top10Json: top10,
        top3Json: top3,
        standingsHash,
        metricsJson: {
          rankedPlayers: ranked.length,
          depositEvents,
          promotionEvents,
          referralMilestoneEvents,
          reversalEvents
        }
      }
    });

    for (let index = 0; index < ranked.length; index += 1) {
      const standing = ranked[index]!;
      await tx.giveawayEligibilityCandidate.create({
        data: {
          workspaceId: competition.workspaceId,
          ownerCoadminUserId: competition.ownerCoadminUserId,
          competitionId,
          crmContactId: standing.crmContactId,
          leaderboardRank: index + 1,
          totalPoints: standing.totalPoints,
          membershipStatus: "PENDING_REVIEW"
        }
      });
    }

    const frozen = await tx.leaderboardCompetition.updateMany({
      where: { id: competitionId, status: "ACTIVE" },
      data: { status: "FROZEN", frozenAt: now }
    });
    if (frozen.count === 0) {
      return tx.leaderboardCompetition.findUniqueOrThrow({ where: { id: competitionId } });
    }
    pendingAudits?.push({
      workspaceId: competition.workspaceId,
      actorId: null,
      action: "leaderboard.competition_frozen",
      metadata: {
        competitionId,
        ownerCoadminUserId: competition.ownerCoadminUserId,
        prizePoolCents: competition.prizePoolCents
      }
    });
    return tx.leaderboardCompetition.findUniqueOrThrow({ where: { id: competitionId } });
  }

  private async syncReferralMilestonesTx(
    tx: Tx,
    workspaceId: string,
    ownerCoadminUserId: string,
    referredCrmContactId: string,
    now: Date,
    actorUserId: string | null,
    pendingAudits?: PendingLeaderboardAudit[]
  ) {
    const referral = await tx.leaderboardReferral.findUnique({
      where: {
        ownerCoadminUserId_referredCrmContactId: {
          ownerCoadminUserId,
          referredCrmContactId
        }
      }
    });
    if (!referral) return;
    const stats = await tx.leaderboardPlayerStats.findUnique({
      where: {
        ownerCoadminUserId_crmContactId: {
          ownerCoadminUserId,
          crmContactId: referredCrmContactId
        }
      }
    });
    const lifetime = stats?.lifetimeQualifyingDepositCents ?? 0;
    const active = await tx.referralMilestoneAward.findMany({
      where: { referralId: referral.id, status: "ACTIVE" }
    });

    const toReverse = milestonesToReverse(
      lifetime,
      active.map((m) => ({ code: m.milestoneCode, thresholdCents: m.thresholdCents, points: m.points }))
    );
    for (const milestone of toReverse) {
      const row = active.find((m) => m.milestoneCode === milestone.code);
      if (!row) continue;
      const awardEvent = await tx.leaderboardEvent.findUnique({ where: { id: row.awardEventId } });
      const beneficiaryId = awardEvent?.crmContactId ?? referral.referrerCrmContactId;
      await this.requireCompetitionTx(tx, row.competitionId, ownerCoadminUserId);
      const event = await tx.leaderboardEvent.create({
        data: {
          workspaceId,
          ownerCoadminUserId,
          competitionId: row.competitionId,
          crmContactId: beneficiaryId,
          type: "REFERRAL_MILESTONE_REVERSAL",
          pointsDelta: -row.points,
          actorUserId,
          reason: `referral_milestone_reversal:${row.milestoneCode}`,
          metadataJson: {
            milestoneCode: row.milestoneCode,
            referredCrmContactId,
            awardId: row.id,
            originalCompetitionId: row.competitionId
          },
          occurredAt: now,
          idempotencyKey: `milestone-rev:${row.id}`.slice(0, 160)
        }
      });
      await tx.referralMilestoneAward.update({
        where: { id: row.id },
        data: { status: "REVERSED", reversalEventId: event.id, reversedAt: now }
      });
      const standing = await this.getOrCreateStandingTx(
        tx,
        workspaceId,
        ownerCoadminUserId,
        row.competitionId,
        beneficiaryId,
        now
      );
      await tx.leaderboardStanding.update({
        where: { id: standing.id },
        data: {
          referralPoints: { decrement: row.points },
          totalPoints: { increment: -row.points },
          ...(row.milestoneCode === "FIRST_10"
            ? { successfulReferralCount: Math.max(0, standing.successfulReferralCount - 1) }
            : {}),
          pointsReachedAt: now,
          lastEventId: event.id,
          lastEventAt: now,
          lastEventType: event.type,
          lastEventReason: event.reason
        }
      });
    }

    const stillActive = await tx.referralMilestoneAward.findMany({
      where: { referralId: referral.id, status: "ACTIVE" }
    });
    const stillActiveCodes = new Set(stillActive.map((m) => m.milestoneCode));
    const toAward = milestonesToAward(lifetime, stillActiveCodes);
    for (const milestone of toAward) {
      const competition = await this.ensureCurrentCompetitionTx(
        tx,
        workspaceId,
        ownerCoadminUserId,
        now,
        true,
        undefined,
        pendingAudits
      );
      const priorGens = await tx.referralMilestoneAward.count({
        where: { referralId: referral.id, milestoneCode: milestone.code }
      });
      const generation = priorGens + 1;
      const event = await tx.leaderboardEvent.create({
        data: {
          workspaceId,
          ownerCoadminUserId,
          competitionId: competition.id,
          crmContactId: referral.referrerCrmContactId,
          type: "REFERRAL_MILESTONE",
          pointsDelta: milestone.points,
          actorUserId,
          reason: `referral_milestone:${milestone.code}`,
          metadataJson: {
            milestoneCode: milestone.code,
            referredCrmContactId,
            thresholdCents: milestone.thresholdCents,
            generation
          },
          occurredAt: now,
          idempotencyKey: `milestone:${referral.id}:${milestone.code}:g${generation}`.slice(0, 160)
        }
      });
      await tx.referralMilestoneAward.create({
        data: {
          workspaceId,
          referralId: referral.id,
          competitionId: competition.id,
          milestoneCode: milestone.code as ReferralMilestoneCodeValue,
          thresholdCents: milestone.thresholdCents,
          points: milestone.points,
          status: "ACTIVE",
          generation,
          awardEventId: event.id,
          awardedAt: now
        }
      });
      const standing = await this.getOrCreateStandingTx(
        tx,
        workspaceId,
        ownerCoadminUserId,
        competition.id,
        referral.referrerCrmContactId,
        now
      );
      await tx.leaderboardStanding.update({
        where: { id: standing.id },
        data: {
          referralPoints: { increment: milestone.points },
          totalPoints: { increment: milestone.points },
          ...(milestone.code === "FIRST_10" ? { successfulReferralCount: { increment: 1 } } : {}),
          pointsReachedAt: now,
          lastEventId: event.id,
          lastEventAt: now,
          lastEventType: event.type,
          lastEventReason: event.reason
        }
      });
    }
  }

  private async bumpLifetimeTx(
    tx: Tx,
    workspaceId: string,
    ownerCoadminUserId: string,
    crmContactId: string,
    deltaCents: number,
    now: Date
  ) {
    const existing = await tx.leaderboardPlayerStats.findUnique({
      where: {
        ownerCoadminUserId_crmContactId: {
          ownerCoadminUserId,
          crmContactId
        }
      }
    });
    if (!existing) {
      await tx.leaderboardPlayerStats.create({
        data: {
          workspaceId,
          ownerCoadminUserId,
          crmContactId,
          lifetimeQualifyingDepositCents: Math.max(0, deltaCents)
        }
      });
      return;
    }
    const next = existing.lifetimeQualifyingDepositCents + deltaCents;
    if (next < 0) throw new Error("lifetime qualifying deposits cannot go negative");
    await tx.leaderboardPlayerStats.update({
      where: { id: existing.id },
      data: { lifetimeQualifyingDepositCents: next, updatedAt: now }
    });
  }

  private async getOrCreateStandingTx(
    tx: Tx,
    workspaceId: string,
    ownerCoadminUserId: string,
    competitionId: string,
    crmContactId: string,
    now: Date
  ) {
    // Upsert avoids create→P2002→query-in-same-tx (25P02) under concurrency.
    return tx.leaderboardStanding.upsert({
      where: { competitionId_crmContactId: { competitionId, crmContactId } },
      create: {
        workspaceId,
        ownerCoadminUserId,
        competitionId,
        crmContactId,
        pointsReachedAt: now
      },
      update: { ownerCoadminUserId }
    });
  }

  /**
   * Idempotently ensures every participant for this owner has a zero-default standing
   * in the ACTIVE competition. Does not create events or alter existing point totals.
   */
  private async ensureZeroPointStandingsForOwnerTx(
    tx: Tx,
    workspaceId: string,
    ownerCoadminUserId: string,
    competitionId: string,
    now: Date
  ): Promise<void> {
    const participants = await tx.leaderboardParticipant.findMany({
      where: { workspaceId, ownerCoadminUserId },
      select: { crmContactId: true }
    });
    if (participants.length === 0) return;

    await tx.leaderboardStanding.createMany({
      data: participants.map((p) => ({
        workspaceId,
        ownerCoadminUserId,
        competitionId,
        crmContactId: p.crmContactId,
        pointsReachedAt: now
      })),
      skipDuplicates: true
    });
  }

  /** If leaderboard is enabled and an ACTIVE competition exists, ensure one zero standing. */
  private async ensureZeroStandingIfActiveTx(
    tx: Tx,
    workspaceId: string,
    ownerCoadminUserId: string,
    crmContactId: string,
    now: Date
  ): Promise<void> {
    const settings = await tx.leaderboardSettings.findUnique({ where: { ownerCoadminUserId } });
    if (!settings?.enabled || settings.workspaceId !== workspaceId) return;

    const competition = await tx.leaderboardCompetition.findFirst({
      where: {
        workspaceId,
        ownerCoadminUserId,
        status: "ACTIVE",
        startsAt: { lte: now },
        endsAt: { gt: now }
      }
    });
    if (!competition) return;

    await this.getOrCreateStandingTx(
      tx,
      workspaceId,
      ownerCoadminUserId,
      competition.id,
      crmContactId,
      now
    );
  }

  /**
   * Concurrent-safe settings init.
   * Uses upsert (INSERT … ON CONFLICT) — never create→catch P2002→query in the same tx
   * (PostgreSQL aborts the transaction on unique violation → 25P02 on recovery queries).
   */
  private async ensureSettingsTx(
    tx: Tx,
    workspaceId: string,
    ownerCoadminUserId: string,
    actorUserId?: string
  ) {
    const now = new Date();
    const settings = await tx.leaderboardSettings.upsert({
      where: { ownerCoadminUserId },
      create: {
        workspaceId,
        ownerCoadminUserId,
        enabled: false,
        poolRateBps: DEFAULT_POOL_RATE_BPS,
        timezone: LEADERBOARD_TIMEZONE,
        updatedByUserId: actorUserId ?? null
      },
      // No business-field mutation on conflict — preserve existing defaults/config.
      // Prisma requires a non-empty update; self-assign the unique key is a no-op.
      update: { ownerCoadminUserId }
    });
    if (settings.workspaceId !== workspaceId) throw ownerMismatch();

    const existingHistory = await tx.poolRateHistory.findFirst({
      where: { ownerCoadminUserId }
    });
    if (!existingHistory) {
      await tx.poolRateHistory.create({
        data: {
          workspaceId,
          ownerCoadminUserId,
          rateBps: DEFAULT_POOL_RATE_BPS,
          effectiveFrom: now,
          changedByUserId: actorUserId ?? null,
          reason: "initial_default"
        }
      });
    }
    return settings;
  }

  private async requireEnabledSettings(tx: Tx, workspaceId: string, ownerCoadminUserId: string) {
    const settings = await this.ensureSettingsTx(tx, workspaceId, ownerCoadminUserId);
    if (!settings.enabled) throw leaderboardDisabled();
    return settings;
  }

  private async resolveLeaderboardOwnerTx(tx: Tx, workspaceId: string, crmContactId: string): Promise<string> {
    const matches = await tx.leaderboardParticipant.findMany({
      where: { workspaceId, crmContactId }
    });
    if (matches.length === 0) throw participantNotBound();
    if (matches.length > 1) throw participantIntegrityError();
    return matches[0]!.ownerCoadminUserId;
  }

  private async requireCompetitionTx(tx: Tx, id: string, ownerCoadminUserId: string) {
    const row = await tx.leaderboardCompetition.findUnique({ where: { id } });
    if (!row) throw eventNotFound();
    if (row.ownerCoadminUserId !== ownerCoadminUserId) throw ownerMismatch();
    return row;
  }

  private async assertContact(workspaceId: string, crmContactId: string) {
    const contact = await this.prisma.crmContact.findFirst({ where: { id: crmContactId, workspaceId } });
    if (!contact) throw contactNotFound();
  }

  private async assertContactTx(tx: Tx, workspaceId: string, crmContactId: string) {
    const contact = await tx.crmContact.findFirst({ where: { id: crmContactId, workspaceId } });
    if (!contact) throw contactNotFound();
  }

  /** Advisory/row lock via raw SQL — required because Prisma lacks FOR UPDATE helpers. */
  private async lockWorkspace(tx: Tx, workspaceId: string): Promise<void> {
    await tx.$executeRaw`SELECT id FROM workspaces WHERE id = ${workspaceId}::uuid FOR UPDATE`;
  }

  private async lockCompetition(tx: Tx, competitionId: string): Promise<void> {
    await tx.$executeRaw`SELECT id FROM leaderboard_competitions WHERE id = ${competitionId}::uuid FOR UPDATE`;
  }

  private async lockContact(tx: Tx, crmContactId: string): Promise<void> {
    await tx.$executeRaw`SELECT id FROM crm_contacts WHERE id = ${crmContactId}::uuid FOR UPDATE`;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "P2002";
}

/** Exported for tests that need a stable uuid helper without importing node crypto directly. */
export function newLeaderboardId(): string {
  return randomUUID();
}
