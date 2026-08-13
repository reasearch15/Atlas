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
      findUnique: async ({ where }: any) =>
        integrations.find((r) => r.ownerCoadminUserId === where.ownerCoadminUserId) ?? null,
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
      }
    },
    leaderboardTelegramOutbox: {
      findUnique: async ({ where }: any) => {
        if (where.id) return outbox.find((r) => r.id === where.id) ?? null;
        if (where.idempotencyKey) return outbox.find((r) => r.idempotencyKey === where.idempotencyKey) ?? null;
        return null;
      },
      findMany: async ({ where }: any) => {
        return outbox.filter((r) => {
          if (where?.ownerCoadminUserId && r.ownerCoadminUserId !== where.ownerCoadminUserId) return false;
          if (where?.status?.in && !where.status.in.includes(r.status)) return false;
          return true;
        });
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
          if (where.status?.in && !where.status.in.includes(row.status)) continue;
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
    leaderboardCompetition: {
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
        contacts.find((c) => c.id === where.id && c.workspaceId === where.workspaceId) ?? null
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
    _state: { integrations, outbox, competitions, standings, candidates, contacts, settings, payouts, audits }
  };

  return prisma as any;
}
