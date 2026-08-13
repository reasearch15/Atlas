import { describe, expect, it } from "vitest";
import { encryptSecret } from "@atlas/shared/session-encryption";
import { tryAutoBindParticipant } from "../auto-bind";
import { backfillLeaderboardParticipants } from "../backfill-participants";
import { LeaderboardError } from "../leaderboard.errors";
import {
  classifyContactBindability,
  resolveDeterministicLeaderboardOwner
} from "../ownership-resolution";
import { LeaderboardBotUpdateHandler } from "./bot-update-handler";
import {
  createFakeLeaderboardTelegramClient,
  LeaderboardTelegramApiError,
  type FakeLeaderboardTelegramState
} from "./leaderboard-telegram.client";
import { LeaderboardTelegramOutboxService } from "./leaderboard-telegram.outbox";
import { LeaderboardTelegramProcessor } from "./leaderboard-telegram.processor";
import {
  formatPersonalFinalResultMessage,
  formatPersonalRankMessage
} from "./personal-rank-message";
import { decidePlayerNotification } from "./player-notification-policy";
import { formatPublicLeaderboardMessage } from "./public-message";

const encryptionKey = "k".repeat(64);
const workspaceId = "11111111-1111-4111-8111-111111111111";
const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ownerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const integrationA = "i1111111-iiii-4iii-8iii-iiiiiiiiiii1";
const competitionA = "c1111111-cccc-4ccc-8ccc-ccccccccccc1";
const contact1 = "d1111111-dddd-4ddd-8ddd-ddddddddddd1";

function createPhase5Prisma() {
  const users: any[] = [];
  const contacts: any[] = [];
  const participants: any[] = [];
  const integrations: any[] = [];
  const playerLinks: any[] = [];
  const telegramUpdates: any[] = [];
  const competitions: any[] = [];
  const standings: any[] = [];
  const settings: any[] = [];
  const outbox: any[] = [];
  const candidates: any[] = [];
  const payouts: any[] = [];
  const audits: any[] = [];

  const prisma: any = {
    user: {
      findMany: async ({ where, take }: any) => {
        let rows = users.filter(
          (u) =>
            u.workspaceId === where.workspaceId &&
            u.role === where.role &&
            u.status === where.status
        );
        rows = [...rows].sort((a, b) => a.id.localeCompare(b.id));
        if (take != null) rows = rows.slice(0, take);
        return rows.map((u) => ({ id: u.id }));
      }
    },
    crmContact: {
      findFirst: async ({ where }: any) =>
        contacts.find((c) => c.id === where.id && c.workspaceId === where.workspaceId) ?? null,
      findUnique: async ({ where }: any) => {
        if (where.workspaceId_telegramPeerId) {
          return (
            contacts.find(
              (c) =>
                c.workspaceId === where.workspaceId_telegramPeerId.workspaceId &&
                c.telegramPeerId === where.workspaceId_telegramPeerId.telegramPeerId
            ) ?? null
          );
        }
        return contacts.find((c) => c.id === where.id) ?? null;
      },
      findMany: async ({ where }: any) =>
        contacts.filter((c) => {
          if (where.workspaceId && c.workspaceId !== where.workspaceId) return false;
          if (where.kind && c.kind !== where.kind) return false;
          return true;
        }),
      create: async ({ data }: any) => {
        const row = { id: crypto.randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...data };
        contacts.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = contacts.find((c) => c.id === where.id);
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      }
    },
    leaderboardParticipant: {
      findMany: async ({ where }: any) =>
        participants.filter((p) => {
          if (where.workspaceId && p.workspaceId !== where.workspaceId) return false;
          if (where.crmContactId && p.crmContactId !== where.crmContactId) return false;
          return true;
        }),
      create: async ({ data }: any) => {
        if (
          participants.some(
            (p) => p.workspaceId === data.workspaceId && p.crmContactId === data.crmContactId
          )
        ) {
          const err = new Error("Unique") as Error & { code: string };
          err.code = "P2002";
          throw err;
        }
        const row = { id: crypto.randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...data };
        participants.push(row);
        return row;
      }
    },
    leaderboardBotIntegration: {
      findUnique: async ({ where }: any) => {
        if (where.id) return integrations.find((r) => r.id === where.id) ?? null;
        if (where.ownerCoadminUserId)
          return integrations.find((r) => r.ownerCoadminUserId === where.ownerCoadminUserId) ?? null;
        return null;
      },
      update: async ({ where, data }: any) => {
        const row = integrations.find((r) => r.id === where.id);
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const row of integrations) {
          if (where.id && row.id !== where.id) continue;
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
    leaderboardBotPlayerLink: {
      findUnique: async ({ where }: any) => {
        if (where.botIntegrationId_telegramUserId) {
          const key = where.botIntegrationId_telegramUserId;
          return (
            playerLinks.find(
              (l) =>
                l.botIntegrationId === key.botIntegrationId &&
                l.telegramUserId === key.telegramUserId
            ) ?? null
          );
        }
        return playerLinks.find((l) => l.id === where.id) ?? null;
      },
      findFirst: async ({ where }: any) =>
        playerLinks.find((l) => {
          if (where.botIntegrationId && l.botIntegrationId !== where.botIntegrationId) return false;
          if (where.ownerCoadminUserId && l.ownerCoadminUserId !== where.ownerCoadminUserId)
            return false;
          if (where.crmContactId && l.crmContactId !== where.crmContactId) return false;
          return true;
        }) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const key = where.botIntegrationId_telegramUserId;
        const existing = playerLinks.find(
          (l) =>
            l.botIntegrationId === key.botIntegrationId && l.telegramUserId === key.telegramUserId
        );
        if (!existing) {
          const row = { id: crypto.randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...create };
          playerLinks.push(row);
          return row;
        }
        Object.assign(existing, update, { updatedAt: new Date() });
        return existing;
      },
      update: async ({ where, data }: any) => {
        const row = playerLinks.find((l) => l.id === where.id);
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      }
    },
    leaderboardTelegramUpdate: {
      create: async ({ data }: any) => {
        if (
          telegramUpdates.some(
            (u) => u.botIntegrationId === data.botIntegrationId && u.updateId === data.updateId
          )
        ) {
          const err = new Error("Unique") as Error & { code: string };
          err.code = "P2002";
          throw err;
        }
        const row = { id: crypto.randomUUID(), ...data };
        telegramUpdates.push(row);
        return row;
      }
    },
    leaderboardCompetition: {
      findFirst: async ({ where }: any) => {
        let rows = competitions.filter((c) => {
          if (where.id && c.id !== where.id) return false;
          if (where.workspaceId && c.workspaceId !== where.workspaceId) return false;
          if (where.ownerCoadminUserId && c.ownerCoadminUserId !== where.ownerCoadminUserId)
            return false;
          if (where.status?.in && !where.status.in.includes(c.status)) return false;
          if (where.status && !where.status.in && c.status !== where.status) return false;
          return true;
        });
        if (where.status === "ACTIVE") {
          rows = rows.filter((c) => c.status === "ACTIVE");
        }
        return rows[0] ?? null;
      },
      findUniqueOrThrow: async ({ where }: any) => {
        const row = competitions.find((c) => c.id === where.id);
        if (!row) throw new Error("missing competition");
        return row;
      }
    },
    leaderboardStanding: {
      findMany: async ({ where }: any) =>
        standings.filter((s) => {
          if (where.competitionId && s.competitionId !== where.competitionId) return false;
          if (where.ownerCoadminUserId && s.ownerCoadminUserId !== where.ownerCoadminUserId)
            return false;
          return true;
        }),
      findFirst: async ({ where }: any) =>
        standings.find(
          (s) =>
            s.competitionId === where.competitionId &&
            s.ownerCoadminUserId === where.ownerCoadminUserId &&
            s.crmContactId === where.crmContactId
        ) ?? null
    },
    leaderboardSettings: {
      findUnique: async ({ where }: any) =>
        settings.find((s) => s.ownerCoadminUserId === where.ownerCoadminUserId) ?? null
    },
    leaderboardTelegramOutbox: {
      findUnique: async ({ where }: any) => {
        if (where.id) return outbox.find((r) => r.id === where.id) ?? null;
        if (where.idempotencyKey)
          return outbox.find((r) => r.idempotencyKey === where.idempotencyKey) ?? null;
        return null;
      },
      create: async ({ data }: any) => {
        const row = {
          id: crypto.randomUUID(),
          attemptCount: 0,
          status: "QUEUED",
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data
        };
        outbox.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = outbox.find((r) => r.id === where.id);
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
    giveawayEligibilityCandidate: {
      findMany: async ({ where }: any) =>
        candidates.filter((c) => {
          if (where.competitionId && c.competitionId !== where.competitionId) return false;
          if (where.ownerCoadminUserId && c.ownerCoadminUserId !== where.ownerCoadminUserId)
            return false;
          return true;
        }),
      findFirst: async ({ where }: any) =>
        candidates.find(
          (c) =>
            c.competitionId === where.competitionId &&
            c.ownerCoadminUserId === where.ownerCoadminUserId &&
            c.crmContactId === where.crmContactId
        ) ?? null
    },
    giveawayPayout: {
      findMany: async ({ where }: any) =>
        payouts.filter((p) => {
          if (where.competitionId && p.competitionId !== where.competitionId) return false;
          if (where.ownerCoadminUserId && p.ownerCoadminUserId !== where.ownerCoadminUserId)
            return false;
          return true;
        }),
      findFirst: async ({ where }: any) =>
        payouts.find(
          (p) =>
            p.competitionId === where.competitionId &&
            p.ownerCoadminUserId === where.ownerCoadminUserId &&
            p.crmContactId === where.crmContactId
        ) ?? null
    },
    $transaction: async (fn: any) => fn(prisma),
    _state: {
      users,
      contacts,
      participants,
      integrations,
      playerLinks,
      telegramUpdates,
      competitions,
      standings,
      settings,
      outbox,
      candidates,
      payouts,
      audits
    }
  };

  // Minimal AuditService dependency via prisma.auditLog if needed — PrismaLeaderboardService uses AuditService
  prisma.auditLog = {
    create: async ({ data }: any) => {
      audits.push(data);
      return data;
    }
  };

  return prisma;
}

class FakeDomain {
  constructor(private readonly prisma: any) {}
  async ensureSettings() {
    return { enabled: false };
  }
  async bindParticipant(input: {
    workspaceId: string;
    ownerCoadminUserId: string;
    crmContactId: string;
    createdByUserId?: string;
  }) {
    const existing = await this.prisma.leaderboardParticipant.findMany({
      where: { workspaceId: input.workspaceId, crmContactId: input.crmContactId }
    });
    if (existing.length === 1) {
      if (existing[0].ownerCoadminUserId !== input.ownerCoadminUserId) {
        throw new LeaderboardError(
          "PARTICIPANT_TRANSFER_UNSUPPORTED",
          "Transfer unsupported"
        );
      }
      return existing[0];
    }
    return this.prisma.leaderboardParticipant.create({ data: input });
  }
  async assertContact() {
    /* no-op for fake */
  }
}

describe("Phase 5 ownership resolution + backfill", () => {
  it("returns sole ACTIVE coadmin and null when ambiguous", async () => {
    const prisma = createPhase5Prisma();
    prisma._state.users.push({
      id: ownerA,
      workspaceId,
      role: "COADMIN",
      status: "ACTIVE"
    });
    await expect(resolveDeterministicLeaderboardOwner(prisma, workspaceId)).resolves.toBe(ownerA);

    prisma._state.users.push({
      id: ownerB,
      workspaceId,
      role: "COADMIN",
      status: "ACTIVE"
    });
    await expect(resolveDeterministicLeaderboardOwner(prisma, workspaceId)).resolves.toBeNull();
  });

  it("backfill skips when ownership is ambiguous", async () => {
    const prisma = createPhase5Prisma();
    prisma._state.users.push(
      { id: ownerA, workspaceId, role: "COADMIN", status: "ACTIVE" },
      { id: ownerB, workspaceId, role: "COADMIN", status: "ACTIVE" }
    );
    prisma._state.contacts.push({
      id: contact1,
      workspaceId,
      kind: "PRIVATE",
      telegramPeerId: "9001",
      displayName: "Player"
    });

    const result = await backfillLeaderboardParticipants(prisma, {
      workspaceId,
      ownerCoadminUserId: ownerA,
      dryRun: true
    });
    expect(result.ambiguous).toBeGreaterThan(0);
    expect(result.bound).toBe(0);
  });

  it("never silently transfers an already-bound participant", async () => {
    const prisma = createPhase5Prisma();
    prisma._state.users.push({ id: ownerA, workspaceId, role: "COADMIN", status: "ACTIVE" });
    prisma._state.contacts.push({
      id: contact1,
      workspaceId,
      kind: "PRIVATE",
      telegramPeerId: "9001",
      displayName: "Player"
    });
    prisma._state.participants.push({
      id: "p1",
      workspaceId,
      crmContactId: contact1,
      ownerCoadminUserId: ownerB
    });

    const classified = await classifyContactBindability(prisma, {
      workspaceId,
      crmContactId: contact1,
      ownerCoadminUserId: ownerA
    });
    expect(classified.classification).toBe("ALREADY_BOUND");

    const result = await tryAutoBindParticipant(
      prisma,
      {
        workspaceId,
        crmContactId: contact1,
        ownerCoadminUserId: ownerA,
        source: "CRM"
      },
      new FakeDomain(prisma) as any
    );
    expect(result.status).toBe("TRANSFER_REJECTED");
  });
});

describe("Phase 5 bot /start + /rank + isolation", () => {
  it("handles /start bind, /rank message, transfer reject, and update idempotency", async () => {
    const prisma = createPhase5Prisma();
    prisma._state.users.push({ id: ownerA, workspaceId, role: "COADMIN", status: "ACTIVE" });
    const token = "bot-token-a";
    const state: FakeLeaderboardTelegramState = {
      bots: new Map([
        [token, { id: 111, isBot: true, firstName: "Board", username: "AtlasBoardBot" }]
      ]),
      chats: new Map()
    };
    const client = createFakeLeaderboardTelegramClient(state);
    const encrypted = encryptSecret(token, encryptionKey);
    const webhookSecret = encryptSecret("whsec", encryptionKey);

    prisma._state.integrations.push({
      id: integrationA,
      workspaceId,
      ownerCoadminUserId: ownerA,
      encryptedBotToken: encrypted,
      encryptedWebhookSecret: webhookSecret,
      botUsername: "AtlasBoardBot",
      disconnectedAt: null,
      postingEnabled: false,
      channelId: null
    });
    prisma._state.competitions.push({
      id: competitionA,
      workspaceId,
      ownerCoadminUserId: ownerA,
      status: "ACTIVE",
      prizePoolCents: 62000,
      endsAt: new Date("2026-08-19T02:00:00.000Z"),
      sequence: 1
    });
    prisma._state.settings.push({
      ownerCoadminUserId: ownerA,
      timezone: "America/Chicago"
    });
    prisma._state.standings.push({
      competitionId: competitionA,
      ownerCoadminUserId: ownerA,
      crmContactId: contact1,
      totalPoints: 284,
      pointsReachedAt: new Date()
    });

    const handler = new LeaderboardBotUpdateHandler({
      prisma,
      client,
      encryptionKey,
      startTokenSecret: encryptionKey,
      domain: new FakeDomain(prisma) as any
    });

    // Seed contact id used later for standing lookup by binding a known contact via peer.
    // /start will upsert by telegramPeerId=555.
    const startResult = await handler.handleWebhook({
      integrationId: integrationA,
      secretHeader: "whsec",
      update: {
        update_id: 1,
        message: {
          message_id: 1,
          text: "/start",
          from: { id: 555, is_bot: false, first_name: "Sam" },
          chat: { id: 555, type: "private" }
        }
      }
    });
    expect(startResult.ok).toBe(true);
    expect(prisma._state.participants).toHaveLength(1);
    expect(prisma._state.participants[0].ownerCoadminUserId).toBe(ownerA);
    expect(prisma._state.playerLinks).toHaveLength(1);

    const dmChat = state.chats.get(555);
    expect(dmChat?.messages.some((m) => m.text.includes("Welcome"))).toBe(true);

    // Idempotent update
    const dup = await handler.handleWebhook({
      integrationId: integrationA,
      secretHeader: "whsec",
      update: {
        update_id: 1,
        message: {
          message_id: 1,
          text: "/start",
          from: { id: 555, is_bot: false, first_name: "Sam" },
          chat: { id: 555, type: "private" }
        }
      }
    });
    expect(dup).toMatchObject({ ok: true, duplicate: true });

    // Align standing crmContactId with the upserted contact
    const boundContactId = prisma._state.participants[0].crmContactId;
    prisma._state.standings[0].crmContactId = boundContactId;
    prisma._state.playerLinks[0].crmContactId = boundContactId;

    // Add a second standing so gaps work
    const otherContact = "d2222222-dddd-4ddd-8ddd-ddddddddddd2";
    prisma._state.standings.push({
      competitionId: competitionA,
      ownerCoadminUserId: ownerA,
      crmContactId: otherContact,
      totalPoints: 302,
      pointsReachedAt: new Date()
    });

    await handler.handleWebhook({
      integrationId: integrationA,
      secretHeader: "whsec",
      update: {
        update_id: 2,
        message: {
          message_id: 2,
          text: "/rank",
          from: { id: 555, is_bot: false, first_name: "Sam" },
          chat: { id: 555, type: "private" }
        }
      }
    });
    const rankMsg = dmChat?.messages.find((m) => m.text.includes("YOUR LEADERBOARD"));
    expect(rankMsg?.text).toContain("Rank:");
    expect(rankMsg?.text).toContain("Prize Pool");

    // Transfer reject: bind contact to ownerB then /start from same telegram user on ownerA bot
    // Use a different telegram user already bound elsewhere
    const peer2 = "777";
    const contactBoundToB = "d3333333-dddd-4ddd-8ddd-ddddddddddd3";
    prisma._state.contacts.push({
      id: contactBoundToB,
      workspaceId,
      kind: "PRIVATE",
      telegramPeerId: peer2,
      displayName: "Taken"
    });
    prisma._state.participants.push({
      id: "p-b",
      workspaceId,
      crmContactId: contactBoundToB,
      ownerCoadminUserId: ownerB
    });

    await handler.handleWebhook({
      integrationId: integrationA,
      secretHeader: "whsec",
      update: {
        update_id: 3,
        message: {
          message_id: 3,
          text: "/start",
          from: { id: 777, is_bot: false, first_name: "Taken" },
          chat: { id: 777, type: "private" }
        }
      }
    });
    const transferMsg = state.chats.get(777)?.messages.at(-1)?.text ?? "";
    expect(transferMsg.toLowerCase()).toContain("another coadmin");
  });

  it("never sends DMs via B's bot for A's player", () => {
    const decision = decidePlayerNotification({
      competitionId: competitionA,
      crmContactId: contact1,
      kind: "ENTER_TOP_10",
      hasPlayerLink: true,
      ownerCoadminUserId: ownerA,
      botOwnerCoadminUserId: ownerB
    });
    expect(decision.shouldNotify).toBe(false);
  });
});

describe("Phase 5 personal messaging formats", () => {
  it("formats personal rank and preserves leaderboardRank vs prizeRank in finals", () => {
    const rank = formatPersonalRankMessage({
      rank: 7,
      totalPoints: 284,
      pointsAbove: 18,
      pointsToTop3: 61,
      prizePoolCents: 62000,
      endsAt: new Date("2026-08-19T02:00:00.000Z"),
      timezone: "America/Chicago",
      isFirst: false
    });
    expect(rank).toContain("Rank: #7");
    expect(rank).toContain("18 points behind");
    expect(rank).toContain("61 points away from Top 3");
    expect(rank).not.toMatch(/%/);

    const winner = formatPersonalFinalResultMessage({
      leaderboardRank: 2,
      totalPoints: 500,
      prizeRank: 1,
      payoutCents: 31000,
      membershipStatus: "ELIGIBLE",
      ineligibilityReason: null,
      prizePoolCents: 62000
    });
    expect(winner).toContain("YOU WON");
    expect(winner).toContain("finished #2 on the leaderboard");
    expect(winner).toContain("Prize #1");
    expect(winner).not.toContain("finished #1 on the leaderboard");

    const ineligible = formatPersonalFinalResultMessage({
      leaderboardRank: 1,
      totalPoints: 900,
      prizeRank: null,
      payoutCents: null,
      membershipStatus: "NOT_ELIGIBLE",
      ineligibilityReason: "NOT_SUBSCRIBED",
      prizePoolCents: 62000
    });
    expect(ineligible).toContain("You finished #1 with 900 points");
    expect(ineligible).toContain("not subscribed");
    expect(ineligible).toContain("#1 leaderboard finish remains recorded");
    expect(ineligible).not.toContain("YOU WON");
    expect(ineligible).not.toContain("finished #2");
  });

  it("public board CTA uses coadmin bot username", () => {
    const text = formatPublicLeaderboardMessage({
      title: "BIWEEKLY LEADERBOARD",
      top10: [{ rank: 1, displayName: "Sam", points: 10 }],
      prizePoolCents: 100,
      endsAt: new Date(),
      timezone: "America/Chicago",
      botUsername: "OwnerABot"
    });
    expect(text).toContain("https://t.me/OwnerABot?start=rank");
  });
});

describe("Phase 5 posting failure isolation", () => {
  it("player DM permanent failure does not throw into scoring domain", async () => {
    const prisma = createPhase5Prisma();
    const token = "bot-token-a";
    const state: FakeLeaderboardTelegramState = {
      bots: new Map([[token, { id: 1, isBot: true, firstName: "Bot", username: "b" }]]),
      chats: new Map(),
      failures: new Map([
        [
          `${token}:sendMessage`,
          new LeaderboardTelegramApiError({
            httpStatus: 403,
            telegramErrorCode: 403,
            description: "Forbidden",
            permanent: true
          })
        ]
      ])
    };
    const client = createFakeLeaderboardTelegramClient(state);
    const encrypted = encryptSecret(token, encryptionKey);
    prisma._state.integrations.push({
      id: integrationA,
      workspaceId,
      ownerCoadminUserId: ownerA,
      encryptedBotToken: encrypted,
      disconnectedAt: null,
      postingEnabled: true,
      channelId: "-100",
      botUsername: "b"
    });
    prisma._state.playerLinks.push({
      id: "link1",
      botIntegrationId: integrationA,
      ownerCoadminUserId: ownerA,
      crmContactId: contact1,
      telegramUserId: "555"
    });
    const job = {
      id: "job1",
      workspaceId,
      ownerCoadminUserId: ownerA,
      competitionId: competitionA,
      botIntegrationId: integrationA,
      jobType: "SEND_PLAYER_DM",
      status: "QUEUED",
      attemptCount: 0,
      payloadJson: {
        crmContactId: contact1,
        kind: "ENTER_TOP_10",
        fromRank: null,
        toRank: 8
      },
      idempotencyKey: "k1"
    };
    prisma._state.outbox.push(job);

    const wakes: string[] = [];
    const outbox = new LeaderboardTelegramOutboxService(prisma, async (id) => {
      wakes.push(id);
    });
    const processor = new LeaderboardTelegramProcessor({
      prisma,
      encryptionKey,
      outbox,
      client
    });

    await processor.processJob(job.id);
    expect(prisma._state.outbox[0].status).toBe("FAILED");
    // Scoring tables untouched
    expect(prisma._state.standings).toHaveLength(0);
  });
});
