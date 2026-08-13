import { createHash, randomUUID } from "node:crypto";
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
  idempotencyConflict,
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
  AuditRecord,
  BindParticipantInput,
  CompetitionRow,
  DepositInput,
  EligibilityCandidateRow,
  EventRow,
  FinalizeInput,
  LeaderboardParticipantRow,
  MarkPayoutInput,
  MilestoneAwardRow,
  OverrideReferralInput,
  PlayerStatsRow,
  PoolRateHistoryRow,
  PromotionAwardRow,
  PromotionInput,
  ReferralRow,
  ReverseDepositInput,
  ReversePromotionInput,
  ReconcileActiveDepositScoringInput,
  SetMembershipEligibilityInput,
  SetPoolRateInput,
  SetReferralInput,
  SnapshotRow,
  StandingRow,
  LeaderboardSettingsRow,
  PayoutRow,
  PrizeMembershipStatus
} from "./leaderboard.types";

type ContactRef = { id: string; workspaceId: string };

/**
 * In-memory transactional store used for Phase 1 domain tests and as the
 * behavioral reference implementation. Prisma adapter mirrors these operations.
 */
export class MemoryLeaderboardStore {
  /** Keyed by ownerCoadminUserId (unique per coadmin). */
  public settings = new Map<string, LeaderboardSettingsRow>();
  public participants: LeaderboardParticipantRow[] = [];
  public competitions: CompetitionRow[] = [];
  public events: EventRow[] = [];
  public standings: StandingRow[] = [];
  public referrals: ReferralRow[] = [];
  public playerStats: PlayerStatsRow[] = [];
  public milestones: MilestoneAwardRow[] = [];
  public promotions: PromotionAwardRow[] = [];
  public poolRateHistory: PoolRateHistoryRow[] = [];
  public snapshots: SnapshotRow[] = [];
  public payouts: PayoutRow[] = [];
  public eligibilityCandidates: EligibilityCandidateRow[] = [];
  public audits: AuditRecord[] = [];
  public contacts = new Map<string, ContactRef>();
  public idempotencyPayloads = new Map<string, string>();

  private readonly locks = new Map<string, Promise<void>>();

  public registerContact(id: string, workspaceId: string): void {
    this.contacts.set(id, { id, workspaceId });
  }

  public async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(
      key,
      previous.then(() => gate)
    );
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  public clone(): MemoryLeaderboardStore {
    const next = new MemoryLeaderboardStore();
    next.settings = new Map(this.settings);
    next.participants = this.participants.map((r) => ({ ...r }));
    next.competitions = this.competitions.map((r) => ({ ...r }));
    next.events = this.events.map((r) => ({ ...r, metadataJson: { ...r.metadataJson } }));
    next.standings = this.standings.map((r) => ({ ...r }));
    next.referrals = this.referrals.map((r) => ({ ...r }));
    next.playerStats = this.playerStats.map((r) => ({ ...r }));
    next.milestones = this.milestones.map((r) => ({ ...r }));
    next.promotions = this.promotions.map((r) => ({ ...r }));
    next.poolRateHistory = this.poolRateHistory.map((r) => ({ ...r }));
    next.snapshots = this.snapshots.map((r) => ({ ...r }));
    next.payouts = this.payouts.map((r) => ({ ...r }));
    next.eligibilityCandidates = this.eligibilityCandidates.map((r) => ({ ...r }));
    next.audits = this.audits.map((r) => ({ ...r, metadata: { ...r.metadata } }));
    next.contacts = new Map(this.contacts);
    next.idempotencyPayloads = new Map(this.idempotencyPayloads);
    return next;
  }
}

export interface LeaderboardServiceOptions {
  readonly random?: RandomSource;
  readonly requireEnabled?: boolean;
}

/**
 * Isolated Phase 1.2 leaderboard domain engine (per-coadmin ownership).
 * No Telegram, CRM assignment, inbox, or notification side effects.
 */
export class LeaderboardService {
  private readonly random: RandomSource;
  private readonly requireEnabled: boolean;

  public constructor(
    private readonly store: MemoryLeaderboardStore,
    options: LeaderboardServiceOptions = {}
  ) {
    this.random = options.random ?? createCryptoRandomSource();
    this.requireEnabled = options.requireEnabled ?? true;
  }

  public async bindParticipant(input: BindParticipantInput): Promise<LeaderboardParticipantRow> {
    this.assertContact(input.workspaceId, input.crmContactId);
    const now = input.now ?? new Date();
    return this.store.withLock(`participant:${input.workspaceId}:${input.crmContactId}`, async () => {
      const existing = this.store.participants.filter(
        (p) => p.workspaceId === input.workspaceId && p.crmContactId === input.crmContactId
      );
      if (existing.length > 1) throw participantIntegrityError();
      let row = existing[0];
      if (row) {
        if (row.ownerCoadminUserId !== input.ownerCoadminUserId) throw participantTransferUnsupported();
      } else {
        row = {
          id: randomUUID(),
          workspaceId: input.workspaceId,
          ownerCoadminUserId: input.ownerCoadminUserId,
          crmContactId: input.crmContactId,
          createdByUserId: input.createdByUserId ?? null,
          createdAt: now,
          updatedAt: now
        };
        this.store.participants.push(row);
        this.audit(input.workspaceId, input.createdByUserId ?? null, "leaderboard.participant_bound", {
          ownerCoadminUserId: input.ownerCoadminUserId,
          crmContactId: input.crmContactId
        });
      }

      this.ensureZeroStandingIfActive(
        input.workspaceId,
        input.ownerCoadminUserId,
        input.crmContactId,
        now
      );
      return row;
    });
  }

  public resolveLeaderboardOwner(workspaceId: string, crmContactId: string): string {
    const matches = this.store.participants.filter(
      (p) => p.workspaceId === workspaceId && p.crmContactId === crmContactId
    );
    if (matches.length === 0) throw participantNotBound();
    if (matches.length > 1) throw participantIntegrityError();
    return matches[0]!.ownerCoadminUserId;
  }

  public async ensureSettings(
    workspaceId: string,
    ownerCoadminUserId: string,
    actorUserId?: string
  ): Promise<LeaderboardSettingsRow> {
    const existing = this.store.settings.get(ownerCoadminUserId);
    if (existing) {
      if (existing.workspaceId !== workspaceId) throw ownerMismatch();
      return existing;
    }
    const now = new Date();
    const row: LeaderboardSettingsRow = {
      id: randomUUID(),
      workspaceId,
      ownerCoadminUserId,
      enabled: false,
      poolRateBps: DEFAULT_POOL_RATE_BPS,
      timezone: LEADERBOARD_TIMEZONE,
      updatedByUserId: actorUserId ?? null,
      createdAt: now,
      updatedAt: now
    };
    this.store.settings.set(ownerCoadminUserId, row);
    this.store.poolRateHistory.push({
      id: randomUUID(),
      workspaceId,
      ownerCoadminUserId,
      competitionId: null,
      rateBps: DEFAULT_POOL_RATE_BPS,
      effectiveFrom: now,
      changedByUserId: actorUserId ?? null,
      reason: "initial_default",
      createdAt: now
    });
    return row;
  }

  public async setEnabled(
    workspaceId: string,
    ownerCoadminUserId: string,
    enabled: boolean,
    actorUserId: string,
    now = new Date()
  ): Promise<LeaderboardSettingsRow> {
    const settings = await this.ensureSettings(workspaceId, ownerCoadminUserId, actorUserId);
    const updated = { ...settings, enabled, updatedByUserId: actorUserId, updatedAt: now };
    this.store.settings.set(ownerCoadminUserId, updated);
    this.audit(workspaceId, actorUserId, enabled ? "leaderboard.enabled" : "leaderboard.disabled", {
      ownerCoadminUserId
    });

    if (enabled) {
      const competition = await this.ensureCurrentCompetition(workspaceId, ownerCoadminUserId, now);
      this.ensureZeroPointStandingsForOwner(workspaceId, ownerCoadminUserId, competition.id, now);
    }

    return updated;
  }

  public async setPoolRate(input: SetPoolRateInput): Promise<LeaderboardSettingsRow> {
    assertAllowedPoolRate(input.poolRateBps);
    const now = input.now ?? new Date();
    return this.store.withLock(`settings:${input.ownerCoadminUserId}`, async () => {
      const settings = await this.ensureSettings(input.workspaceId, input.ownerCoadminUserId, input.actorUserId);
      if (settings.poolRateBps === input.poolRateBps) return settings;
      const competition = await this.ensureCurrentCompetition(input.workspaceId, input.ownerCoadminUserId, now, {
        skipEnabledCheck: true
      });
      const updated = {
        ...settings,
        poolRateBps: input.poolRateBps,
        updatedByUserId: input.actorUserId,
        updatedAt: now
      };
      this.store.settings.set(input.ownerCoadminUserId, updated);
      this.store.poolRateHistory.push({
        id: randomUUID(),
        workspaceId: input.workspaceId,
        ownerCoadminUserId: input.ownerCoadminUserId,
        competitionId: competition.id,
        rateBps: input.poolRateBps,
        effectiveFrom: now,
        changedByUserId: input.actorUserId,
        reason: input.reason ?? null,
        createdAt: now
      });
      this.audit(input.workspaceId, input.actorUserId, "leaderboard.pool_rate_changed", {
        ownerCoadminUserId: input.ownerCoadminUserId,
        from: settings.poolRateBps,
        to: input.poolRateBps,
        reason: input.reason ?? null
      });
      return updated;
    });
  }

  /**
   * Self-healing competition resolver. Freezes ONLY this owner's expired ACTIVE competitions
   * and opens the window for `now`.
   */
  public async ensureCurrentCompetition(
    workspaceId: string,
    ownerCoadminUserId: string,
    now = new Date(),
    options: { skipEnabledCheck?: boolean } = {}
  ): Promise<CompetitionRow> {
    return this.store.withLock(`competition:${ownerCoadminUserId}`, async () => {
      await this.ensureSettings(workspaceId, ownerCoadminUserId);
      if (!options.skipEnabledCheck) this.assertEnabled(ownerCoadminUserId);

      const expired = this.store.competitions.filter(
        (c) =>
          c.workspaceId === workspaceId &&
          c.ownerCoadminUserId === ownerCoadminUserId &&
          c.status === "ACTIVE" &&
          c.endsAt.getTime() <= now.getTime()
      );
      for (const competition of expired) {
        await this.freezeCompetitionLocked(competition, now);
      }

      const window = competitionWindowContaining(now);
      const existing = this.store.competitions.find(
        (c) =>
          c.ownerCoadminUserId === ownerCoadminUserId &&
          c.sequence === window.sequence &&
          isInCompetitionWindow(now, c.startsAt, c.endsAt)
      );
      if (existing) {
        if (existing.workspaceId !== workspaceId) throw ownerMismatch();
        if (existing.status === "SCHEDULED") {
          existing.status = "ACTIVE";
          existing.updatedAt = now;
        }
        if (existing.status === "ACTIVE") return existing;
      }

      const active = this.store.competitions.find(
        (c) =>
          c.ownerCoadminUserId === ownerCoadminUserId &&
          c.status === "ACTIVE" &&
          isInCompetitionWindow(now, c.startsAt, c.endsAt)
      );
      if (active) {
        if (active.workspaceId !== workspaceId) throw ownerMismatch();
        return active;
      }

      const created: CompetitionRow = {
        id: randomUUID(),
        workspaceId,
        ownerCoadminUserId,
        sequence: window.sequence,
        startsAt: window.startsAt,
        endsAt: window.endsAt,
        status: "ACTIVE",
        prizePoolCents: 0,
        frozenAt: null,
        finalizedAt: null,
        finalizedByUserId: null,
        finalizationIdempotencyKey: null,
        createdAt: now,
        updatedAt: now
      };
      this.store.competitions.push(created);
      return created;
    });
  }

  public async recordDeposit(input: DepositInput): Promise<EventRow> {
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw invalidDepositAmount();
    const now = input.now ?? new Date();
    const payloadHash = hashPayload({
      op: "deposit",
      contact: input.crmContactId,
      amount: input.amountCents
    });

    return this.store.withLock(`player:${input.workspaceId}:${input.crmContactId}`, async () => {
      const existing = this.findEventByIdempotency(input.idempotencyKey);
      if (existing) {
        this.assertIdempotentPayload(input.idempotencyKey, payloadHash);
        return existing;
      }
      this.assertContact(input.workspaceId, input.crmContactId);
      const ownerCoadminUserId = this.resolveLeaderboardOwner(input.workspaceId, input.crmContactId);
      this.assertEnabled(ownerCoadminUserId);
      const settings = await this.ensureSettings(input.workspaceId, ownerCoadminUserId);
      const competition = await this.ensureCurrentCompetition(input.workspaceId, ownerCoadminUserId, now);

      const standing = this.getOrCreateStanding(
        input.workspaceId,
        ownerCoadminUserId,
        competition.id,
        input.crmContactId,
        now
      );
      const prevDepositPoints = standing.depositPoints;
      const nextCents = standing.qualifyingDepositCents + input.amountCents;
      const nextDepositPoints = depositPointsFromCumulativeCents(nextCents);
      const pointsDelta = nextDepositPoints - prevDepositPoints;
      const contribution = poolContributionCents(input.amountCents, settings.poolRateBps);

      const event = this.createEvent({
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
      });
      this.store.idempotencyPayloads.set(input.idempotencyKey, payloadHash);

      standing.qualifyingDepositCents = nextCents;
      standing.depositPoints = nextDepositPoints;
      this.applyPointsDelta(standing, pointsDelta, now, event);

      competition.prizePoolCents += contribution;
      competition.updatedAt = now;

      this.bumpLifetime(input.workspaceId, ownerCoadminUserId, input.crmContactId, input.amountCents, now);
      await this.syncReferralMilestonesForReferred(
        input.workspaceId,
        ownerCoadminUserId,
        input.crmContactId,
        now,
        input.actorUserId
      );

      this.audit(input.workspaceId, input.actorUserId, "leaderboard.deposit", {
        eventId: event.id,
        ownerCoadminUserId,
        amountCents: input.amountCents,
        pointsDelta,
        poolContributionCents: contribution,
        competitionId: competition.id
      });
      return event;
    });
  }

  public async reverseDeposit(input: ReverseDepositInput): Promise<EventRow> {
    const now = input.now ?? new Date();
    const payloadHash = hashPayload({ op: "reverse_deposit", eventId: input.depositEventId });

    return this.store.withLock(`event:${input.depositEventId}`, async () => {
      const existing = this.findEventByIdempotency(input.idempotencyKey);
      if (existing) {
        this.assertIdempotentPayload(input.idempotencyKey, payloadHash);
        return existing;
      }

      const original = this.store.events.find((e) => e.id === input.depositEventId && e.workspaceId === input.workspaceId);
      if (!original) throw eventNotFound();
      if (original.type !== "DEPOSIT") throw invalidEventType("DEPOSIT");
      if (this.store.events.some((e) => e.reversesEventId === original.id)) throw eventAlreadyReversed();

      const ownerCoadminUserId = original.ownerCoadminUserId;
      this.assertEnabled(ownerCoadminUserId);
      const amount = original.depositAmountCents ?? 0;
      const contribution = original.poolContributionCents ?? 0;

      return this.store.withLock(`player:${input.workspaceId}:${original.crmContactId}`, async () => {
        const competition = this.requireCompetition(original.competitionId, ownerCoadminUserId);
        const standing = this.getOrCreateStanding(
          input.workspaceId,
          ownerCoadminUserId,
          competition.id,
          original.crmContactId,
          now
        );
        const prevDepositPoints = standing.depositPoints;
        const nextCents = standing.qualifyingDepositCents - amount;
        if (nextCents < 0) throw new Error("qualifying deposits cannot go negative");
        const nextDepositPoints = depositPointsFromCumulativeCents(nextCents);
        const pointsDelta = nextDepositPoints - prevDepositPoints;

        const event = this.createEvent({
          workspaceId: input.workspaceId,
          ownerCoadminUserId,
          competitionId: competition.id,
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
        });
        this.store.idempotencyPayloads.set(input.idempotencyKey, payloadHash);

        standing.qualifyingDepositCents = nextCents;
        standing.depositPoints = nextDepositPoints;
        this.applyPointsDelta(standing, pointsDelta, now, event);
        competition.prizePoolCents -= contribution;
        competition.updatedAt = now;

        this.bumpLifetime(input.workspaceId, ownerCoadminUserId, original.crmContactId, -amount, now);
        await this.syncReferralMilestonesForReferred(
          input.workspaceId,
          ownerCoadminUserId,
          original.crmContactId,
          now,
          input.actorUserId
        );

        this.audit(input.workspaceId, input.actorUserId, "leaderboard.deposit_reversal", {
          eventId: event.id,
          ownerCoadminUserId,
          reversesEventId: original.id,
          amountCents: amount,
          poolContributionCents: contribution
        });
        return event;
      });
    });
  }

  public async setReferral(input: SetReferralInput): Promise<ReferralRow> {
    if (input.referrerCrmContactId === input.referredCrmContactId) throw selfReferralForbidden();
    const now = input.now ?? new Date();
    const payloadHash = hashPayload({
      op: "set_referral",
      referrer: input.referrerCrmContactId,
      referred: input.referredCrmContactId
    });

    return this.store.withLock(`referral:${input.workspaceId}:${input.referredCrmContactId}`, async () => {
      const existingIdem = this.store.idempotencyPayloads.get(input.idempotencyKey);
      if (existingIdem) {
        this.assertIdempotentPayload(input.idempotencyKey, payloadHash);
        const ownerCoadminUserId = this.resolveLeaderboardOwner(input.workspaceId, input.referredCrmContactId);
        const row = this.store.referrals.find(
          (r) =>
            r.ownerCoadminUserId === ownerCoadminUserId && r.referredCrmContactId === input.referredCrmContactId
        );
        if (!row) throw referralNotFound();
        return row;
      }

      this.assertContact(input.workspaceId, input.referrerCrmContactId);
      this.assertContact(input.workspaceId, input.referredCrmContactId);
      const ownerCoadminUserId = this.resolveLeaderboardOwner(input.workspaceId, input.referredCrmContactId);
      const referrerOwner = this.resolveLeaderboardOwner(input.workspaceId, input.referrerCrmContactId);
      if (referrerOwner !== ownerCoadminUserId) throw ownerMismatch();
      this.assertEnabled(ownerCoadminUserId);
      if (
        this.store.referrals.some(
          (r) => r.ownerCoadminUserId === ownerCoadminUserId && r.referredCrmContactId === input.referredCrmContactId
        )
      ) {
        throw referralAlreadyExists();
      }

      const row: ReferralRow = {
        id: randomUUID(),
        workspaceId: input.workspaceId,
        ownerCoadminUserId,
        referrerCrmContactId: input.referrerCrmContactId,
        referredCrmContactId: input.referredCrmContactId,
        createdByUserId: input.actorUserId,
        originalReferrerCrmContactId: input.referrerCrmContactId,
        overriddenAt: null,
        overriddenByUserId: null,
        overrideReason: null,
        createdAt: now,
        updatedAt: now
      };
      this.store.referrals.push(row);
      this.store.idempotencyPayloads.set(input.idempotencyKey, payloadHash);
      await this.ensureCurrentCompetition(input.workspaceId, ownerCoadminUserId, now);
      await this.syncReferralMilestonesForReferred(
        input.workspaceId,
        ownerCoadminUserId,
        input.referredCrmContactId,
        now,
        input.actorUserId
      );
      this.audit(input.workspaceId, input.actorUserId, "leaderboard.referral_set", {
        referralId: row.id,
        ownerCoadminUserId,
        referrerCrmContactId: row.referrerCrmContactId,
        referredCrmContactId: row.referredCrmContactId
      });
      return row;
    });
  }

  public async overrideReferral(input: OverrideReferralInput): Promise<ReferralRow> {
    if (input.newReferrerCrmContactId === input.referredCrmContactId) throw selfReferralForbidden();
    const now = input.now ?? new Date();
    const payloadHash = hashPayload({
      op: "override_referral",
      referred: input.referredCrmContactId,
      referrer: input.newReferrerCrmContactId,
      reason: input.reason
    });

    return this.store.withLock(`referral:${input.workspaceId}:${input.referredCrmContactId}`, async () => {
      const existingIdem = this.store.idempotencyPayloads.get(input.idempotencyKey);
      if (existingIdem) {
        this.assertIdempotentPayload(input.idempotencyKey, payloadHash);
        const ownerCoadminUserId = this.resolveLeaderboardOwner(input.workspaceId, input.referredCrmContactId);
        const row = this.store.referrals.find(
          (r) =>
            r.ownerCoadminUserId === ownerCoadminUserId && r.referredCrmContactId === input.referredCrmContactId
        );
        if (!row) throw referralNotFound();
        return row;
      }

      this.assertContact(input.workspaceId, input.newReferrerCrmContactId);
      this.assertContact(input.workspaceId, input.referredCrmContactId);
      const ownerCoadminUserId = this.resolveLeaderboardOwner(input.workspaceId, input.referredCrmContactId);
      const newReferrerOwner = this.resolveLeaderboardOwner(input.workspaceId, input.newReferrerCrmContactId);
      if (newReferrerOwner !== ownerCoadminUserId) throw ownerMismatch();
      this.assertEnabled(ownerCoadminUserId);
      const row = this.store.referrals.find(
        (r) => r.ownerCoadminUserId === ownerCoadminUserId && r.referredCrmContactId === input.referredCrmContactId
      );
      if (!row) throw referralNotFound();

      const previous = row.referrerCrmContactId;
      if (!row.originalReferrerCrmContactId) row.originalReferrerCrmContactId = previous;
      row.referrerCrmContactId = input.newReferrerCrmContactId;
      row.overriddenAt = now;
      row.overriddenByUserId = input.actorUserId;
      row.overrideReason = input.reason;
      row.updatedAt = now;
      this.store.idempotencyPayloads.set(input.idempotencyKey, payloadHash);

      await this.ensureCurrentCompetition(input.workspaceId, ownerCoadminUserId, now);
      await this.syncReferralMilestonesForReferred(
        input.workspaceId,
        ownerCoadminUserId,
        input.referredCrmContactId,
        now,
        input.actorUserId
      );

      this.audit(input.workspaceId, input.actorUserId, "leaderboard.referral_override", {
        referralId: row.id,
        ownerCoadminUserId,
        previousReferrerCrmContactId: previous,
        newReferrerCrmContactId: input.newReferrerCrmContactId,
        reason: input.reason
      });
      return row;
    });
  }

  public async recordPromotion(input: PromotionInput): Promise<EventRow> {
    const now = input.now ?? new Date();
    const payloadHash = hashPayload({ op: "promotion", contact: input.crmContactId });

    return this.store.withLock(`player:${input.workspaceId}:${input.crmContactId}`, async () => {
      const existing = this.findEventByIdempotency(input.idempotencyKey);
      if (existing) {
        this.assertIdempotentPayload(input.idempotencyKey, payloadHash);
        return existing;
      }
      this.assertContact(input.workspaceId, input.crmContactId);
      const ownerCoadminUserId = this.resolveLeaderboardOwner(input.workspaceId, input.crmContactId);
      this.assertEnabled(ownerCoadminUserId);
      const competition = await this.ensureCurrentCompetition(input.workspaceId, ownerCoadminUserId, now);
      const prior = this.store.promotions
        .filter(
          (p) =>
            p.ownerCoadminUserId === ownerCoadminUserId && p.crmContactId === input.crmContactId
        )
        .map((p) => p.createdAt);
      const points = resolvePromotionPoints(prior, now, this.random);

      const event = this.createEvent({
        workspaceId: input.workspaceId,
        ownerCoadminUserId,
        competitionId: competition.id,
        crmContactId: input.crmContactId,
        type: "PROMOTION",
        pointsDelta: points,
        depositAmountCents: null,
        poolContributionCents: null,
        poolRateBpsApplied: null,
        actorUserId: input.actorUserId,
        reason: input.reason ?? "promotion",
        metadataJson: { points },
        occurredAt: now,
        idempotencyKey: input.idempotencyKey
      });
      this.store.idempotencyPayloads.set(input.idempotencyKey, payloadHash);
      this.store.promotions.push({
        id: randomUUID(),
        workspaceId: input.workspaceId,
        ownerCoadminUserId,
        competitionId: competition.id,
        crmContactId: input.crmContactId,
        points,
        eventId: event.id,
        actorUserId: input.actorUserId,
        idempotencyKey: input.idempotencyKey,
        createdAt: now
      });

      const standing = this.getOrCreateStanding(
        input.workspaceId,
        ownerCoadminUserId,
        competition.id,
        input.crmContactId,
        now
      );
      standing.promotionPoints += points;
      this.applyPointsDelta(standing, points, now, event);

      this.audit(input.workspaceId, input.actorUserId, "leaderboard.promotion", {
        eventId: event.id,
        ownerCoadminUserId,
        points,
        competitionId: competition.id
      });
      return event;
    });
  }

  public async reversePromotion(input: ReversePromotionInput): Promise<EventRow> {
    const now = input.now ?? new Date();
    const payloadHash = hashPayload({ op: "reverse_promotion", eventId: input.promotionEventId });

    return this.store.withLock(`event:${input.promotionEventId}`, async () => {
      const existing = this.findEventByIdempotency(input.idempotencyKey);
      if (existing) {
        this.assertIdempotentPayload(input.idempotencyKey, payloadHash);
        return existing;
      }
      const original = this.store.events.find((e) => e.id === input.promotionEventId && e.workspaceId === input.workspaceId);
      if (!original) throw eventNotFound();
      if (original.type !== "PROMOTION") throw invalidEventType("PROMOTION");
      if (this.store.events.some((e) => e.reversesEventId === original.id)) throw eventAlreadyReversed();
      const ownerCoadminUserId = original.ownerCoadminUserId;
      this.assertEnabled(ownerCoadminUserId);

      return this.store.withLock(`player:${input.workspaceId}:${original.crmContactId}`, async () => {
        const points = original.pointsDelta;
        const event = this.createEvent({
          workspaceId: input.workspaceId,
          ownerCoadminUserId,
          competitionId: original.competitionId,
          crmContactId: original.crmContactId,
          type: "PROMOTION_REVERSAL",
          pointsDelta: -points,
          depositAmountCents: null,
          poolContributionCents: null,
          poolRateBpsApplied: null,
          actorUserId: input.actorUserId,
          reason: input.reason ?? "promotion_reversal",
          metadataJson: { reversesEventId: original.id },
          occurredAt: now,
          idempotencyKey: input.idempotencyKey,
          reversesEventId: original.id
        });
        this.store.idempotencyPayloads.set(input.idempotencyKey, payloadHash);
        const standing = this.getOrCreateStanding(
          input.workspaceId,
          ownerCoadminUserId,
          original.competitionId,
          original.crmContactId,
          now
        );
        standing.promotionPoints -= points;
        this.applyPointsDelta(standing, -points, now, event);
        this.audit(input.workspaceId, input.actorUserId, "leaderboard.promotion_reversal", {
          eventId: event.id,
          ownerCoadminUserId,
          reversesEventId: original.id,
          points
        });
        return event;
      });
    });
  }

  public async finalizeCompetition(input: FinalizeInput): Promise<CompetitionRow> {
    const now = input.now ?? new Date();
    return this.store.withLock(`competition:${input.ownerCoadminUserId}`, async () => {
      const byKey = this.store.competitions.find((c) => c.finalizationIdempotencyKey === input.idempotencyKey);
      if (byKey) {
        if (byKey.ownerCoadminUserId !== input.ownerCoadminUserId) throw ownerMismatch();
        return byKey;
      }

      const competition = this.requireCompetition(input.competitionId, input.ownerCoadminUserId);
      if (competition.workspaceId !== input.workspaceId) throw ownerMismatch();
      if (competition.status === "FINALIZED") {
        if (competition.finalizationIdempotencyKey && competition.finalizationIdempotencyKey !== input.idempotencyKey) {
          throw competitionAlreadyFinalized();
        }
        competition.finalizationIdempotencyKey = input.idempotencyKey;
        return competition;
      }
      if (competition.status !== "FROZEN") throw competitionNotFrozen();

      const snapshot = this.store.snapshots.find((s) => s.competitionId === competition.id);
      if (!snapshot) throw eventNotFound();

      const candidates = this.store.eligibilityCandidates
        .filter((c) => c.competitionId === competition.id)
        .sort((a, b) => a.leaderboardRank - b.leaderboardRank);
      const selection = selectPrizeWinnersFromEligibility(candidates);
      if (!selection.ok) {
        throw pendingReviewBlocksFinalize(selection.pendingCrmContactIds);
      }

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
        snapshot.winnersJson = winnersPayload;
        snapshot.winnersLockedAt = now;
        for (const winner of winnersPayload) {
          this.store.payouts.push({
            id: randomUUID(),
            workspaceId: competition.workspaceId,
            ownerCoadminUserId: competition.ownerCoadminUserId,
            competitionId: competition.id,
            prizeRank: winner.prizeRank,
            leaderboardRank: winner.leaderboardRank,
            crmContactId: winner.crmContactId,
            points: winner.totalPoints,
            payoutCents: winner.payoutCents,
            status: "UNPAID",
            paidAt: null,
            paidByUserId: null,
            notes: null,
            createdAt: now,
            updatedAt: now
          });
        }
      }

      competition.status = "FINALIZED";
      competition.finalizedAt = now;
      competition.finalizedByUserId = input.actorUserId;
      competition.finalizationIdempotencyKey = input.idempotencyKey;
      competition.updatedAt = now;
      this.audit(input.workspaceId, input.actorUserId, "leaderboard.competition_finalized", {
        competitionId: competition.id,
        ownerCoadminUserId: input.ownerCoadminUserId,
        winners: winnersPayload
      });
      return competition;
    });
  }

  public async setMembershipEligibility(input: SetMembershipEligibilityInput): Promise<EligibilityCandidateRow> {
    const allowed: PrizeMembershipStatus[] = ["ELIGIBLE", "NOT_ELIGIBLE", "PENDING_REVIEW"];
    if (!allowed.includes(input.membershipStatus)) throw invalidMembershipStatus();
    const now = input.now ?? new Date();
    const source = input.verificationSource ?? "MANUAL";
    const payloadHash = hashPayload({
      op: "set_membership",
      competitionId: input.competitionId,
      contact: input.crmContactId,
      status: input.membershipStatus,
      reason: input.reason ?? null,
      ineligibilityReason: input.ineligibilityReason ?? null,
      verificationSource: source
    });

    return this.store.withLock(`competition:${input.ownerCoadminUserId}`, async () => {
      const existingIdem = this.store.idempotencyPayloads.get(input.idempotencyKey);
      if (existingIdem) {
        this.assertIdempotentPayload(input.idempotencyKey, payloadHash);
        const row = this.store.eligibilityCandidates.find(
          (c) => c.competitionId === input.competitionId && c.crmContactId === input.crmContactId
        );
        if (!row) throw candidateNotFound();
        return row;
      }

      const competition = this.requireCompetition(input.competitionId, input.ownerCoadminUserId);
      if (competition.workspaceId !== input.workspaceId) throw ownerMismatch();
      if (competition.status === "FINALIZED") throw eligibilityLocked();
      if (competition.status !== "FROZEN") throw competitionNotFrozen();

      const candidate = this.store.eligibilityCandidates.find(
        (c) => c.competitionId === input.competitionId && c.crmContactId === input.crmContactId
      );
      if (!candidate) throw candidateNotFound();
      if (candidate.ownerCoadminUserId !== input.ownerCoadminUserId) throw ownerMismatch();

      const isBotApiTerminal =
        candidate.verificationSource === "TELEGRAM_BOT_API" &&
        (candidate.membershipStatus === "ELIGIBLE" || candidate.membershipStatus === "NOT_ELIGIBLE");
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

      candidate.membershipStatus = input.membershipStatus;
      candidate.ineligibilityReason =
        input.membershipStatus === "NOT_ELIGIBLE" ? (input.ineligibilityReason ?? null) : null;
      candidate.resolvedAt = now;
      candidate.resolvedByUserId = input.actorUserId;
      candidate.resolutionReason = input.reason ?? null;
      candidate.verificationSource = source;
      candidate.telegramChatMemberStatus =
        input.telegramChatMemberStatus !== undefined
          ? input.telegramChatMemberStatus
          : source === "MANUAL"
            ? null
            : candidate.telegramChatMemberStatus;
      candidate.verifiedChannelId =
        input.verifiedChannelId !== undefined ? input.verifiedChannelId : candidate.verifiedChannelId;
      candidate.botIntegrationId =
        input.botIntegrationId !== undefined ? input.botIntegrationId : candidate.botIntegrationId;
      candidate.verificationCheckedAt = now;
      candidate.verificationErrorCode =
        input.verificationErrorCode !== undefined
          ? input.verificationErrorCode
          : source === "MANUAL"
            ? null
            : candidate.verificationErrorCode;
      candidate.verificationErrorMessage =
        input.verificationErrorMessage !== undefined
          ? input.verificationErrorMessage
          : source === "MANUAL"
            ? null
            : candidate.verificationErrorMessage;
      candidate.updatedAt = now;
      this.store.idempotencyPayloads.set(input.idempotencyKey, payloadHash);
      this.audit(input.workspaceId, input.actorUserId, "leaderboard.membership_eligibility_set", {
        competitionId: input.competitionId,
        ownerCoadminUserId: input.ownerCoadminUserId,
        crmContactId: input.crmContactId,
        membershipStatus: input.membershipStatus,
        ineligibilityReason: candidate.ineligibilityReason,
        reason: input.reason ?? null,
        verificationSource: source
      });
      return candidate;
    });
  }

  public async markPayout(input: MarkPayoutInput): Promise<PayoutRow> {
    const now = input.now ?? new Date();
    const payloadHash = hashPayload({
      op: "mark_payout",
      payoutId: input.payoutId,
      status: input.status,
      notes: input.notes ?? null
    });

    return this.store.withLock(`payout:${input.payoutId}`, async () => {
      const existingIdem = this.store.idempotencyPayloads.get(input.idempotencyKey);
      if (existingIdem) {
        this.assertIdempotentPayload(input.idempotencyKey, payloadHash);
        const byIdem = this.store.payouts.find((p) => p.id === input.payoutId);
        if (!byIdem) throw payoutNotFound();
        return byIdem;
      }

      const payout = this.store.payouts.find((p) => p.id === input.payoutId);
      if (!payout) throw payoutNotFound();
      if (payout.workspaceId !== input.workspaceId) throw ownerMismatch();
      if (payout.ownerCoadminUserId !== input.ownerCoadminUserId) throw ownerMismatch();

      const competition = this.requireCompetition(payout.competitionId, input.ownerCoadminUserId);
      if (competition.status !== "FINALIZED") throw competitionNotFinalized();

      if (payout.status === input.status) {
        this.store.idempotencyPayloads.set(input.idempotencyKey, payloadHash);
        return payout;
      }
      if (payout.status === "PAID" || payout.status === "VOID") {
        throw payoutAlreadySettled();
      }

      payout.status = input.status;
      payout.notes = input.notes ?? payout.notes;
      payout.updatedAt = now;
      if (input.status === "PAID") {
        payout.paidAt = now;
        payout.paidByUserId = input.actorUserId;
      } else {
        payout.paidAt = null;
        payout.paidByUserId = null;
      }

      this.store.idempotencyPayloads.set(input.idempotencyKey, payloadHash);
      this.audit(input.workspaceId, input.actorUserId, "leaderboard.payout_marked", {
        payoutId: payout.id,
        competitionId: payout.competitionId,
        ownerCoadminUserId: input.ownerCoadminUserId,
        status: input.status,
        notes: input.notes ?? null,
        idempotencyKey: input.idempotencyKey
      });
      return payout;
    });
  }

  /**
   * One-time / idempotent ACTIVE-competition deposit score migration to $1 = 1 point.
   * Does not mutate historical DEPOSIT events, pool contributions, referrals, promotions,
   * or any FROZEN/FINALIZED competition.
   */
  public async reconcileActiveDepositScoring(
    input: ReconcileActiveDepositScoringInput
  ): Promise<DepositScoringReconciliationResult> {
    const now = input.now ?? new Date();
    return this.store.withLock(`reconcile-deposit-v2:${input.ownerCoadminUserId}`, async () => {
      const competitions = this.store.competitions.filter((c) => {
        if (c.ownerCoadminUserId !== input.ownerCoadminUserId) return false;
        if (c.status !== "ACTIVE") return false;
        if (input.competitionId && c.id !== input.competitionId) return false;
        return true;
      });

      if (input.competitionId) {
        const target = this.store.competitions.find((c) => c.id === input.competitionId);
        if (!target) throw eventNotFound();
        if (target.ownerCoadminUserId !== input.ownerCoadminUserId) throw ownerMismatch();
        if (target.status !== "ACTIVE") {
          return emptyReconcileResult();
        }
      }

      const adjustments: DepositScoringReconciliationAdjustment[] = [];
      let playersVisited = 0;
      let playersAdjusted = 0;
      let playersAlreadyCorrect = 0;
      let playersSkippedIdempotent = 0;

      for (const competition of competitions) {
        const contactIds = new Set<string>();
        for (const standing of this.store.standings) {
          if (
            standing.competitionId === competition.id &&
            standing.ownerCoadminUserId === competition.ownerCoadminUserId
          ) {
            contactIds.add(standing.crmContactId);
          }
        }
        for (const event of this.store.events) {
          if (
            event.competitionId === competition.id &&
            event.ownerCoadminUserId === competition.ownerCoadminUserId &&
            (event.type === "DEPOSIT" || event.type === "DEPOSIT_REVERSAL")
          ) {
            contactIds.add(event.crmContactId);
          }
        }

        for (const crmContactId of contactIds) {
          playersVisited += 1;
          const idempotencyKey = depositScoringReconciliationIdempotencyKey(competition.id, crmContactId);
          const existing = this.findEventByIdempotency(idempotencyKey);
          if (existing) {
            playersSkippedIdempotent += 1;
            adjustments.push({
              competitionId: competition.id,
              ownerCoadminUserId: competition.ownerCoadminUserId,
              crmContactId,
              qualifyingDepositCents: validQualifyingDepositCentsFromLedger(
                this.store.events.filter(
                  (e) => e.competitionId === competition.id && e.crmContactId === crmContactId
                )
              ),
              fromDepositPoints: existing.metadataJson.fromDepositPoints as number,
              toDepositPoints: existing.metadataJson.toDepositPoints as number,
              pointsDelta: 0,
              alreadyReconciled: true
            });
            continue;
          }

          const ledgerEvents = this.store.events.filter(
            (e) =>
              e.competitionId === competition.id &&
              e.crmContactId === crmContactId &&
              e.ownerCoadminUserId === competition.ownerCoadminUserId
          );
          const qualifyingDepositCents = validQualifyingDepositCentsFromLedger(ledgerEvents);
          const correctDepositPoints = correctDepositPointsFromLedger(ledgerEvents);
          const standing = this.getOrCreateStanding(
            competition.workspaceId,
            competition.ownerCoadminUserId,
            competition.id,
            crmContactId,
            now
          );
          const fromDepositPoints = standing.depositPoints;
          const pointsDelta = correctDepositPoints - fromDepositPoints;

          standing.qualifyingDepositCents = qualifyingDepositCents;
          standing.depositPoints = correctDepositPoints;
          standing.totalPoints =
            correctDepositPoints +
            standing.referralPoints +
            standing.promotionPoints +
            standing.wheelPoints;
          standing.pointsReachedAt = reconstructPointsReachedAt({
            events: ledgerEvents,
            correctDepositPoints,
            referralPoints: standing.referralPoints,
            promotionPoints: standing.promotionPoints,
            wheelPoints: standing.wheelPoints,
            fallback: standing.pointsReachedAt
          });

          const event = this.createEvent({
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
          });
          this.store.idempotencyPayloads.set(
            idempotencyKey,
            hashPayload({
              op: DEPOSIT_SCORING_RECONCILIATION_REASON,
              competitionId: competition.id,
              crmContactId,
              toDepositPoints: correctDepositPoints
            })
          );

          standing.lastEventId = event.id;
          standing.lastEventAt = now;
          standing.lastEventType = event.type;
          standing.lastEventReason = event.reason;
          standing.updatedAt = now;

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

      this.audit(null, input.actorUserId ?? null, "leaderboard.active_deposit_scoring_reconciled", {
        ownerCoadminUserId: input.ownerCoadminUserId,
        competitionId: input.competitionId ?? null,
        competitionsProcessed: competitions.length,
        playersVisited,
        playersAdjusted,
        playersAlreadyCorrect,
        playersSkippedIdempotent
      });

      return {
        competitionsProcessed: competitions.length,
        playersVisited,
        playersAdjusted,
        playersAlreadyCorrect,
        playersSkippedIdempotent,
        adjustments
      };
    });
  }

  public listStandings(competitionId: string): StandingRow[] {
    return sortStandings(this.store.standings.filter((s) => s.competitionId === competitionId));
  }

  public listEventsForOwner(ownerCoadminUserId: string): EventRow[] {
    return this.store.events.filter((e) => e.ownerCoadminUserId === ownerCoadminUserId);
  }

  public getCompetition(competitionId: string): CompetitionRow | undefined {
    return this.store.competitions.find((c) => c.id === competitionId);
  }

  public getSnapshot(competitionId: string): SnapshotRow | undefined {
    return this.store.snapshots.find((s) => s.competitionId === competitionId);
  }

  public getPayouts(competitionId: string): PayoutRow[] {
    return this.store.payouts.filter((p) => p.competitionId === competitionId).sort((a, b) => a.prizeRank - b.prizeRank);
  }

  public getEligibilityCandidates(competitionId: string): EligibilityCandidateRow[] {
    return this.store.eligibilityCandidates
      .filter((c) => c.competitionId === competitionId)
      .sort((a, b) => a.leaderboardRank - b.leaderboardRank);
  }

  public getLifetimeCents(ownerCoadminUserId: string, crmContactId: string): number {
    return (
      this.store.playerStats.find(
        (p) => p.ownerCoadminUserId === ownerCoadminUserId && p.crmContactId === crmContactId
      )?.lifetimeQualifyingDepositCents ?? 0
    );
  }

  public getSettings(ownerCoadminUserId: string): LeaderboardSettingsRow | undefined {
    return this.store.settings.get(ownerCoadminUserId);
  }

  public getActiveMilestones(referralId: string): MilestoneAwardRow[] {
    return this.store.milestones.filter((m) => m.referralId === referralId && m.status === "ACTIVE");
  }

  private async freezeCompetitionLocked(competition: CompetitionRow, now: Date): Promise<void> {
    if (competition.status !== "ACTIVE") return;
    if (this.store.snapshots.some((s) => s.competitionId === competition.id)) {
      competition.status = "FROZEN";
      competition.frozenAt = competition.frozenAt ?? now;
      competition.updatedAt = now;
      return;
    }

    const ranked = sortStandings(this.store.standings.filter((s) => s.competitionId === competition.id));
    const top10 = ranked.slice(0, 10).map((s, index) => ({
      rank: index + 1,
      crmContactId: s.crmContactId,
      totalPoints: s.totalPoints,
      pointsReachedAt: s.pointsReachedAt.toISOString()
    }));
    const top3 = top10.slice(0, 3);
    const standingsHash = createHash("sha256")
      .update(JSON.stringify(top10))
      .digest("hex");

    this.store.snapshots.push({
      id: randomUUID(),
      competitionId: competition.id,
      workspaceId: competition.workspaceId,
      ownerCoadminUserId: competition.ownerCoadminUserId,
      frozenAt: now,
      prizePoolCents: competition.prizePoolCents,
      top10Json: top10,
      top3Json: top3,
      standingsHash,
      metricsJson: {
        rankedPlayers: ranked.length,
        depositEvents: this.store.events.filter((e) => e.competitionId === competition.id && e.type === "DEPOSIT").length,
        promotionEvents: this.store.events.filter((e) => e.competitionId === competition.id && e.type === "PROMOTION").length,
        referralMilestoneEvents: this.store.events.filter(
          (e) => e.competitionId === competition.id && e.type === "REFERRAL_MILESTONE"
        ).length,
        reversalEvents: this.store.events.filter(
          (e) =>
            e.competitionId === competition.id &&
            (e.type === "DEPOSIT_REVERSAL" || e.type === "REFERRAL_MILESTONE_REVERSAL" || e.type === "PROMOTION_REVERSAL")
        ).length
      },
      winnersJson: null,
      winnersLockedAt: null,
      createdAt: now
    });

    for (let index = 0; index < ranked.length; index += 1) {
      const standing = ranked[index]!;
      this.store.eligibilityCandidates.push({
        id: randomUUID(),
        workspaceId: competition.workspaceId,
        ownerCoadminUserId: competition.ownerCoadminUserId,
        competitionId: competition.id,
        crmContactId: standing.crmContactId,
        leaderboardRank: index + 1,
        totalPoints: standing.totalPoints,
        membershipStatus: "PENDING_REVIEW",
        ineligibilityReason: null,
        resolvedAt: null,
        resolvedByUserId: null,
        resolutionReason: null,
        verificationSource: null,
        telegramChatMemberStatus: null,
        verifiedChannelId: null,
        botIntegrationId: null,
        verificationCheckedAt: null,
        verificationErrorCode: null,
        verificationErrorMessage: null,
        createdAt: now,
        updatedAt: now
      });
    }

    competition.status = "FROZEN";
    competition.frozenAt = now;
    competition.updatedAt = now;
    this.audit(competition.workspaceId, null, "leaderboard.competition_frozen", {
      competitionId: competition.id,
      ownerCoadminUserId: competition.ownerCoadminUserId,
      prizePoolCents: competition.prizePoolCents
    });
  }

  private async syncReferralMilestonesForReferred(
    workspaceId: string,
    ownerCoadminUserId: string,
    referredCrmContactId: string,
    now: Date,
    actorUserId: string | null
  ): Promise<void> {
    const referral = this.store.referrals.find(
      (r) => r.ownerCoadminUserId === ownerCoadminUserId && r.referredCrmContactId === referredCrmContactId
    );
    if (!referral) return;

    const lifetime = this.getLifetimeCents(ownerCoadminUserId, referredCrmContactId);
    const active = this.store.milestones.filter((m) => m.referralId === referral.id && m.status === "ACTIVE");

    const toReverse = milestonesToReverse(
      lifetime,
      active.map((m) => ({ code: m.milestoneCode, thresholdCents: m.thresholdCents, points: m.points }))
    );
    for (const milestone of toReverse) {
      const row = active.find((m) => m.milestoneCode === milestone.code);
      if (!row) continue;
      const awardEvent = this.store.events.find((e) => e.id === row.awardEventId);
      const beneficiaryId = awardEvent?.crmContactId ?? referral.referrerCrmContactId;
      const competition = this.requireCompetition(row.competitionId, ownerCoadminUserId);
      const event = this.createEvent({
        workspaceId,
        ownerCoadminUserId,
        competitionId: competition.id,
        crmContactId: beneficiaryId,
        type: "REFERRAL_MILESTONE_REVERSAL",
        pointsDelta: -row.points,
        depositAmountCents: null,
        poolContributionCents: null,
        poolRateBpsApplied: null,
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
      });
      row.status = "REVERSED";
      row.reversalEventId = event.id;
      row.reversedAt = now;
      const standing = this.getOrCreateStanding(workspaceId, ownerCoadminUserId, competition.id, beneficiaryId, now);
      standing.referralPoints -= row.points;
      if (row.milestoneCode === "FIRST_10") {
        standing.successfulReferralCount = Math.max(0, standing.successfulReferralCount - 1);
      }
      this.applyPointsDelta(standing, -row.points, now, event);
    }

    const stillActive = this.store.milestones.filter((m) => m.referralId === referral.id && m.status === "ACTIVE");
    const stillActiveCodes = new Set(stillActive.map((m) => m.milestoneCode));
    const toAward = milestonesToAward(lifetime, stillActiveCodes);
    for (const milestone of toAward) {
      const competition = await this.ensureCurrentCompetition(workspaceId, ownerCoadminUserId, now, {
        skipEnabledCheck: true
      });
      const priorGens = this.store.milestones.filter(
        (m) => m.referralId === referral.id && m.milestoneCode === milestone.code
      );
      const generation = priorGens.length + 1;
      const event = this.createEvent({
        workspaceId,
        ownerCoadminUserId,
        competitionId: competition.id,
        crmContactId: referral.referrerCrmContactId,
        type: "REFERRAL_MILESTONE",
        pointsDelta: milestone.points,
        depositAmountCents: null,
        poolContributionCents: null,
        poolRateBpsApplied: null,
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
      });
      this.store.milestones.push({
        id: randomUUID(),
        workspaceId,
        referralId: referral.id,
        competitionId: competition.id,
        milestoneCode: milestone.code as ReferralMilestoneCodeValue,
        thresholdCents: milestone.thresholdCents,
        points: milestone.points,
        status: "ACTIVE",
        generation,
        awardEventId: event.id,
        reversalEventId: null,
        awardedAt: now,
        reversedAt: null,
        createdAt: now
      });
      const standing = this.getOrCreateStanding(
        workspaceId,
        ownerCoadminUserId,
        competition.id,
        referral.referrerCrmContactId,
        now
      );
      standing.referralPoints += milestone.points;
      if (milestone.code === "FIRST_10") standing.successfulReferralCount += 1;
      this.applyPointsDelta(standing, milestone.points, now, event);
    }
  }

  private bumpLifetime(
    workspaceId: string,
    ownerCoadminUserId: string,
    crmContactId: string,
    deltaCents: number,
    now: Date
  ): void {
    let stats = this.store.playerStats.find(
      (p) => p.ownerCoadminUserId === ownerCoadminUserId && p.crmContactId === crmContactId
    );
    if (!stats) {
      stats = {
        id: randomUUID(),
        workspaceId,
        ownerCoadminUserId,
        crmContactId,
        lifetimeQualifyingDepositCents: 0,
        createdAt: now,
        updatedAt: now
      };
      this.store.playerStats.push(stats);
    }
    stats.lifetimeQualifyingDepositCents += deltaCents;
    if (stats.lifetimeQualifyingDepositCents < 0) {
      throw new Error("lifetime qualifying deposits cannot go negative");
    }
    stats.updatedAt = now;
  }

  private applyPointsDelta(standing: StandingRow, pointsDelta: number, now: Date, event: EventRow): void {
    const previousTotal = standing.totalPoints;
    standing.totalPoints += pointsDelta;
    if (standing.totalPoints !== previousTotal) {
      standing.pointsReachedAt = now;
    }
    standing.lastEventId = event.id;
    standing.lastEventAt = now;
    standing.lastEventType = event.type;
    standing.lastEventReason = event.reason;
    standing.updatedAt = now;
  }

  private getOrCreateStanding(
    workspaceId: string,
    ownerCoadminUserId: string,
    competitionId: string,
    crmContactId: string,
    now: Date
  ): StandingRow {
    let standing = this.store.standings.find(
      (s) => s.competitionId === competitionId && s.crmContactId === crmContactId
    );
    if (!standing) {
      standing = {
        id: randomUUID(),
        workspaceId,
        ownerCoadminUserId,
        competitionId,
        crmContactId,
        totalPoints: 0,
        depositPoints: 0,
        referralPoints: 0,
        promotionPoints: 0,
        wheelPoints: 0,
        qualifyingDepositCents: 0,
        successfulReferralCount: 0,
        pointsReachedAt: now,
        lastEventId: null,
        lastEventAt: null,
        lastEventType: null,
        lastEventReason: null,
        createdAt: now,
        updatedAt: now
      };
      this.store.standings.push(standing);
    }
    return standing;
  }

  private ensureZeroPointStandingsForOwner(
    workspaceId: string,
    ownerCoadminUserId: string,
    competitionId: string,
    now: Date
  ): void {
    const participants = this.store.participants.filter(
      (p) => p.workspaceId === workspaceId && p.ownerCoadminUserId === ownerCoadminUserId
    );
    for (const participant of participants) {
      this.getOrCreateStanding(
        workspaceId,
        ownerCoadminUserId,
        competitionId,
        participant.crmContactId,
        now
      );
    }
  }

  private ensureZeroStandingIfActive(
    workspaceId: string,
    ownerCoadminUserId: string,
    crmContactId: string,
    now: Date
  ): void {
    const settings = this.store.settings.get(ownerCoadminUserId);
    if (!settings?.enabled || settings.workspaceId !== workspaceId) return;
    const competition = this.store.competitions.find(
      (c) =>
        c.workspaceId === workspaceId &&
        c.ownerCoadminUserId === ownerCoadminUserId &&
        c.status === "ACTIVE" &&
        c.startsAt.getTime() <= now.getTime() &&
        c.endsAt.getTime() > now.getTime()
    );
    if (!competition) return;
    this.getOrCreateStanding(workspaceId, ownerCoadminUserId, competition.id, crmContactId, now);
  }

  private createEvent(
    input: Omit<EventRow, "id" | "createdAt" | "reversesEventId"> & { reversesEventId?: string | null }
  ): EventRow {
    const row: EventRow = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      ownerCoadminUserId: input.ownerCoadminUserId,
      competitionId: input.competitionId,
      crmContactId: input.crmContactId,
      type: input.type,
      pointsDelta: input.pointsDelta,
      depositAmountCents: input.depositAmountCents,
      poolContributionCents: input.poolContributionCents,
      poolRateBpsApplied: input.poolRateBpsApplied,
      actorUserId: input.actorUserId,
      reason: input.reason,
      metadataJson: input.metadataJson,
      occurredAt: input.occurredAt,
      idempotencyKey: input.idempotencyKey,
      reversesEventId: input.reversesEventId ?? null,
      createdAt: input.occurredAt
    };
    this.store.events.push(row);
    return row;
  }

  private findEventByIdempotency(key: string): EventRow | undefined {
    return this.store.events.find((e) => e.idempotencyKey === key);
  }

  private assertIdempotentPayload(key: string, payloadHash: string): void {
    const previous = this.store.idempotencyPayloads.get(key);
    if (previous && previous !== payloadHash) throw idempotencyConflict();
  }

  private assertEnabled(ownerCoadminUserId: string): void {
    if (!this.requireEnabled) return;
    const settings = this.store.settings.get(ownerCoadminUserId);
    if (!settings?.enabled) throw leaderboardDisabled();
  }

  private assertContact(workspaceId: string, crmContactId: string): void {
    const contact = this.store.contacts.get(crmContactId);
    if (!contact || contact.workspaceId !== workspaceId) throw contactNotFound();
  }

  private requireCompetition(id: string, ownerCoadminUserId: string): CompetitionRow {
    const row = this.store.competitions.find((c) => c.id === id);
    if (!row) throw eventNotFound();
    if (row.ownerCoadminUserId !== ownerCoadminUserId) throw ownerMismatch();
    return row;
  }

  private audit(workspaceId: string | null, actorId: string | null, action: string, metadata: Record<string, unknown>): void {
    this.store.audits.push({ workspaceId, actorId, action, metadata });
  }
}

function hashPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function emptyReconcileResult(): DepositScoringReconciliationResult {
  return {
    competitionsProcessed: 0,
    playersVisited: 0,
    playersAdjusted: 0,
    playersAlreadyCorrect: 0,
    playersSkippedIdempotent: 0,
    adjustments: []
  };
}
