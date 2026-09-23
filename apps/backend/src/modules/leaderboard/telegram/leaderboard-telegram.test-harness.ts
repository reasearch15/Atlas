/** Shared in-memory Prisma harness for leaderboard Telegram unit tests. */
export function createMemoryPrisma() {
  const integrations: any[] = [];
  const outbox: any[] = [];
  const competitions: any[] = [];
  const standings: any[] = [];
  const candidates: any[] = [];
  const contacts: any[] = [];
  const settings: any[] = [];
  const payouts: any[] = [];
  const audits: any[] = [];
  const playerLinks: any[] = [];
  const wheelConfigs: any[] = [];
  const artifacts: any[] = [];

  const prisma = {
    leaderboardBotPlayerLink: {
      findFirst: async ({ where }: any) =>
        playerLinks.find((l) => {
          if (where.ownerCoadminUserId && l.ownerCoadminUserId !== where.ownerCoadminUserId) return false;
          if (where.crmContactId && l.crmContactId !== where.crmContactId) return false;
          if (where.botIntegrationId && l.botIntegrationId !== where.botIntegrationId) return false;
          return true;
        }) ?? null
    },
    leaderboardBotIntegration: {
      findUnique: async ({ where }: any) => {
        if (where.id) return integrations.find((r) => r.id === where.id) ?? null;
        if (where.ownerCoadminUserId) {
          return integrations.find((r) => r.ownerCoadminUserId === where.ownerCoadminUserId) ?? null;
        }
        return null;
      },
      upsert: async ({ where, create, update }: any) => {
        const existing = integrations.find((r) => r.ownerCoadminUserId === where.ownerCoadminUserId);
        if (!existing) {
          const row = {
            id: crypto.randomUUID(),
            createdAt: new Date(),
            updatedAt: new Date(),
            lastVerifiedAt: null,
            lastChannelVerifiedAt: null,
            lastSuccessfulPostAt: null,
            lastMembershipCheckAt: null,
            persistentMessageId: null,
            persistentMessageCompetitionId: null,
            lastPublicTop10Json: null,
            channelId: null,
            channelTitle: null,
            channelUsername: null,
            postingEnabled: false,
            lastError: null,
            disconnectedAt: null,
            ...create
          };
          integrations.push(row);
          return row;
        }
        Object.assign(existing, update, { updatedAt: new Date() });
        return existing;
      },
      update: async ({ where, data }: any) => {
        const row = integrations.find((r) => r.id === where.id);
        if (!row) throw new Error("integration missing");
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const row of integrations) {
          if (where.id && row.id !== where.id) continue;
          if (where.ownerCoadminUserId && row.ownerCoadminUserId !== where.ownerCoadminUserId) continue;
          if ("channelId" in where && row.channelId !== where.channelId) continue;
          if ("persistentMessageId" in where && row.persistentMessageId !== where.persistentMessageId) {
            continue;
          }
          Object.assign(row, data, { updatedAt: new Date() });
          count += 1;
        }
        return { count };
      }
    },
    leaderboardTelegramOutbox: {
      findUnique: async ({ where }: any) => {
        if (where.id) return outbox.find((r) => r.id === where.id) ?? null;
        if (where.idempotencyKey) return outbox.find((r) => r.idempotencyKey === where.idempotencyKey) ?? null;
        return null;
      },
      findMany: async ({ where }: any) => {
        let rows = outbox.filter((r) => {
          if (where?.workspaceId && r.workspaceId !== where.workspaceId) return false;
          if (where?.ownerCoadminUserId && r.ownerCoadminUserId !== where.ownerCoadminUserId) return false;
          if (where?.competitionId && r.competitionId !== where.competitionId) return false;
          if (typeof where?.jobType === "string" && r.jobType !== where.jobType) return false;
          if (where?.jobType?.in && !where.jobType.in.includes(r.jobType)) return false;
          if (where?.status?.in && !where.status.in.includes(r.status)) return false;
          if (where?.idempotencyKey?.startsWith && !r.idempotencyKey.startsWith(where.idempotencyKey.startsWith)) {
            return false;
          }
          return true;
        });
        rows = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        return rows;
      },
      create: async ({ data }: any) => {
        if (outbox.some((r) => r.idempotencyKey === data.idempotencyKey)) {
          const err = new Error("Unique") as Error & { code: string };
          err.code = "P2002";
          throw err;
        }
        const row = {
          id: crypto.randomUUID(),
          attemptCount: 0,
          nextAttemptAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          succeededAt: null,
          failedAt: null,
          cancelledAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data
        };
        outbox.push(row);
        return row;
      },
      upsert: async ({ where, create, update }: any) => {
        const existing = outbox.find((r) => r.idempotencyKey === where.idempotencyKey);
        if (existing) {
          Object.assign(existing, update, { updatedAt: new Date() });
          return existing;
        }
        return prisma.leaderboardTelegramOutbox.create({ data: create });
      },
      update: async ({ where, data }: any) => {
        const row = outbox.find((r) => r.id === where.id);
        if (!row) throw new Error("outbox missing");
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const row of outbox) {
          if (where.id && row.id !== where.id) continue;
          if (where.ownerCoadminUserId && row.ownerCoadminUserId !== where.ownerCoadminUserId) continue;
          if (typeof where.status === "string" && row.status !== where.status) continue;
          if (where.status?.in && !where.status.in.includes(row.status)) continue;
          if (where.updatedAt?.lte) {
            const updated = row.updatedAt ? new Date(row.updatedAt).getTime() : 0;
            if (updated > new Date(where.updatedAt.lte).getTime()) continue;
          }
          for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
            if (value && typeof value === "object" && value !== null && "increment" in value) {
              const current = typeof row[key] === "number" ? row[key] : 0;
              row[key] = current + (value as { increment: number }).increment;
            } else {
              row[key] = value;
            }
          }
          row.updatedAt = new Date();
          count += 1;
        }
        return { count };
      }
    },
    leaderboardTelegramArtifact: {
      findUnique: async ({ where }: any) => {
        if (where.id) return artifacts.find((a) => a.id === where.id) ?? null;
        const key = where.competitionId_artifactType;
        return artifacts.find((a) => a.competitionId === key.competitionId && a.artifactType === key.artifactType) ?? null;
      },
      findMany: async ({ where }: any) => artifacts.filter((a) => {
        if (where.competitionId && a.competitionId !== where.competitionId) return false;
        if (where.artifactType?.in && !where.artifactType.in.includes(a.artifactType)) return false;
        return true;
      }),
      create: async ({ data }: any) => {
        const row = { id: crypto.randomUUID(), messageId: null, sentAt: null, createdAt: new Date(), updatedAt: new Date(), ...data };
        artifacts.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = artifacts.find((a) => a.id === where.id);
        if (!row) throw new Error("artifact missing");
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
      deleteMany: async ({ where }: any) => {
        let count = 0;
        for (let index = artifacts.length - 1; index >= 0; index -= 1) {
          const row = artifacts[index];
          if (where.id && row.id !== where.id) continue;
          if (where.status && row.status !== where.status) continue;
          if (where.messageId === null && row.messageId !== null) continue;
          artifacts.splice(index, 1);
          count += 1;
        }
        return { count };
      }
    },
    leaderboardCompetition: {
      findMany: async ({ where }: any) => competitions.filter((c) => {
        if (where.id && c.id !== where.id) return false;
        if (where.status && c.status !== where.status) return false;
        if (where.finalizedAt?.gte && (!c.finalizedAt || c.finalizedAt < where.finalizedAt.gte)) return false;
        if (where.finalizedAt?.lte && (!c.finalizedAt || c.finalizedAt > where.finalizedAt.lte)) return false;
        return true;
      }).map((c) => ({
        ...c,
        snapshot: c.snapshot ?? null,
        payouts: payouts.filter((p) => p.competitionId === c.id),
        eligibilityCandidates: candidates.filter((candidate) => candidate.competitionId === c.id)
      })),
      findFirst: async ({ where }: any) =>
        competitions.find((c) => {
          if (where.id && c.id !== where.id) return false;
          if (where.workspaceId && c.workspaceId !== where.workspaceId) return false;
          if (where.ownerCoadminUserId && c.ownerCoadminUserId !== where.ownerCoadminUserId) return false;
          if (where.status) {
            if (typeof where.status === "string" && c.status !== where.status) return false;
            if (where.status.in && !where.status.in.includes(c.status)) return false;
          }
          return true;
        }) ?? null,
      findUniqueOrThrow: async ({ where }: any) => {
        const row = competitions.find((c) => c.id === where.id);
        if (!row) throw new Error("competition missing");
        return row;
      }
    },
    leaderboardStanding: {
      findMany: async ({ where }: any) =>
        standings
          .filter(
            (s) =>
              s.competitionId === where.competitionId &&
              (!where.workspaceId || s.workspaceId === where.workspaceId) &&
              (!where.ownerCoadminUserId || s.ownerCoadminUserId === where.ownerCoadminUserId)
          )
          .map((s) => ({
            ...s,
            crmContact: s.crmContact ?? { displayName: "Player", chats: [] }
          }))
    },
    leaderboardSettings: {
      findUnique: async ({ where }: any) =>
        settings.find((s) => s.ownerCoadminUserId === where.ownerCoadminUserId) ?? null
    },
    leaderboardWheelConfig: {
      findUnique: async ({ where }: any) => {
        const row =
          wheelConfigs.find((w) => w.ownerCoadminUserId === where.ownerCoadminUserId) ?? null;
        if (!row) return null;
        return row;
      }
    },
    giveawayEligibilityCandidate: {
      findFirst: async ({ where }: any) =>
        candidates.find((c) => {
          if (where.workspaceId && c.workspaceId !== where.workspaceId) return false;
          if (where.ownerCoadminUserId && c.ownerCoadminUserId !== where.ownerCoadminUserId) return false;
          if (where.membershipStatus && c.membershipStatus !== where.membershipStatus) return false;
          return true;
        }) ?? null,
      findMany: async ({ where }: any) =>
        candidates
          .filter(
            (c) =>
              c.competitionId === where.competitionId &&
              c.ownerCoadminUserId === where.ownerCoadminUserId
          )
          .sort((a, b) => a.leaderboardRank - b.leaderboardRank)
    },
    crmContact: {
      findFirst: async ({ where }: any) =>
        contacts.find((c) => {
          if (where?.id && c.id !== where.id) return false;
          if (where?.workspaceId && c.workspaceId !== where.workspaceId) return false;
          return true;
        }) ?? null,
      findUnique: async ({ where }: any) => contacts.find((c) => c.id === where.id) ?? null,
      update: async ({ where, data }: any) => {
        const row = contacts.find((c) => c.id === where.id);
        if (!row) throw new Error("contact missing");
        Object.assign(row, data, { updatedAt: new Date() });
        for (const standing of standings) {
          if (standing.crmContactId === where.id && standing.crmContact) {
            Object.assign(standing.crmContact, data);
          }
        }
        return row;
      }
    },
    giveawayPayout: {
      findMany: async ({ where }: any) =>
        payouts
          .filter(
            (p) =>
              p.competitionId === where.competitionId &&
              p.ownerCoadminUserId === where.ownerCoadminUserId
          )
          .sort((a, b) => a.prizeRank - b.prizeRank)
    },
    auditLog: {
      create: async ({ data }: any) => {
        audits.push(data);
        return data;
      }
    },
    _state: {
      integrations,
      outbox,
      competitions,
      standings,
      candidates,
      contacts,
      settings,
      payouts,
      audits,
      playerLinks,
      wheelConfigs,
      artifacts
    }
  };

  return prisma as any;
}
