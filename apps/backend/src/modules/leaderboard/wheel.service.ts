import { randomUUID } from "node:crypto";
import {
  WHEEL_MAX_POINTS,
  WHEEL_MIN_POINTS,
  WHEEL_PRODUCT_QUALIFICATION_POLICY,
  WHEEL_QUALIFICATION_CENTS
} from "./leaderboard.constants";
import {
  getApprovedWheelDistribution,
  isApprovedWheelDistribution
} from "./approved-wheel-distribution";
import { LeaderboardError } from "./leaderboard.errors";
import type { CompetitionRow, EventRow, StandingRow } from "./leaderboard.types";
import { withRanks } from "./ranking";
import { cycleContaining, listCycles, type WheelCycleWindow } from "./wheel-cycles";
import {
  parseRewardDistributionJson,
  type WheelDistributionOutcome
} from "./wheel-distribution";
import { selectWeightedPoints, type WheelRng } from "./wheel-rng";

/**
 * Phase 6 / 6.1 — 48-hour Wheel domain (in-memory for tests).
 *
 * Product locks: CYCLE_DEPOSITS_ALL, approved distribution v1 (EV 13.7),
 * $40 / 1 spin / cycle, no clawback, no retroactive completed-cycle spins.
 * Bot Spin callback: DEFERRED.
 */

export type WheelQualificationCreditPolicy =
  | "UNSET"
  | "CYCLE_DEPOSITS_ALL"
  | "CYCLE_DEPOSITS_AFTER_ENABLE";

export interface WheelConfigRow {
  id: string;
  workspaceId: string;
  ownerCoadminUserId: string;
  enabled: boolean;
  qualificationCreditPolicy: WheelQualificationCreditPolicy;
  enabledAt: Date | null;
  activeVersionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WheelConfigVersionRow {
  id: string;
  ownerCoadminUserId: string;
  workspaceId: string;
  rewardDistributionJson: WheelDistributionOutcome[];
  createdAt: Date;
  createdByUserId: string;
  activatedAt: Date | null;
}

export interface WheelCycleRow {
  id: string;
  workspaceId: string;
  ownerCoadminUserId: string;
  competitionId: string;
  sequence: number;
  startsAt: Date;
  endsAt: Date;
  createdAt: Date;
}

export interface WheelQualificationRow {
  id: string;
  workspaceId: string;
  ownerCoadminUserId: string;
  competitionId: string;
  cycleId: string;
  crmContactId: string;
  qualifyingDepositCents: number;
  qualifiedAt: Date | null;
  available: boolean;
  consumedAt: Date | null;
  spinId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WheelSpinRow {
  id: string;
  workspaceId: string;
  ownerCoadminUserId: string;
  competitionId: string;
  cycleId: string;
  crmContactId: string;
  pointsAwarded: number;
  configVersionId: string;
  idempotencyKey: string;
  spunAt: Date;
  leaderboardEventId: string;
  previousRank: number | null;
  resultingRank: number | null;
  rngMetaJson: Record<string, unknown> | null;
  qualificationInvalidatedAt: Date | null;
  createdAt: Date;
}

export interface WheelPlayerStatus {
  readonly wheelEnabled: boolean;
  readonly configured: boolean;
  readonly competitionId: string | null;
  readonly competitionStatus: string | null;
  readonly cycleSequence: number | null;
  readonly cycleStartsAt: string | null;
  readonly cycleEndsAt: string | null;
  readonly qualifyingDepositCents: number;
  readonly qualificationCentsRequired: number;
  readonly available: boolean;
  readonly consumed: boolean;
  readonly pointsAwarded: number | null;
  readonly qualificationInvalidated: boolean;
  readonly wheelPoints: number;
  readonly reasonCode: string | null;
}

export interface WheelSpinResult {
  readonly spin: WheelSpinRow;
  readonly event: EventRow;
  readonly standing: StandingRow;
  readonly replay: boolean;
}

export function wheelNotEnabled(): LeaderboardError {
  return new LeaderboardError("WHEEL_NOT_ENABLED", "Wheel is not enabled for this leaderboard.");
}

export function wheelNotConfigured(): LeaderboardError {
  return new LeaderboardError(
    "WHEEL_NOT_CONFIGURED",
    "Wheel has no active reward distribution. Activate the approved distribution first."
  );
}

export function wheelPolicyUnset(): LeaderboardError {
  return new LeaderboardError(
    "WHEEL_POLICY_UNSET",
    "Wheel qualification policy must be CYCLE_DEPOSITS_ALL before enabling."
  );
}

export function wheelNotAvailable(reason: string): LeaderboardError {
  return new LeaderboardError("WHEEL_NOT_AVAILABLE", reason);
}

export function wheelCompetitionNotActive(): LeaderboardError {
  return new LeaderboardError(
    "WHEEL_COMPETITION_NOT_ACTIVE",
    "Wheel spins are only allowed during an ACTIVE competition."
  );
}

export function wheelAlreadyConsumed(): LeaderboardError {
  return new LeaderboardError(
    "WHEEL_ALREADY_CONSUMED",
    "This player already used their wheel spin for the current 48-hour cycle."
  );
}

export interface WheelServiceStore {
  configs: WheelConfigRow[];
  versions: WheelConfigVersionRow[];
  cycles: WheelCycleRow[];
  qualifications: WheelQualificationRow[];
  spins: WheelSpinRow[];
  competitions: CompetitionRow[];
  events: EventRow[];
  standings: StandingRow[];
  participants: Array<{
    workspaceId: string;
    ownerCoadminUserId: string;
    crmContactId: string;
  }>;
}

/**
 * In-memory wheel engine for comprehensive Phase 6 tests.
 * Production path uses PrismaWheelService with the same rules.
 */
export class WheelService {
  public constructor(private readonly store: WheelServiceStore) {}

  public ensureConfig(
    workspaceId: string,
    ownerCoadminUserId: string,
    now = new Date()
  ): WheelConfigRow {
    let config = this.store.configs.find((c) => c.ownerCoadminUserId === ownerCoadminUserId);
    if (!config) {
      config = {
        id: randomUUID(),
        workspaceId,
        ownerCoadminUserId,
        enabled: false,
        // Phase 6.1: product-locked policy (enum retains UNSET/AFTER_ENABLE for schema compat).
        qualificationCreditPolicy: WHEEL_PRODUCT_QUALIFICATION_POLICY,
        enabledAt: null,
        activeVersionId: null,
        createdAt: now,
        updatedAt: now
      };
      this.store.configs.push(config);
    } else if (config.qualificationCreditPolicy !== WHEEL_PRODUCT_QUALIFICATION_POLICY) {
      config.qualificationCreditPolicy = WHEEL_PRODUCT_QUALIFICATION_POLICY;
      config.updatedAt = now;
    }
    return config;
  }

  /**
   * Creates (if needed) and activates the approved Phase 6.1 distribution for this Coadmin.
   * Never shares mutable config across Coadmins.
   */
  public ensureApprovedDistributionVersion(input: {
    workspaceId: string;
    ownerCoadminUserId: string;
    createdByUserId: string;
    now?: Date;
  }): WheelConfigVersionRow {
    const now = input.now ?? new Date();
    const config = this.ensureConfig(input.workspaceId, input.ownerCoadminUserId, now);
    config.qualificationCreditPolicy = WHEEL_PRODUCT_QUALIFICATION_POLICY;

    if (config.activeVersionId) {
      const active = this.store.versions.find((v) => v.id === config.activeVersionId);
      if (active && isApprovedWheelDistribution(active.rewardDistributionJson)) {
        return active;
      }
    }

    const existingApproved = this.store.versions.find(
      (v) =>
        v.ownerCoadminUserId === input.ownerCoadminUserId &&
        isApprovedWheelDistribution(v.rewardDistributionJson)
    );
    if (existingApproved) {
      return this.activateVersion({
        ownerCoadminUserId: input.ownerCoadminUserId,
        versionId: existingApproved.id,
        now
      });
    }

    const approved = getApprovedWheelDistribution();
    const version = this.createVersion({
      workspaceId: input.workspaceId,
      ownerCoadminUserId: input.ownerCoadminUserId,
      createdByUserId: input.createdByUserId,
      distribution: approved.outcomes,
      now
    });
    return this.activateVersion({
      ownerCoadminUserId: input.ownerCoadminUserId,
      versionId: version.id,
      now
    });
  }

  public createVersion(input: {
    workspaceId: string;
    ownerCoadminUserId: string;
    createdByUserId: string;
    distribution: unknown;
    now?: Date;
  }): WheelConfigVersionRow {
    this.ensureConfig(input.workspaceId, input.ownerCoadminUserId, input.now);
    const validated = parseRewardDistributionJson(input.distribution);
    const now = input.now ?? new Date();
    const version: WheelConfigVersionRow = {
      id: randomUUID(),
      ownerCoadminUserId: input.ownerCoadminUserId,
      workspaceId: input.workspaceId,
      rewardDistributionJson: [...validated.outcomes],
      createdAt: now,
      createdByUserId: input.createdByUserId,
      activatedAt: null
    };
    this.store.versions.push(version);
    return version;
  }

  public activateVersion(input: {
    ownerCoadminUserId: string;
    versionId: string;
    now?: Date;
  }): WheelConfigVersionRow {
    const version = this.store.versions.find(
      (v) => v.id === input.versionId && v.ownerCoadminUserId === input.ownerCoadminUserId
    );
    if (!version) {
      throw new LeaderboardError("WHEEL_VERSION_NOT_FOUND", "Wheel config version was not found.");
    }
    parseRewardDistributionJson(version.rewardDistributionJson);
    const now = input.now ?? new Date();
    version.activatedAt = now;
    const config = this.ensureConfig(version.workspaceId, input.ownerCoadminUserId, now);
    config.activeVersionId = version.id;
    config.updatedAt = now;
    return version;
  }

  public patchSettings(input: {
    workspaceId: string;
    ownerCoadminUserId: string;
    enabled?: boolean;
    /** Ignored for product path — Phase 6.1 locks CYCLE_DEPOSITS_ALL. */
    qualificationCreditPolicy?: WheelQualificationCreditPolicy;
    now?: Date;
  }): WheelConfigRow {
    const now = input.now ?? new Date();
    const config = this.ensureConfig(input.workspaceId, input.ownerCoadminUserId, now);
    // Product lock: always CYCLE_DEPOSITS_ALL (schema enum keeps other values for compat).
    config.qualificationCreditPolicy = WHEEL_PRODUCT_QUALIFICATION_POLICY;
    if (input.enabled !== undefined) {
      if (input.enabled) {
        // Phase 6.1: if no version is active, seed/activate the approved distribution.
        if (!config.activeVersionId) {
          this.ensureApprovedDistributionVersion({
            workspaceId: input.workspaceId,
            ownerCoadminUserId: input.ownerCoadminUserId,
            createdByUserId: input.ownerCoadminUserId,
            now
          });
        }
        if (!config.activeVersionId) throw wheelNotConfigured();
        const version = this.store.versions.find((v) => v.id === config.activeVersionId);
        if (!version) throw wheelNotConfigured();
        parseRewardDistributionJson(version.rewardDistributionJson);
        config.enabled = true;
        config.enabledAt = config.enabledAt ?? now;
      } else {
        config.enabled = false;
      }
    }
    config.updatedAt = now;
    return config;
  }

  public ensureCyclesForCompetition(competition: CompetitionRow): WheelCycleRow[] {
    const windows = listCycles(competition);
    const existing = this.store.cycles.filter((c) => c.competitionId === competition.id);
    if (existing.length === WHEEL_CYCLES_EXPECTED) {
      return existing.sort((a, b) => a.sequence - b.sequence);
    }
    const now = new Date();
    const rows: WheelCycleRow[] = [];
    for (const window of windows) {
      let row = existing.find((c) => c.sequence === window.sequence);
      if (!row) {
        row = {
          id: randomUUID(),
          workspaceId: competition.workspaceId,
          ownerCoadminUserId: competition.ownerCoadminUserId,
          competitionId: competition.id,
          sequence: window.sequence,
          startsAt: window.startsAt,
          endsAt: window.endsAt,
          createdAt: now
        };
        this.store.cycles.push(row);
      }
      rows.push(row);
    }
    return rows.sort((a, b) => a.sequence - b.sequence);
  }

  public recomputeQualification(
    ownerCoadminUserId: string,
    competition: CompetitionRow,
    cycle: WheelCycleRow,
    crmContactId: string,
    now = new Date()
  ): WheelQualificationRow {
    const config = this.ensureConfig(competition.workspaceId, ownerCoadminUserId, now);
    const cents = this.sumCycleDepositCents({
      ownerCoadminUserId,
      competitionId: competition.id,
      crmContactId,
      cycle,
      policy: config.qualificationCreditPolicy,
      enabledAt: config.enabledAt
    });

    let qual = this.store.qualifications.find(
      (q) => q.cycleId === cycle.id && q.crmContactId === crmContactId
    );
    if (!qual) {
      qual = {
        id: randomUUID(),
        workspaceId: competition.workspaceId,
        ownerCoadminUserId,
        competitionId: competition.id,
        cycleId: cycle.id,
        crmContactId,
        qualifyingDepositCents: 0,
        qualifiedAt: null,
        available: false,
        consumedAt: null,
        spinId: null,
        createdAt: now,
        updatedAt: now
      };
      this.store.qualifications.push(qual);
    }

    qual.qualifyingDepositCents = cents;
    qual.updatedAt = now;

    const consumed = qual.consumedAt != null || qual.spinId != null;
    const wheelReady =
      config.enabled && config.activeVersionId != null && competition.status === "ACTIVE";

    if (consumed) {
      qual.available = false;
      if (cents < WHEEL_QUALIFICATION_CENTS) {
        const spin = this.store.spins.find((s) => s.id === qual!.spinId);
        if (spin && spin.qualificationInvalidatedAt == null) {
          spin.qualificationInvalidatedAt = now;
        }
      }
      return qual;
    }

    const qualifies = cents >= WHEEL_QUALIFICATION_CENTS && wheelReady;
    if (qualifies) {
      qual.available = true;
      qual.qualifiedAt = qual.qualifiedAt ?? now;
    } else {
      qual.available = false;
      if (cents < WHEEL_QUALIFICATION_CENTS) {
        qual.qualifiedAt = null;
      }
    }
    return qual;
  }

  public getStatus(
    workspaceId: string,
    ownerCoadminUserId: string,
    crmContactId: string,
    now = new Date()
  ): WheelPlayerStatus {
    const config = this.ensureConfig(workspaceId, ownerCoadminUserId, now);
    const competition = this.findActiveOrCurrentCompetition(workspaceId, ownerCoadminUserId, now);
    const standing = competition
      ? this.store.standings.find(
          (s) => s.competitionId === competition.id && s.crmContactId === crmContactId
        )
      : undefined;

    const base: WheelPlayerStatus = {
      wheelEnabled: config.enabled,
      configured: config.activeVersionId != null,
      competitionId: competition?.id ?? null,
      competitionStatus: competition?.status ?? null,
      cycleSequence: null,
      cycleStartsAt: null,
      cycleEndsAt: null,
      qualifyingDepositCents: 0,
      qualificationCentsRequired: WHEEL_QUALIFICATION_CENTS,
      available: false,
      consumed: false,
      pointsAwarded: null,
      qualificationInvalidated: false,
      wheelPoints: standing?.wheelPoints ?? 0,
      reasonCode: null
    };

    if (!competition) {
      return { ...base, reasonCode: "NO_COMPETITION" };
    }
    if (competition.status !== "ACTIVE") {
      return { ...base, reasonCode: "COMPETITION_NOT_ACTIVE" };
    }
    if (!config.enabled) {
      return { ...base, reasonCode: "WHEEL_DISABLED" };
    }
    if (!config.activeVersionId) {
      return { ...base, reasonCode: "WHEEL_NOT_CONFIGURED" };
    }

    const cycles = this.ensureCyclesForCompetition(competition);
    const window = cycleContaining(competition, now);
    if (!window) {
      return { ...base, reasonCode: "NO_CYCLE" };
    }
    const cycle = cycles.find((c) => c.sequence === window.sequence)!;
    const qual = this.recomputeQualification(ownerCoadminUserId, competition, cycle, crmContactId, now);
    const spin = qual.spinId ? this.store.spins.find((s) => s.id === qual.spinId) : undefined;

    return {
      ...base,
      cycleSequence: cycle.sequence,
      cycleStartsAt: cycle.startsAt.toISOString(),
      cycleEndsAt: cycle.endsAt.toISOString(),
      qualifyingDepositCents: qual.qualifyingDepositCents,
      available: qual.available,
      consumed: qual.consumedAt != null,
      pointsAwarded: spin?.pointsAwarded ?? null,
      qualificationInvalidated: spin?.qualificationInvalidatedAt != null,
      wheelPoints: standing?.wheelPoints ?? 0,
      reasonCode: qual.available
        ? null
        : qual.consumedAt
          ? "ALREADY_SPUN"
          : qual.qualifyingDepositCents < WHEEL_QUALIFICATION_CENTS
            ? "BELOW_QUALIFICATION"
            : "NOT_AVAILABLE"
    };
  }

  public spin(input: {
    workspaceId: string;
    crmContactId: string;
    idempotencyKey: string;
    actorUserId: string;
    now?: Date;
    rng: WheelRng;
  }): WheelSpinResult {
    const now = input.now ?? new Date();
    const existingSpin = this.store.spins.find((s) => s.idempotencyKey === input.idempotencyKey);
    if (existingSpin) {
      const event = this.store.events.find((e) => e.id === existingSpin.leaderboardEventId)!;
      const standing = this.store.standings.find(
        (s) =>
          s.competitionId === existingSpin.competitionId &&
          s.crmContactId === existingSpin.crmContactId
      )!;
      return { spin: existingSpin, event, standing, replay: true };
    }

    const participant = this.store.participants.find(
      (p) => p.workspaceId === input.workspaceId && p.crmContactId === input.crmContactId
    );
    if (!participant) {
      throw new LeaderboardError(
        "PARTICIPANT_NOT_BOUND",
        "CrmContact is not bound to a coadmin leaderboard in this workspace."
      );
    }
    const owner = participant.ownerCoadminUserId;
    const competition = this.findActiveOrCurrentCompetition(input.workspaceId, owner, now);
    if (!competition || competition.status !== "ACTIVE") {
      throw wheelCompetitionNotActive();
    }

    const config = this.ensureConfig(input.workspaceId, owner, now);
    config.qualificationCreditPolicy = WHEEL_PRODUCT_QUALIFICATION_POLICY;
    if (!config.enabled) throw wheelNotEnabled();
    if (!config.activeVersionId) throw wheelNotConfigured();
    const version = this.store.versions.find((v) => v.id === config.activeVersionId);
    if (!version) throw wheelNotConfigured();
    const distribution = parseRewardDistributionJson(version.rewardDistributionJson);

    const cycles = this.ensureCyclesForCompetition(competition);
    const window = cycleContaining(competition, now);
    if (!window) throw wheelNotAvailable("No wheel cycle for the current time.");
    const cycle = cycles.find((c) => c.sequence === window.sequence)!;

    // Simulated FOR UPDATE: recompute then require available.
    const qual = this.recomputeQualification(owner, competition, cycle, input.crmContactId, now);
    if (qual.consumedAt != null || qual.spinId != null) throw wheelAlreadyConsumed();
    if (!qual.available) {
      throw wheelNotAvailable(
        qual.qualifyingDepositCents < WHEEL_QUALIFICATION_CENTS
          ? `Need $${(WHEEL_QUALIFICATION_CENTS / 100).toFixed(0)} in cycle deposits to spin.`
          : "Wheel spin is not available."
      );
    }

    const cycleSpin = this.store.spins.find(
      (s) => s.cycleId === cycle.id && s.crmContactId === input.crmContactId
    );
    if (cycleSpin) throw wheelAlreadyConsumed();

    const points = selectWeightedPoints(distribution.outcomes, input.rng);
    if (points < WHEEL_MIN_POINTS || points > WHEEL_MAX_POINTS) {
      throw new LeaderboardError("WHEEL_RNG_INVALID", "RNG produced out-of-range wheel points.");
    }

    let standing = this.store.standings.find(
      (s) => s.competitionId === competition.id && s.crmContactId === input.crmContactId
    );
    if (!standing) {
      standing = {
        id: randomUUID(),
        workspaceId: input.workspaceId,
        ownerCoadminUserId: owner,
        competitionId: competition.id,
        crmContactId: input.crmContactId,
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

    const rankedBefore = withRanks(
      this.store.standings
        .filter((s) => s.competitionId === competition.id)
        .map((s) => ({
          crmContactId: s.crmContactId,
          totalPoints: s.totalPoints,
          pointsReachedAt: s.pointsReachedAt
        }))
    );
    const previousRank =
      rankedBefore.find((r) => r.crmContactId === input.crmContactId)?.rank ?? null;

    const event: EventRow = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      ownerCoadminUserId: owner,
      competitionId: competition.id,
      crmContactId: input.crmContactId,
      type: "WHEEL_SPIN",
      pointsDelta: points,
      depositAmountCents: null,
      poolContributionCents: null,
      poolRateBpsApplied: null,
      actorUserId: input.actorUserId,
      reason: "wheel_spin",
      metadataJson: {
        cycleId: cycle.id,
        cycleSequence: cycle.sequence,
        configVersionId: version.id,
        kind: "WHEEL_SPIN"
      },
      occurredAt: now,
      idempotencyKey: input.idempotencyKey,
      reversesEventId: null,
      createdAt: now
    };
    this.store.events.push(event);

    standing.wheelPoints += points;
    standing.totalPoints =
      standing.depositPoints +
      standing.referralPoints +
      standing.promotionPoints +
      standing.wheelPoints;
    if (points !== 0) standing.pointsReachedAt = now;
    standing.lastEventId = event.id;
    standing.lastEventAt = now;
    standing.lastEventType = "WHEEL_SPIN";
    standing.lastEventReason = "wheel_spin";
    standing.updatedAt = now;

    const rankedAfter = withRanks(
      this.store.standings
        .filter((s) => s.competitionId === competition.id)
        .map((s) => ({
          crmContactId: s.crmContactId,
          totalPoints: s.totalPoints,
          pointsReachedAt: s.pointsReachedAt
        }))
    );
    const resultingRank =
      rankedAfter.find((r) => r.crmContactId === input.crmContactId)?.rank ?? null;

    const spin: WheelSpinRow = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      ownerCoadminUserId: owner,
      competitionId: competition.id,
      cycleId: cycle.id,
      crmContactId: input.crmContactId,
      pointsAwarded: points,
      configVersionId: version.id,
      idempotencyKey: input.idempotencyKey,
      spunAt: now,
      leaderboardEventId: event.id,
      previousRank,
      resultingRank,
      rngMetaJson: { source: "injected", points },
      qualificationInvalidatedAt: null,
      createdAt: now
    };
    this.store.spins.push(spin);

    qual.available = false;
    qual.consumedAt = now;
    qual.spinId = spin.id;
    qual.updatedAt = now;

    return { spin, event, standing, replay: false };
  }

  private sumCycleDepositCents(input: {
    ownerCoadminUserId: string;
    competitionId: string;
    crmContactId: string;
    cycle: WheelCycleRow | WheelCycleWindow & { id?: string };
    policy: WheelQualificationCreditPolicy;
    enabledAt: Date | null;
  }): number {
    let cents = 0;
    for (const event of this.store.events) {
      if (event.ownerCoadminUserId !== input.ownerCoadminUserId) continue;
      if (event.competitionId !== input.competitionId) continue;
      if (event.crmContactId !== input.crmContactId) continue;
      if (event.type !== "DEPOSIT" && event.type !== "DEPOSIT_REVERSAL") continue;
      const t = event.occurredAt.getTime();
      if (t < input.cycle.startsAt.getTime() || t >= input.cycle.endsAt.getTime()) continue;
      if (input.policy === "CYCLE_DEPOSITS_AFTER_ENABLE") {
        if (!input.enabledAt || t < input.enabledAt.getTime()) continue;
      }
      if (input.policy === "UNSET") continue;
      cents += event.depositAmountCents ?? 0;
    }
    return Math.max(0, cents);
  }

  private findActiveOrCurrentCompetition(
    workspaceId: string,
    ownerCoadminUserId: string,
    now: Date
  ): CompetitionRow | null {
    const owned = this.store.competitions.filter(
      (c) => c.workspaceId === workspaceId && c.ownerCoadminUserId === ownerCoadminUserId
    );
    const active = owned.find(
      (c) =>
        c.status === "ACTIVE" &&
        now.getTime() >= c.startsAt.getTime() &&
        now.getTime() < c.endsAt.getTime()
    );
    if (active) return active;
    return (
      owned.find(
        (c) => now.getTime() >= c.startsAt.getTime() && now.getTime() < c.endsAt.getTime()
      ) ?? null
    );
  }
}

const WHEEL_CYCLES_EXPECTED = 7;

export function createEmptyWheelStore(): WheelServiceStore {
  return {
    configs: [],
    versions: [],
    cycles: [],
    qualifications: [],
    spins: [],
    competitions: [],
    events: [],
    standings: [],
    participants: []
  };
}
