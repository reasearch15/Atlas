import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
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
import { LeaderboardError, participantNotBound } from "./leaderboard.errors";
import { withRanks } from "./ranking";
import { cycleContaining, listCycles } from "./wheel-cycles";
import {
  isWheelQualified,
  nextWheelSpinAt,
  qualificationOccurredAtFilter,
  sumConsumedQualificationCents,
  wheelCooldownSatisfied
} from "./wheel-qualification";
import { parseRewardDistributionJson } from "./wheel-distribution";
import {
  createCryptoWheelRng,
  selectWeightedPoints,
  type WheelRng
} from "./wheel-rng";
import {
  wheelAlreadyConsumed,
  wheelCompetitionNotActive,
  wheelNotAvailable,
  wheelNotConfigured,
  wheelNotEnabled,
  type WheelConfigRow,
  type WheelConfigVersionRow,
  type WheelPlayerStatus,
  type WheelQualificationCreditPolicy,
  type WheelSpinResult
} from "./wheel.service";

type Tx = Prisma.TransactionClient;

/**
 * Prisma-backed Phase 6 / 6.1 wheel engine.
 * Policy locked to CYCLE_DEPOSITS_ALL; approved distribution via ensureApprovedDistributionVersion.
 * Bot Spin callback: DEFERRED (Atlas UI only).
 */
export class PrismaWheelService {
  public constructor(private readonly prisma: PrismaClient) {}

  public async ensureConfig(
    workspaceId: string,
    ownerCoadminUserId: string
  ): Promise<WheelConfigRow> {
    const existing = await this.prisma.leaderboardWheelConfig.findUnique({
      where: { ownerCoadminUserId }
    });
    if (existing) {
      if (existing.qualificationCreditPolicy !== WHEEL_PRODUCT_QUALIFICATION_POLICY) {
        const updated = await this.prisma.leaderboardWheelConfig.update({
          where: { id: existing.id },
          data: { qualificationCreditPolicy: WHEEL_PRODUCT_QUALIFICATION_POLICY }
        });
        return this.mapConfig(updated);
      }
      return this.mapConfig(existing);
    }
    const created = await this.prisma.leaderboardWheelConfig.create({
      data: {
        workspaceId,
        ownerCoadminUserId,
        enabled: false,
        qualificationCreditPolicy: WHEEL_PRODUCT_QUALIFICATION_POLICY
      }
    });
    return this.mapConfig(created);
  }

  /**
   * Creates (if needed) and activates the approved Phase 6.1 distribution for this Coadmin.
   */
  public async ensureApprovedDistributionVersion(input: {
    workspaceId: string;
    ownerCoadminUserId: string;
    createdByUserId: string;
    now?: Date;
  }): Promise<WheelConfigVersionRow> {
    const now = input.now ?? new Date();
    await this.ensureConfig(input.workspaceId, input.ownerCoadminUserId);

    const config = await this.prisma.leaderboardWheelConfig.findUniqueOrThrow({
      where: { ownerCoadminUserId: input.ownerCoadminUserId }
    });

    if (config.activeVersionId) {
      const active = await this.prisma.leaderboardWheelConfigVersion.findUnique({
        where: { id: config.activeVersionId }
      });
      if (active && isApprovedWheelDistribution(active.rewardDistributionJson)) {
        await this.prisma.leaderboardWheelConfig.update({
          where: { id: config.id },
          data: { qualificationCreditPolicy: WHEEL_PRODUCT_QUALIFICATION_POLICY }
        });
        return this.mapVersion(active);
      }
    }

    const versions = await this.prisma.leaderboardWheelConfigVersion.findMany({
      where: { ownerCoadminUserId: input.ownerCoadminUserId },
      orderBy: { createdAt: "desc" },
      take: 50
    });
    const existingApproved = versions.find((v) => isApprovedWheelDistribution(v.rewardDistributionJson));
    if (existingApproved) {
      return this.activateVersion({
        ownerCoadminUserId: input.ownerCoadminUserId,
        versionId: existingApproved.id,
        now
      });
    }

    const approved = getApprovedWheelDistribution();
    const created = await this.createVersion({
      workspaceId: input.workspaceId,
      ownerCoadminUserId: input.ownerCoadminUserId,
      createdByUserId: input.createdByUserId,
      distribution: approved.outcomes
    });
    return this.activateVersion({
      ownerCoadminUserId: input.ownerCoadminUserId,
      versionId: created.id,
      now
    });
  }

  public async createVersion(input: {
    workspaceId: string;
    ownerCoadminUserId: string;
    createdByUserId: string;
    distribution: unknown;
  }): Promise<WheelConfigVersionRow> {
    await this.ensureConfig(input.workspaceId, input.ownerCoadminUserId);
    const validated = parseRewardDistributionJson(input.distribution);
    const created = await this.prisma.leaderboardWheelConfigVersion.create({
      data: {
        workspaceId: input.workspaceId,
        ownerCoadminUserId: input.ownerCoadminUserId,
        createdByUserId: input.createdByUserId,
        rewardDistributionJson: validated.outcomes as unknown as Prisma.InputJsonValue
      }
    });
    return this.mapVersion(created);
  }

  public async activateVersion(input: {
    ownerCoadminUserId: string;
    versionId: string;
    now?: Date;
  }): Promise<WheelConfigVersionRow> {
    const now = input.now ?? new Date();
    return this.prisma.$transaction(async (tx) => {
      const version = await tx.leaderboardWheelConfigVersion.findFirst({
        where: { id: input.versionId, ownerCoadminUserId: input.ownerCoadminUserId }
      });
      if (!version) {
        throw new LeaderboardError("WHEEL_VERSION_NOT_FOUND", "Wheel config version was not found.");
      }
      parseRewardDistributionJson(version.rewardDistributionJson);
      const updated = await tx.leaderboardWheelConfigVersion.update({
        where: { id: version.id },
        data: { activatedAt: now }
      });
      await tx.leaderboardWheelConfig.upsert({
        where: { ownerCoadminUserId: input.ownerCoadminUserId },
        create: {
          workspaceId: version.workspaceId,
          ownerCoadminUserId: input.ownerCoadminUserId,
          activeVersionId: version.id,
          enabled: false,
          qualificationCreditPolicy: WHEEL_PRODUCT_QUALIFICATION_POLICY
        },
        update: {
          activeVersionId: version.id,
          qualificationCreditPolicy: WHEEL_PRODUCT_QUALIFICATION_POLICY
        }
      });
      return this.mapVersion(updated);
    });
  }

  public async patchSettings(input: {
    workspaceId: string;
    ownerCoadminUserId: string;
    enabled?: boolean;
    /** Ignored — Phase 6.1 locks CYCLE_DEPOSITS_ALL. */
    qualificationCreditPolicy?: WheelQualificationCreditPolicy;
    now?: Date;
  }): Promise<WheelConfigRow> {
    const now = input.now ?? new Date();
    if (input.enabled === true) {
      const existing = await this.prisma.leaderboardWheelConfig.findUnique({
        where: { ownerCoadminUserId: input.ownerCoadminUserId }
      });
      // Phase 6.1: seed approved distribution only when none is active.
      if (!existing?.activeVersionId) {
        await this.ensureApprovedDistributionVersion({
          workspaceId: input.workspaceId,
          ownerCoadminUserId: input.ownerCoadminUserId,
          createdByUserId: input.ownerCoadminUserId,
          now
        });
      }
    }
    return this.prisma.$transaction(async (tx) => {
      let config = await tx.leaderboardWheelConfig.findUnique({
        where: { ownerCoadminUserId: input.ownerCoadminUserId }
      });
      if (!config) {
        config = await tx.leaderboardWheelConfig.create({
          data: {
            workspaceId: input.workspaceId,
            ownerCoadminUserId: input.ownerCoadminUserId,
            enabled: false,
            qualificationCreditPolicy: WHEEL_PRODUCT_QUALIFICATION_POLICY
          }
        });
      }

      let nextEnabled = config.enabled;
      let nextEnabledAt = config.enabledAt;

      if (input.enabled !== undefined) {
        if (input.enabled) {
          if (!config.activeVersionId) throw wheelNotConfigured();
          const version = await tx.leaderboardWheelConfigVersion.findUnique({
            where: { id: config.activeVersionId }
          });
          if (!version) throw wheelNotConfigured();
          parseRewardDistributionJson(version.rewardDistributionJson);
          nextEnabled = true;
          nextEnabledAt = config.enabledAt ?? now;
        } else {
          nextEnabled = false;
        }
      }

      const updated = await tx.leaderboardWheelConfig.update({
        where: { id: config.id },
        data: {
          qualificationCreditPolicy: WHEEL_PRODUCT_QUALIFICATION_POLICY,
          enabled: nextEnabled,
          enabledAt: nextEnabledAt
        }
      });
      return this.mapConfig(updated);
    });
  }

  public async ensureCyclesForCompetition(competition: {
    id: string;
    workspaceId: string;
    ownerCoadminUserId: string;
    startsAt: Date;
    endsAt: Date;
  }): Promise<Array<{ id: string; sequence: number; startsAt: Date; endsAt: Date }>> {
    const windows = listCycles(competition);
    const rows = [];
    for (const window of windows) {
      const row = await this.prisma.leaderboardWheelCycle.upsert({
        where: {
          competitionId_sequence: {
            competitionId: competition.id,
            sequence: window.sequence
          }
        },
        create: {
          workspaceId: competition.workspaceId,
          ownerCoadminUserId: competition.ownerCoadminUserId,
          competitionId: competition.id,
          sequence: window.sequence,
          startsAt: window.startsAt,
          endsAt: window.endsAt
        },
        update: {}
      });
      rows.push(row);
    }
    return rows.sort((a, b) => a.sequence - b.sequence);
  }

  public async recomputeQualification(input: {
    ownerCoadminUserId: string;
    competition: {
      id: string;
      workspaceId: string;
      ownerCoadminUserId: string;
      status: string;
      startsAt: Date;
      endsAt: Date;
    };
    cycle: { id: string; startsAt: Date; endsAt: Date };
    crmContactId: string;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const config = await this.ensureConfig(
      input.competition.workspaceId,
      input.ownerCoadminUserId
    );
    const lastSpin = await this.findLatestSpin(input.ownerCoadminUserId, input.crmContactId);
    const cents = await this.sumRollingDepositCents({
      workspaceId: input.competition.workspaceId,
      ownerCoadminUserId: input.ownerCoadminUserId,
      crmContactId: input.crmContactId,
      now,
      lastSpinAt: lastSpin?.spunAt ?? null,
      policy: config.qualificationCreditPolicy,
      enabledAt: config.enabledAt
    });
    await this.maybeInvalidateLastSpin(input.ownerCoadminUserId, input.crmContactId, now);

    const existing = await this.prisma.leaderboardWheelQualification.findUnique({
      where: {
        cycleId_crmContactId: {
          cycleId: input.cycle.id,
          crmContactId: input.crmContactId
        }
      }
    });

    const cooldownOk = wheelCooldownSatisfied(now, lastSpin?.spunAt ?? null);
    const wheelReady =
      config.enabled &&
      config.activeVersionId != null &&
      input.competition.status === "ACTIVE";
    const qualified = isWheelQualified(cents);
    const available = qualified && cooldownOk && wheelReady;
    const qualifiedAt = qualified ? (existing?.qualifiedAt ?? now) : existing?.qualifiedAt ?? null;

    return this.prisma.leaderboardWheelQualification.upsert({
      where: {
        cycleId_crmContactId: {
          cycleId: input.cycle.id,
          crmContactId: input.crmContactId
        }
      },
      create: {
        workspaceId: input.competition.workspaceId,
        ownerCoadminUserId: input.ownerCoadminUserId,
        competitionId: input.competition.id,
        cycleId: input.cycle.id,
        crmContactId: input.crmContactId,
        qualifyingDepositCents: cents,
        qualifiedAt,
        available,
        consumedAt: null,
        spinId: null
      },
      update: {
        qualifyingDepositCents: cents,
        available,
        qualifiedAt
      }
    });
  }

  public async getStatus(
    workspaceId: string,
    ownerCoadminUserId: string,
    crmContactId: string,
    now = new Date()
  ): Promise<WheelPlayerStatus> {
    const config = await this.ensureConfig(workspaceId, ownerCoadminUserId);
    const competition = await this.prisma.leaderboardCompetition.findFirst({
      where: {
        workspaceId,
        ownerCoadminUserId,
        startsAt: { lte: now },
        endsAt: { gt: now }
      },
      orderBy: { sequence: "desc" }
    });

    const standing = competition
      ? await this.prisma.leaderboardStanding.findUnique({
          where: {
            competitionId_crmContactId: {
              competitionId: competition.id,
              crmContactId
            }
          }
        })
      : null;

    const lastSpin = await this.findLatestSpin(ownerCoadminUserId, crmContactId);
    const nextSpin = nextWheelSpinAt(lastSpin?.spunAt ?? null);
    const cents = await this.sumRollingDepositCents({
      workspaceId,
      ownerCoadminUserId,
      crmContactId,
      now,
      lastSpinAt: lastSpin?.spunAt ?? null,
      policy: config.qualificationCreditPolicy,
      enabledAt: config.enabledAt
    });
    await this.maybeInvalidateLastSpin(ownerCoadminUserId, crmContactId, now);
    const lastSpinFresh = lastSpin
      ? await this.prisma.leaderboardWheelSpin.findUnique({ where: { id: lastSpin.id } })
      : null;

    const qualified = isWheelQualified(cents);
    const cooldownOk = wheelCooldownSatisfied(now, lastSpin?.spunAt ?? null);
    const consumed = lastSpin != null && !cooldownOk;
    const window = competition ? cycleContaining(competition, now) : null;

    const base: WheelPlayerStatus = {
      wheelEnabled: config.enabled,
      configured: config.activeVersionId != null,
      competitionId: competition?.id ?? null,
      competitionStatus: competition?.status ?? null,
      cycleSequence: window?.sequence ?? null,
      cycleStartsAt: window?.startsAt.toISOString() ?? null,
      cycleEndsAt: window?.endsAt.toISOString() ?? null,
      qualifyingDepositCents: cents,
      qualificationCentsRequired: WHEEL_QUALIFICATION_CENTS,
      available: false,
      consumed,
      qualified,
      nextSpinAt: nextSpin?.toISOString() ?? null,
      pointsAwarded: consumed ? lastSpinFresh?.pointsAwarded ?? lastSpin?.pointsAwarded ?? null : null,
      qualificationInvalidated: lastSpinFresh?.qualificationInvalidatedAt != null,
      wheelPoints: standing?.wheelPoints ?? 0,
      reasonCode: null
    };

    if (!competition) return { ...base, reasonCode: "NO_COMPETITION" };
    if (competition.status !== "ACTIVE") {
      return { ...base, reasonCode: "COMPETITION_NOT_ACTIVE" };
    }
    if (!config.enabled) return { ...base, reasonCode: "WHEEL_DISABLED" };
    if (!config.activeVersionId) {
      return { ...base, reasonCode: "WHEEL_NOT_CONFIGURED" };
    }

    const available = qualified && cooldownOk;
    return {
      ...base,
      available,
      reasonCode: available
        ? null
        : !qualified
          ? "BELOW_QUALIFICATION"
          : consumed
            ? "COOLDOWN"
            : "NOT_AVAILABLE"
    };
  }

  public async spin(input: {
    workspaceId: string;
    crmContactId: string;
    idempotencyKey: string;
    actorUserId: string;
    now?: Date;
    rng?: WheelRng;
  }): Promise<WheelSpinResult & { ownerCoadminUserId: string }> {
    const now = input.now ?? new Date();
    const rng = input.rng ?? createCryptoWheelRng();

    const result = await this.prisma.$transaction(async (tx) => {
      const existingSpin = await tx.leaderboardWheelSpin.findUnique({
        where: { idempotencyKey: input.idempotencyKey }
      });
      if (existingSpin) {
        const event = await tx.leaderboardEvent.findUniqueOrThrow({
          where: { id: existingSpin.leaderboardEventId }
        });
        const standing = await tx.leaderboardStanding.findUniqueOrThrow({
          where: {
            competitionId_crmContactId: {
              competitionId: existingSpin.competitionId,
              crmContactId: existingSpin.crmContactId
            }
          }
        });
        return {
          spin: existingSpin,
          event,
          standing,
          replay: true as const,
          ownerCoadminUserId: existingSpin.ownerCoadminUserId
        };
      }

      const participant = await tx.leaderboardParticipant.findUnique({
        where: {
          workspaceId_crmContactId: {
            workspaceId: input.workspaceId,
            crmContactId: input.crmContactId
          }
        }
      });
      if (!participant) throw participantNotBound();
      const owner = participant.ownerCoadminUserId;

      const competition = await tx.leaderboardCompetition.findFirst({
        where: {
          workspaceId: input.workspaceId,
          ownerCoadminUserId: owner,
          status: "ACTIVE",
          startsAt: { lte: now },
          endsAt: { gt: now }
        }
      });
      if (!competition) throw wheelCompetitionNotActive();

      await tx.$executeRaw`SELECT id FROM leaderboard_competitions WHERE id = ${competition.id}::uuid FOR UPDATE`;
      await tx.$executeRaw`SELECT id FROM crm_contacts WHERE id = ${input.crmContactId}::uuid FOR UPDATE`;

      let config = await tx.leaderboardWheelConfig.findUnique({
        where: { ownerCoadminUserId: owner }
      });
      if (!config) {
        config = await tx.leaderboardWheelConfig.create({
          data: {
            workspaceId: input.workspaceId,
            ownerCoadminUserId: owner,
            enabled: false,
            qualificationCreditPolicy: WHEEL_PRODUCT_QUALIFICATION_POLICY
          }
        });
      } else if (config.qualificationCreditPolicy !== WHEEL_PRODUCT_QUALIFICATION_POLICY) {
        config = await tx.leaderboardWheelConfig.update({
          where: { id: config.id },
          data: { qualificationCreditPolicy: WHEEL_PRODUCT_QUALIFICATION_POLICY }
        });
      }
      if (!config.enabled) throw wheelNotEnabled();
      if (!config.activeVersionId) throw wheelNotConfigured();
      const version = await tx.leaderboardWheelConfigVersion.findUnique({
        where: { id: config.activeVersionId }
      });
      if (!version) throw wheelNotConfigured();
      const distribution = parseRewardDistributionJson(version.rewardDistributionJson);

      const windows = listCycles(competition);
      for (const window of windows) {
        await tx.leaderboardWheelCycle.upsert({
          where: {
            competitionId_sequence: {
              competitionId: competition.id,
              sequence: window.sequence
            }
          },
          create: {
            workspaceId: competition.workspaceId,
            ownerCoadminUserId: owner,
            competitionId: competition.id,
            sequence: window.sequence,
            startsAt: window.startsAt,
            endsAt: window.endsAt
          },
          update: {}
        });
      }
      const window = cycleContaining(competition, now);
      if (!window) throw wheelNotAvailable("No wheel cycle for the current time.");
      const cycle = await tx.leaderboardWheelCycle.findUniqueOrThrow({
        where: {
          competitionId_sequence: {
            competitionId: competition.id,
            sequence: window.sequence
          }
        }
      });

      // Upsert qualification then lock row.
      await tx.leaderboardWheelQualification.upsert({
        where: {
          cycleId_crmContactId: { cycleId: cycle.id, crmContactId: input.crmContactId }
        },
        create: {
          workspaceId: input.workspaceId,
          ownerCoadminUserId: owner,
          competitionId: competition.id,
          cycleId: cycle.id,
          crmContactId: input.crmContactId,
          qualifyingDepositCents: 0,
          available: false
        },
        update: {}
      });
      await tx.$executeRaw`SELECT id FROM leaderboard_wheel_qualifications WHERE cycle_id = ${cycle.id}::uuid AND crm_contact_id = ${input.crmContactId}::uuid FOR UPDATE`;

      const lastSpin = await tx.leaderboardWheelSpin.findFirst({
        where: { ownerCoadminUserId: owner, crmContactId: input.crmContactId },
        orderBy: { spunAt: "desc" }
      });
      if (!wheelCooldownSatisfied(now, lastSpin?.spunAt ?? null)) {
        throw wheelAlreadyConsumed();
      }

      const cents = await this.sumRollingDepositCentsTx(tx, {
        workspaceId: input.workspaceId,
        ownerCoadminUserId: owner,
        crmContactId: input.crmContactId,
        now,
        lastSpinAt: lastSpin?.spunAt ?? null,
        policy: config.qualificationCreditPolicy,
        enabledAt: config.enabledAt
      });

      let qual = await tx.leaderboardWheelQualification.findUniqueOrThrow({
        where: {
          cycleId_crmContactId: { cycleId: cycle.id, crmContactId: input.crmContactId }
        }
      });

      const wheelReady =
        config.enabled && config.activeVersionId != null && competition.status === "ACTIVE";
      const qualified = isWheelQualified(cents);
      const available = qualified && wheelReady;

      qual = await tx.leaderboardWheelQualification.update({
        where: { id: qual.id },
        data: {
          qualifyingDepositCents: cents,
          available,
          qualifiedAt: qualified ? (qual.qualifiedAt ?? now) : qual.qualifiedAt
        }
      });

      if (!available) {
        throw wheelNotAvailable(
          !qualified
            ? `Need $${(WHEEL_QUALIFICATION_CENTS / 100).toFixed(0)} in qualifying deposits from the last 48 hours to spin.`
            : "Wheel spin is not available."
        );
      }

      const points = selectWeightedPoints(distribution.outcomes, rng);
      if (points < WHEEL_MIN_POINTS || points > WHEEL_MAX_POINTS) {
        throw new LeaderboardError("WHEEL_RNG_INVALID", "RNG produced out-of-range wheel points.");
      }

      const standings = await tx.leaderboardStanding.findMany({
        where: { competitionId: competition.id, ownerCoadminUserId: owner }
      });
      const rankedBefore = withRanks(
        standings.map((s) => ({
          crmContactId: s.crmContactId,
          totalPoints: s.totalPoints,
          pointsReachedAt: s.pointsReachedAt
        }))
      );
      const previousRank =
        rankedBefore.find((r) => r.crmContactId === input.crmContactId)?.rank ?? null;

      let standing = standings.find((s) => s.crmContactId === input.crmContactId);
      if (!standing) {
        standing = await tx.leaderboardStanding.create({
          data: {
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
            pointsReachedAt: now
          }
        });
      }

      const event = await tx.leaderboardEvent.create({
        data: {
          workspaceId: input.workspaceId,
          ownerCoadminUserId: owner,
          competitionId: competition.id,
          crmContactId: input.crmContactId,
          type: "WHEEL_SPIN",
          pointsDelta: points,
          actorUserId: input.actorUserId,
          reason: "wheel_spin",
          metadataJson: {
            cycleId: cycle.id,
            cycleSequence: cycle.sequence,
            configVersionId: version.id,
            kind: "WHEEL_SPIN"
          },
          occurredAt: now,
          idempotencyKey: input.idempotencyKey
        }
      });

      const nextWheelPoints = standing.wheelPoints + points;
      const nextTotal =
        standing.depositPoints +
        standing.referralPoints +
        standing.promotionPoints +
        nextWheelPoints;

      standing = await tx.leaderboardStanding.update({
        where: { id: standing.id },
        data: {
          wheelPoints: nextWheelPoints,
          totalPoints: nextTotal,
          ...(points !== 0 ? { pointsReachedAt: now } : {}),
          lastEventId: event.id,
          lastEventAt: now,
          lastEventType: "WHEEL_SPIN",
          lastEventReason: "wheel_spin"
        }
      });

      const standingsAfter = await tx.leaderboardStanding.findMany({
        where: { competitionId: competition.id, ownerCoadminUserId: owner }
      });
      const rankedAfter = withRanks(
        standingsAfter.map((s) => ({
          crmContactId: s.crmContactId,
          totalPoints: s.totalPoints,
          pointsReachedAt: s.pointsReachedAt
        }))
      );
      const resultingRank =
        rankedAfter.find((r) => r.crmContactId === input.crmContactId)?.rank ?? null;

      const spin = await tx.leaderboardWheelSpin.create({
        data: {
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
          rngMetaJson: { source: input.rng ? "injected" : "crypto", points }
        }
      });

      await tx.leaderboardWheelQualification.update({
        where: { id: qual.id },
        data: {
          available: false,
          consumedAt: now,
          spinId: spin.id
        }
      });

      return {
        spin,
        event,
        standing,
        replay: false as const,
        ownerCoadminUserId: owner
      };
    });

    return {
      spin: {
        id: result.spin.id,
        workspaceId: result.spin.workspaceId,
        ownerCoadminUserId: result.spin.ownerCoadminUserId,
        competitionId: result.spin.competitionId,
        cycleId: result.spin.cycleId,
        crmContactId: result.spin.crmContactId,
        pointsAwarded: result.spin.pointsAwarded,
        configVersionId: result.spin.configVersionId,
        idempotencyKey: result.spin.idempotencyKey,
        spunAt: result.spin.spunAt,
        leaderboardEventId: result.spin.leaderboardEventId,
        previousRank: result.spin.previousRank,
        resultingRank: result.spin.resultingRank,
        rngMetaJson: (result.spin.rngMetaJson as Record<string, unknown> | null) ?? null,
        qualificationInvalidatedAt: result.spin.qualificationInvalidatedAt,
        createdAt: result.spin.createdAt
      },
      event: {
        id: result.event.id,
        workspaceId: result.event.workspaceId,
        ownerCoadminUserId: result.event.ownerCoadminUserId,
        competitionId: result.event.competitionId,
        crmContactId: result.event.crmContactId,
        type: result.event.type as WheelSpinResult["event"]["type"],
        pointsDelta: result.event.pointsDelta,
        depositAmountCents: result.event.depositAmountCents,
        poolContributionCents: result.event.poolContributionCents,
        poolRateBpsApplied: result.event.poolRateBpsApplied,
        actorUserId: result.event.actorUserId,
        reason: result.event.reason,
        metadataJson: (result.event.metadataJson as Record<string, unknown>) ?? {},
        occurredAt: result.event.occurredAt,
        idempotencyKey: result.event.idempotencyKey,
        reversesEventId: result.event.reversesEventId,
        createdAt: result.event.createdAt
      },
      standing: {
        id: result.standing.id,
        workspaceId: result.standing.workspaceId,
        ownerCoadminUserId: result.standing.ownerCoadminUserId,
        competitionId: result.standing.competitionId,
        crmContactId: result.standing.crmContactId,
        totalPoints: result.standing.totalPoints,
        depositPoints: result.standing.depositPoints,
        referralPoints: result.standing.referralPoints,
        promotionPoints: result.standing.promotionPoints,
        wheelPoints: result.standing.wheelPoints,
        qualifyingDepositCents: result.standing.qualifyingDepositCents,
        successfulReferralCount: result.standing.successfulReferralCount,
        pointsReachedAt: result.standing.pointsReachedAt,
        lastEventId: result.standing.lastEventId,
        lastEventAt: result.standing.lastEventAt,
        lastEventType: result.standing.lastEventType as WheelSpinResult["standing"]["lastEventType"],
        lastEventReason: result.standing.lastEventReason,
        createdAt: result.standing.createdAt,
        updatedAt: result.standing.updatedAt
      },
      replay: result.replay,
      ownerCoadminUserId: result.ownerCoadminUserId
    };
  }

  /** Post-commit hook after deposit/reversal — never inside deposit TX. */
  public async recomputeAfterDepositMutation(input: {
    workspaceId: string;
    ownerCoadminUserId: string;
    competitionId: string;
    crmContactId: string;
    now?: Date;
  }): Promise<void> {
    const now = input.now ?? new Date();
    await this.maybeInvalidateLastSpin(input.ownerCoadminUserId, input.crmContactId, now);
  }

  private async findLatestSpin(ownerCoadminUserId: string, crmContactId: string) {
    return this.prisma.leaderboardWheelSpin.findFirst({
      where: { ownerCoadminUserId, crmContactId },
      orderBy: { spunAt: "desc" }
    });
  }

  private async maybeInvalidateLastSpin(
    ownerCoadminUserId: string,
    crmContactId: string,
    now: Date
  ): Promise<void> {
    const spins = await this.prisma.leaderboardWheelSpin.findMany({
      where: { ownerCoadminUserId, crmContactId },
      orderBy: { spunAt: "desc" },
      take: 2
    });
    const lastSpin = spins[0];
    if (!lastSpin || lastSpin.qualificationInvalidatedAt != null) return;
    const events = await this.prisma.leaderboardEvent.findMany({
      where: {
        ownerCoadminUserId,
        crmContactId,
        type: { in: ["DEPOSIT", "DEPOSIT_REVERSAL"] }
      },
      select: { type: true, depositAmountCents: true, occurredAt: true }
    });
    const consumedCents = sumConsumedQualificationCents(
      events,
      lastSpin.spunAt,
      spins[1]?.spunAt ?? null
    );
    if (consumedCents < WHEEL_QUALIFICATION_CENTS) {
      await this.prisma.leaderboardWheelSpin.updateMany({
        where: { id: lastSpin.id, qualificationInvalidatedAt: null },
        data: { qualificationInvalidatedAt: now }
      });
    }
  }

  private async sumRollingDepositCents(input: {
    workspaceId: string;
    ownerCoadminUserId: string;
    crmContactId: string;
    now: Date;
    lastSpinAt: Date | null;
    policy: WheelQualificationCreditPolicy;
    enabledAt: Date | null;
  }): Promise<number> {
    return this.sumRollingDepositCentsTx(this.prisma, input);
  }

  private async sumRollingDepositCentsTx(
    db: PrismaClient | Tx,
    input: {
      workspaceId: string;
      ownerCoadminUserId: string;
      crmContactId: string;
      now: Date;
      lastSpinAt: Date | null;
      policy: WheelQualificationCreditPolicy;
      enabledAt: Date | null;
    }
  ): Promise<number> {
    if (input.policy === "UNSET") return 0;
    const filter = qualificationOccurredAtFilter(input.now, input.lastSpinAt);
    const occurredAt: { gte?: Date; gt?: Date; lte: Date } = { ...filter };
    if (input.policy === "CYCLE_DEPOSITS_AFTER_ENABLE") {
      if (!input.enabledAt) return 0;
      const floor = Math.max(
        (occurredAt.gte ?? occurredAt.gt ?? input.now).getTime(),
        input.enabledAt.getTime()
      );
      if (occurredAt.gte) occurredAt.gte = new Date(Math.max(occurredAt.gte.getTime(), floor));
    }
    const events = await db.leaderboardEvent.findMany({
      where: {
        workspaceId: input.workspaceId,
        ownerCoadminUserId: input.ownerCoadminUserId,
        crmContactId: input.crmContactId,
        type: { in: ["DEPOSIT", "DEPOSIT_REVERSAL"] },
        occurredAt
      },
      select: { depositAmountCents: true }
    });
    let cents = 0;
    for (const event of events) cents += event.depositAmountCents ?? 0;
    return Math.max(0, cents);
  }

  private mapConfig(row: {
    id: string;
    workspaceId: string;
    ownerCoadminUserId: string;
    enabled: boolean;
    qualificationCreditPolicy: WheelQualificationCreditPolicy;
    enabledAt: Date | null;
    activeVersionId: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): WheelConfigRow {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      ownerCoadminUserId: row.ownerCoadminUserId,
      enabled: row.enabled,
      qualificationCreditPolicy: row.qualificationCreditPolicy,
      enabledAt: row.enabledAt,
      activeVersionId: row.activeVersionId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    };
  }

  private mapVersion(row: {
    id: string;
    ownerCoadminUserId: string;
    workspaceId: string;
    rewardDistributionJson: Prisma.JsonValue;
    createdAt: Date;
    createdByUserId: string;
    activatedAt: Date | null;
  }): WheelConfigVersionRow {
    const validated = parseRewardDistributionJson(row.rewardDistributionJson);
    return {
      id: row.id,
      ownerCoadminUserId: row.ownerCoadminUserId,
      workspaceId: row.workspaceId,
      rewardDistributionJson: [...validated.outcomes],
      createdAt: row.createdAt,
      createdByUserId: row.createdByUserId,
      activatedAt: row.activatedAt
    };
  }
}
