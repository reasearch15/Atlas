import { describe, expect, it, vi } from "vitest";
import { encryptSecret } from "@atlas/shared/session-encryption";
import { LeaderboardError } from "../leaderboard.errors";
import { wheelAlreadyConsumed, wheelNotAvailable } from "../wheel.service";
import {
  LeaderboardBotUpdateHandler,
  type BotWheelServicePort
} from "./bot-update-handler";
import {
  createFakeLeaderboardTelegramClient,
  LeaderboardTelegramApiError,
  type FakeLeaderboardTelegramState
} from "./leaderboard-telegram.client";
import {
  buildWheelSpinInlineKeyboard,
  LEADERBOARD_WHEEL_SPIN_CALLBACK_DATA
} from "./personal-rank-message";

const encryptionKey = "k".repeat(64);
const workspaceId = "11111111-1111-4111-8111-111111111111";
const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ownerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const integrationA = "i1111111-iiii-4iii-8iii-iiiiiiiiiii1";
const integrationB = "i2222222-iiii-4iii-8iii-iiiiiiiiiii2";
const competitionA = "c1111111-cccc-4ccc-8ccc-ccccccccccc1";
const contactA = "d1111111-dddd-4ddd-8ddd-ddddddddddd1";
const contactB = "d2222222-dddd-4ddd-8ddd-ddddddddddd2";
const telegramUserA = "900001";
const botTokenA = "bot-token-a";

function createBotPrisma() {
  const contacts: any[] = [];
  const participants: any[] = [];
  const integrations: any[] = [];
  const playerLinks: any[] = [];
  const telegramUpdates: any[] = [];
  const competitions: any[] = [];
  const standings: any[] = [];
  const settings: any[] = [];

  const prisma: any = {
    crmContact: {
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
      create: async ({ data }: any) => {
        const row = { id: crypto.randomUUID(), ...data };
        contacts.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = contacts.find((c) => c.id === where.id);
        Object.assign(row, data);
        return row;
      }
    },
    leaderboardParticipant: {
      findUnique: async ({ where }: any) => {
        if (where.workspaceId_crmContactId) {
          return (
            participants.find(
              (p) =>
                p.workspaceId === where.workspaceId_crmContactId.workspaceId &&
                p.crmContactId === where.workspaceId_crmContactId.crmContactId
            ) ?? null
          );
        }
        return participants.find((p) => p.id === where.id) ?? null;
      },
      findMany: async ({ where }: any) =>
        participants.filter((p) => {
          if (where.workspaceId && p.workspaceId !== where.workspaceId) return false;
          if (where.crmContactId && p.crmContactId !== where.crmContactId) return false;
          return true;
        }),
      create: async ({ data }: any) => {
        const row = { id: crypto.randomUUID(), ...data };
        participants.push(row);
        return row;
      }
    },
    leaderboardBotIntegration: {
      findUnique: async ({ where }: any) => integrations.find((r) => r.id === where.id) ?? null,
      update: async ({ where, data }: any) => {
        const row = integrations.find((r) => r.id === where.id);
        Object.assign(row, data);
        return row;
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
      update: async ({ where, data }: any) => {
        const row = playerLinks.find((l) => l.id === where.id);
        Object.assign(row, data);
        return row;
      },
      upsert: async ({ where, create, update }: any) => {
        const key = where.botIntegrationId_telegramUserId;
        const existing = playerLinks.find(
          (l) =>
            l.botIntegrationId === key.botIntegrationId && l.telegramUserId === key.telegramUserId
        );
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row = { id: crypto.randomUUID(), ...create };
        playerLinks.push(row);
        return row;
      }
    },
    leaderboardTelegramUpdate: {
      create: async ({ data }: any) => {
        if (
          telegramUpdates.some(
            (u) =>
              u.botIntegrationId === data.botIntegrationId &&
              BigInt(u.updateId) === BigInt(data.updateId)
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
          if (where.workspaceId && c.workspaceId !== where.workspaceId) return false;
          if (where.ownerCoadminUserId && c.ownerCoadminUserId !== where.ownerCoadminUserId)
            return false;
          if (where.status?.in) return where.status.in.includes(c.status);
          if (where.status) return c.status === where.status;
          return true;
        });
        rows = [...rows].sort((a, b) => (b.sequence ?? 0) - (a.sequence ?? 0));
        return rows[0] ?? null;
      }
    },
    leaderboardStanding: {
      findMany: async ({ where }: any) =>
        standings.filter((s) => {
          if (where.competitionId && s.competitionId !== where.competitionId) return false;
          if (where.ownerCoadminUserId && s.ownerCoadminUserId !== where.ownerCoadminUserId)
            return false;
          return true;
        })
    },
    leaderboardSettings: {
      findUnique: async ({ where }: any) =>
        settings.find((s) => s.ownerCoadminUserId === where.ownerCoadminUserId) ?? null
    },
    _state: {
      contacts,
      participants,
      integrations,
      playerLinks,
      telegramUpdates,
      competitions,
      standings,
      settings
    }
  };

  return prisma;
}

function seedOwnerA(prisma: any) {
  const encrypted = encryptSecret(botTokenA, encryptionKey);
  prisma._state.integrations.push({
    id: integrationA,
    workspaceId,
    ownerCoadminUserId: ownerA,
    encryptedBotToken: encrypted,
    encryptedWebhookSecret: encryptSecret("whsec", encryptionKey),
    botUsername: "AtlasBoardBot",
    disconnectedAt: null
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
  prisma._state.settings.push({ ownerCoadminUserId: ownerA, timezone: "America/Chicago" });
  prisma._state.contacts.push({
    id: contactA,
    workspaceId,
    telegramPeerId: telegramUserA,
    kind: "PRIVATE",
    displayName: "Player A"
  });
  prisma._state.participants.push({
    id: "p-a",
    workspaceId,
    crmContactId: contactA,
    ownerCoadminUserId: ownerA
  });
  prisma._state.playerLinks.push({
    id: "link-a",
    workspaceId,
    ownerCoadminUserId: ownerA,
    botIntegrationId: integrationA,
    crmContactId: contactA,
    telegramUserId: telegramUserA
  });
  prisma._state.standings.push({
    competitionId: competitionA,
    ownerCoadminUserId: ownerA,
    crmContactId: contactA,
    totalPoints: 284,
    pointsReachedAt: new Date()
  });
}

function makeClient(state?: FakeLeaderboardTelegramState) {
  const tgState: FakeLeaderboardTelegramState = state ?? {
    bots: new Map([
      [botTokenA, { id: 111, isBot: true, firstName: "Board", username: "AtlasBoardBot" }]
    ]),
    chats: new Map(),
    callbackAnswers: []
  };
  return { client: createFakeLeaderboardTelegramClient(tgState), state: tgState };
}

function spinResult(overrides: {
  pointsAwarded?: number;
  previousRank?: number | null;
  resultingRank?: number | null;
  totalPoints?: number;
  wheelPoints?: number;
  replay?: boolean;
  spinId?: string;
} = {}) {
  const pointsAwarded = overrides.pointsAwarded ?? 25;
  const totalPoints = overrides.totalPoints ?? 309;
  const wheelPoints = overrides.wheelPoints ?? pointsAwarded;
  return {
    spin: {
      id: overrides.spinId ?? "spin-1",
      workspaceId,
      ownerCoadminUserId: ownerA,
      competitionId: competitionA,
      cycleId: "cycle-1",
      crmContactId: contactA,
      pointsAwarded,
      configVersionId: "ver-1",
      idempotencyKey: "key",
      spunAt: new Date(),
      leaderboardEventId: "evt-1",
      previousRank: overrides.previousRank ?? 9,
      resultingRank: overrides.resultingRank ?? 6,
      rngMetaJson: null,
      qualificationInvalidatedAt: null,
      createdAt: new Date()
    },
    event: {} as any,
    standing: {
      id: "st-1",
      workspaceId,
      ownerCoadminUserId: ownerA,
      competitionId: competitionA,
      crmContactId: contactA,
      totalPoints,
      depositPoints: totalPoints - wheelPoints,
      referralPoints: 0,
      promotionPoints: 0,
      wheelPoints,
      qualifyingDepositCents: 4000,
      successfulReferralCount: 0,
      pointsReachedAt: new Date(),
      lastEventId: "evt-1",
      lastEventAt: new Date(),
      lastEventType: "WHEEL_SPIN",
      lastEventReason: "wheel_spin",
      createdAt: new Date(),
      updatedAt: new Date()
    },
    replay: overrides.replay ?? false,
    ownerCoadminUserId: ownerA
  };
}

describe("Telegram wheel spin — /rank button", () => {
  it("A: AVAILABLE wheel includes Spin Now inline keyboard", async () => {
    const prisma = createBotPrisma();
    seedOwnerA(prisma);
    const { client, state } = makeClient();
    const wheel: BotWheelServicePort = {
      getStatus: async () => ({
        wheelEnabled: true,
        configured: true,
        qualifyingDepositCents: 4000,
        qualificationCentsRequired: 4000,
        available: true,
        consumed: false,
        pointsAwarded: null,
        cycleSequence: 1
      }),
      spin: async () => spinResult()
    };
    const handler = new LeaderboardBotUpdateHandler({
      prisma,
      client,
      encryptionKey,
      startTokenSecret: encryptionKey,
      wheel
    });

    await handler.processUpdate(prisma._state.integrations[0], {
      update_id: 10,
      message: {
        message_id: 1,
        text: "/rank",
        from: { id: Number(telegramUserA), is_bot: false, first_name: "A" },
        chat: { id: Number(telegramUserA), type: "private" }
      }
    });

    const msgs = state.chats.get(Number(telegramUserA))?.messages ?? [];
    expect(msgs.at(-1)?.text).toContain("Wheel Spin Available");
    expect(msgs.at(-1)?.text).not.toContain("Open Atlas to spin");
    expect(msgs.at(-1)?.replyMarkup).toEqual(buildWheelSpinInlineKeyboard());
  });

  it("B: below $40 has no Spin button", async () => {
    const prisma = createBotPrisma();
    seedOwnerA(prisma);
    const { client, state } = makeClient();
    const wheel: BotWheelServicePort = {
      getStatus: async () => ({
        wheelEnabled: true,
        configured: true,
        qualifyingDepositCents: 2600,
        qualificationCentsRequired: 4000,
        available: false,
        consumed: false,
        pointsAwarded: null,
        cycleSequence: 1
      }),
      spin: async () => {
        throw new Error("should not spin");
      }
    };
    const handler = new LeaderboardBotUpdateHandler({
      prisma,
      client,
      encryptionKey,
      startTokenSecret: encryptionKey,
      wheel
    });

    await handler.processUpdate(prisma._state.integrations[0], {
      update_id: 11,
      message: {
        message_id: 1,
        text: "/rank",
        from: { id: Number(telegramUserA), is_bot: false, first_name: "A" },
        chat: { id: Number(telegramUserA), type: "private" }
      }
    });

    const msg = state.chats.get(Number(telegramUserA))?.messages.at(-1);
    expect(msg?.text).toContain("$26 / $40");
    expect(msg?.replyMarkup).toBeUndefined();
  });

  it("C: already consumed has no Spin button", async () => {
    const prisma = createBotPrisma();
    seedOwnerA(prisma);
    const { client, state } = makeClient();
    const wheel: BotWheelServicePort = {
      getStatus: async () => ({
        wheelEnabled: true,
        configured: true,
        qualifyingDepositCents: 4000,
        qualificationCentsRequired: 4000,
        available: false,
        consumed: true,
        pointsAwarded: 30,
        cycleSequence: 1
      }),
      spin: async () => {
        throw new Error("should not spin");
      }
    };
    const handler = new LeaderboardBotUpdateHandler({
      prisma,
      client,
      encryptionKey,
      startTokenSecret: encryptionKey,
      wheel
    });

    await handler.processUpdate(prisma._state.integrations[0], {
      update_id: 12,
      message: {
        message_id: 1,
        text: "/rank",
        from: { id: Number(telegramUserA), is_bot: false, first_name: "A" },
        chat: { id: Number(telegramUserA), type: "private" }
      }
    });

    const msg = state.chats.get(Number(telegramUserA))?.messages.at(-1);
    expect(msg?.text).toContain("Used for this cycle");
    expect(msg?.replyMarkup).toBeUndefined();
  });
});

describe("Telegram wheel spin — callback", () => {
  it("D/J/K/L: valid callback spins once, sends result DM with rank movement", async () => {
    const prisma = createBotPrisma();
    seedOwnerA(prisma);
    prisma._state.standings[0].totalPoints = 309;
    prisma._state.standings.push({
      competitionId: competitionA,
      ownerCoadminUserId: ownerA,
      crmContactId: "d3333333-dddd-4ddd-8ddd-ddddddddddd3",
      totalPoints: 321,
      pointsReachedAt: new Date()
    });

    const { client, state } = makeClient();
    const spin = vi.fn(async (input: any) => {
      expect(input.crmContactId).toBe(contactA);
      expect(input.idempotencyKey).toBe(`tg:wheel:${integrationA}:20`);
      expect(input.workspaceId).toBe(workspaceId);
      return spinResult({
        pointsAwarded: 25,
        previousRank: 9,
        resultingRank: 6,
        totalPoints: 309
      });
    });
    const outbox = { enqueueRefresh: vi.fn(async () => "job-1") };
    const handler = new LeaderboardBotUpdateHandler({
      prisma,
      client,
      encryptionKey,
      startTokenSecret: encryptionKey,
      wheel: {
        getStatus: async () => ({
          wheelEnabled: true,
          configured: true,
          qualifyingDepositCents: 4000,
          qualificationCentsRequired: 4000,
          available: true,
          consumed: false,
          pointsAwarded: null,
          cycleSequence: 1
        }),
        spin
      },
      outbox
    });

    await handler.handleWebhook({
      integrationId: integrationA,
      secretHeader: "whsec",
      update: {
        update_id: 20,
        callback_query: {
          id: "cbq-20",
          data: LEADERBOARD_WHEEL_SPIN_CALLBACK_DATA,
          from: { id: Number(telegramUserA), is_bot: false, first_name: "A" },
          message: {
            message_id: 99,
            chat: { id: Number(telegramUserA), type: "private" }
          }
        }
      }
    });

    expect(spin).toHaveBeenCalledTimes(1);
    expect(state.callbackAnswers?.at(-1)).toEqual({
      callbackQueryId: "cbq-20",
      text: "Spin complete! 🎡"
    });
    const dm = state.chats.get(Number(telegramUserA))?.messages.at(-1)?.text ?? "";
    expect(dm).toContain("🎡 WHEEL RESULT");
    expect(dm).toContain("+25 POINTS!");
    expect(dm).toContain("#9 → #6");
    expect(dm).toContain("Total points: 309");
    expect(dm).not.toContain(contactA);
    expect(dm).not.toContain(ownerA);
    expect(outbox.enqueueRefresh).toHaveBeenCalledWith(workspaceId, ownerA, competitionA);
  });

  it("E: cross-Coadmin bot cannot spin another owner's participant", async () => {
    const prisma = createBotPrisma();
    seedOwnerA(prisma);
    prisma._state.integrations.push({
      id: integrationB,
      workspaceId,
      ownerCoadminUserId: ownerB,
      encryptedBotToken: encryptSecret("bot-token-b", encryptionKey),
      encryptedWebhookSecret: encryptSecret("whsec-b", encryptionKey),
      disconnectedAt: null
    });
    // Malicious: link on B's bot pointing at A's contact (should still fail participant/owner checks).
    prisma._state.playerLinks.push({
      id: "link-evil",
      workspaceId,
      ownerCoadminUserId: ownerB,
      botIntegrationId: integrationB,
      crmContactId: contactA,
      telegramUserId: telegramUserA
    });

    const { client, state } = makeClient({
      bots: new Map([
        [botTokenA, { id: 111, isBot: true, firstName: "A" }],
        ["bot-token-b", { id: 222, isBot: true, firstName: "B" }]
      ]),
      chats: new Map(),
      callbackAnswers: []
    });
    const spin = vi.fn(async () => spinResult());
    const handler = new LeaderboardBotUpdateHandler({
      prisma,
      client,
      encryptionKey,
      startTokenSecret: encryptionKey,
      wheel: {
        getStatus: async () => ({
          wheelEnabled: true,
          configured: true,
          qualifyingDepositCents: 4000,
          qualificationCentsRequired: 4000,
          available: true,
          consumed: false,
          pointsAwarded: null,
          cycleSequence: 1
        }),
        spin
      }
    });

    await handler.handleWebhook({
      integrationId: integrationB,
      secretHeader: "whsec-b",
      update: {
        update_id: 30,
        callback_query: {
          id: "cbq-30",
          data: LEADERBOARD_WHEEL_SPIN_CALLBACK_DATA,
          from: { id: Number(telegramUserA), is_bot: false, first_name: "A" }
        }
      }
    });

    expect(spin).not.toHaveBeenCalled();
    expect(state.callbackAnswers?.at(-1)?.text).toBe("Send /start first.");
  });

  it("F: unlinked Telegram user cannot spin and is told to /start", async () => {
    const prisma = createBotPrisma();
    seedOwnerA(prisma);
    prisma._state.playerLinks.length = 0;
    const { client, state } = makeClient();
    const spin = vi.fn(async () => spinResult());
    const handler = new LeaderboardBotUpdateHandler({
      prisma,
      client,
      encryptionKey,
      startTokenSecret: encryptionKey,
      wheel: {
        getStatus: async () => ({
          wheelEnabled: true,
          configured: true,
          qualifyingDepositCents: 4000,
          qualificationCentsRequired: 4000,
          available: true,
          consumed: false,
          pointsAwarded: null,
          cycleSequence: 1
        }),
        spin
      }
    });

    await handler.handleWebhook({
      integrationId: integrationA,
      secretHeader: "whsec",
      update: {
        update_id: 31,
        callback_query: {
          id: "cbq-31",
          data: LEADERBOARD_WHEEL_SPIN_CALLBACK_DATA,
          from: { id: Number(telegramUserA), is_bot: false, first_name: "A" }
        }
      }
    });

    expect(spin).not.toHaveBeenCalled();
    expect(state.callbackAnswers?.at(-1)?.text).toBe("Send /start first.");
    expect(
      state.chats.get(Number(telegramUserA))?.messages.some((m) => m.text.includes("/start"))
    ).toBe(true);
  });

  it("G: duplicate Telegram update spins exactly once", async () => {
    const prisma = createBotPrisma();
    seedOwnerA(prisma);
    const { client } = makeClient();
    const spin = vi.fn(async () => spinResult());
    const handler = new LeaderboardBotUpdateHandler({
      prisma,
      client,
      encryptionKey,
      startTokenSecret: encryptionKey,
      wheel: {
        getStatus: async () => ({
          wheelEnabled: true,
          configured: true,
          qualifyingDepositCents: 4000,
          qualificationCentsRequired: 4000,
          available: true,
          consumed: false,
          pointsAwarded: null,
          cycleSequence: 1
        }),
        spin
      }
    });

    const update = {
      update_id: 40,
      callback_query: {
        id: "cbq-40",
        data: LEADERBOARD_WHEEL_SPIN_CALLBACK_DATA,
        from: { id: Number(telegramUserA), is_bot: false, first_name: "A" }
      }
    };

    const first = await handler.handleWebhook({
      integrationId: integrationA,
      secretHeader: "whsec",
      update
    });
    const second = await handler.handleWebhook({
      integrationId: integrationA,
      secretHeader: "whsec",
      update
    });

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true, duplicate: true });
    expect(spin).toHaveBeenCalledTimes(1);
  });

  it("H: two callback attempts result in exactly one successful spin", async () => {
    const prisma = createBotPrisma();
    seedOwnerA(prisma);
    const { client, state } = makeClient();
    let calls = 0;
    const spin = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return spinResult({ spinId: "spin-first" });
      throw wheelAlreadyConsumed();
    });
    const handler = new LeaderboardBotUpdateHandler({
      prisma,
      client,
      encryptionKey,
      startTokenSecret: encryptionKey,
      wheel: {
        getStatus: async () => ({
          wheelEnabled: true,
          configured: true,
          qualifyingDepositCents: 4000,
          qualificationCentsRequired: 4000,
          available: true,
          consumed: false,
          pointsAwarded: null,
          cycleSequence: 1
        }),
        spin
      }
    });

    await handler.handleWebhook({
      integrationId: integrationA,
      secretHeader: "whsec",
      update: {
        update_id: 50,
        callback_query: {
          id: "cbq-50a",
          data: LEADERBOARD_WHEEL_SPIN_CALLBACK_DATA,
          from: { id: Number(telegramUserA), is_bot: false, first_name: "A" }
        }
      }
    });
    await handler.handleWebhook({
      integrationId: integrationA,
      secretHeader: "whsec",
      update: {
        update_id: 51,
        callback_query: {
          id: "cbq-50b",
          data: LEADERBOARD_WHEEL_SPIN_CALLBACK_DATA,
          from: { id: Number(telegramUserA), is_bot: false, first_name: "A" }
        }
      }
    });

    expect(spin).toHaveBeenCalledTimes(2);
    expect(state.callbackAnswers?.[0]?.text).toBe("Spin complete! 🎡");
    expect(state.callbackAnswers?.[1]?.text).toBe("You already used your spin for this cycle.");
    const resultDms = (state.chats.get(Number(telegramUserA))?.messages ?? []).filter((m) =>
      m.text.includes("WHEEL RESULT")
    );
    expect(resultDms).toHaveLength(1);
  });

  it("I: already-spun stale button awards no new points", async () => {
    const prisma = createBotPrisma();
    seedOwnerA(prisma);
    const { client, state } = makeClient();
    const spin = vi.fn(async () => {
      throw wheelAlreadyConsumed();
    });
    const handler = new LeaderboardBotUpdateHandler({
      prisma,
      client,
      encryptionKey,
      startTokenSecret: encryptionKey,
      wheel: {
        getStatus: async () => ({
          wheelEnabled: true,
          configured: true,
          qualifyingDepositCents: 4000,
          qualificationCentsRequired: 4000,
          available: false,
          consumed: true,
          pointsAwarded: 10,
          cycleSequence: 1
        }),
        spin
      }
    });

    await handler.handleWebhook({
      integrationId: integrationA,
      secretHeader: "whsec",
      update: {
        update_id: 60,
        callback_query: {
          id: "cbq-60",
          data: LEADERBOARD_WHEEL_SPIN_CALLBACK_DATA,
          from: { id: Number(telegramUserA), is_bot: false, first_name: "A" }
        }
      }
    });

    expect(spin).toHaveBeenCalledTimes(1);
    expect(state.callbackAnswers?.at(-1)?.text).toBe(
      "You already used your spin for this cycle."
    );
    expect(
      (state.chats.get(Number(telegramUserA))?.messages ?? []).some((m) =>
        m.text.includes("WHEEL RESULT")
      )
    ).toBe(false);
  });

  it("J: 0-point result is a valid success message", async () => {
    const prisma = createBotPrisma();
    seedOwnerA(prisma);
    const { client, state } = makeClient();
    const handler = new LeaderboardBotUpdateHandler({
      prisma,
      client,
      encryptionKey,
      startTokenSecret: encryptionKey,
      wheel: {
        getStatus: async () => ({
          wheelEnabled: true,
          configured: true,
          qualifyingDepositCents: 4000,
          qualificationCentsRequired: 4000,
          available: true,
          consumed: false,
          pointsAwarded: null,
          cycleSequence: 1
        }),
        spin: async () =>
          spinResult({
            pointsAwarded: 0,
            previousRank: 8,
            resultingRank: 8,
            totalPoints: 200,
            wheelPoints: 0
          })
      }
    });

    await handler.handleWebhook({
      integrationId: integrationA,
      secretHeader: "whsec",
      update: {
        update_id: 70,
        callback_query: {
          id: "cbq-70",
          data: LEADERBOARD_WHEEL_SPIN_CALLBACK_DATA,
          from: { id: Number(telegramUserA), is_bot: false, first_name: "A" }
        }
      }
    });

    const dm = state.chats.get(Number(telegramUserA))?.messages.at(-1)?.text ?? "";
    expect(state.callbackAnswers?.at(-1)?.text).toBe("Spin complete! 🎡");
    expect(dm).toContain("0 POINTS");
    expect(dm).toContain("No points this spin.");
    expect(dm).not.toMatch(/error|failed/i);
  });

  it("K: forced 40-point result is a valid success message", async () => {
    const prisma = createBotPrisma();
    seedOwnerA(prisma);
    const { client, state } = makeClient();
    const handler = new LeaderboardBotUpdateHandler({
      prisma,
      client,
      encryptionKey,
      startTokenSecret: encryptionKey,
      wheel: {
        getStatus: async () => ({
          wheelEnabled: true,
          configured: true,
          qualifyingDepositCents: 4000,
          qualificationCentsRequired: 4000,
          available: true,
          consumed: false,
          pointsAwarded: null,
          cycleSequence: 1
        }),
        spin: async () =>
          spinResult({
            pointsAwarded: 40,
            previousRank: 5,
            resultingRank: 3,
            totalPoints: 344
          })
      }
    });

    await handler.handleWebhook({
      integrationId: integrationA,
      secretHeader: "whsec",
      update: {
        update_id: 71,
        callback_query: {
          id: "cbq-71",
          data: LEADERBOARD_WHEEL_SPIN_CALLBACK_DATA,
          from: { id: Number(telegramUserA), is_bot: false, first_name: "A" }
        }
      }
    });

    const dm = state.chats.get(Number(telegramUserA))?.messages.at(-1)?.text ?? "";
    expect(dm).toContain("+40 POINTS!");
    expect(dm).toContain("#5 → #3");
    expect(dm).toContain("prize zone");
  });

  it("M: Telegram send failure keeps wheel points committed", async () => {
    const prisma = createBotPrisma();
    seedOwnerA(prisma);
    const { client, state } = makeClient();
    state.failures = new Map([
      [
        `${botTokenA}:sendMessage`,
        new LeaderboardTelegramApiError({
          httpStatus: 500,
          telegramErrorCode: 500,
          description: "Internal Server Error",
          permanent: false
        })
      ]
    ]);
    const spin = vi.fn(async () => spinResult({ pointsAwarded: 15, totalPoints: 299 }));
    const handler = new LeaderboardBotUpdateHandler({
      prisma,
      client,
      encryptionKey,
      startTokenSecret: encryptionKey,
      wheel: {
        getStatus: async () => ({
          wheelEnabled: true,
          configured: true,
          qualifyingDepositCents: 4000,
          qualificationCentsRequired: 4000,
          available: true,
          consumed: false,
          pointsAwarded: null,
          cycleSequence: 1
        }),
        spin
      }
    });

    await handler.handleWebhook({
      integrationId: integrationA,
      secretHeader: "whsec",
      update: {
        update_id: 80,
        callback_query: {
          id: "cbq-80",
          data: LEADERBOARD_WHEEL_SPIN_CALLBACK_DATA,
          from: { id: Number(telegramUserA), is_bot: false, first_name: "A" }
        }
      }
    });

    expect(spin).toHaveBeenCalledTimes(1);
    expect(state.callbackAnswers?.at(-1)?.text).toBe("Spin complete! 🎡");
  });

  it("N: callback payload tampering cannot select another crmContact/owner", async () => {
    const prisma = createBotPrisma();
    seedOwnerA(prisma);
    prisma._state.contacts.push({
      id: contactB,
      workspaceId,
      telegramPeerId: "other",
      kind: "PRIVATE",
      displayName: "Other"
    });
    prisma._state.participants.push({
      id: "p-b",
      workspaceId,
      crmContactId: contactB,
      ownerCoadminUserId: ownerB
    });

    const { client } = makeClient();
    const spin = vi.fn(async (input: any) => {
      expect(input.crmContactId).toBe(contactA);
      expect(input.crmContactId).not.toBe(contactB);
      return spinResult();
    });
    const handler = new LeaderboardBotUpdateHandler({
      prisma,
      client,
      encryptionKey,
      startTokenSecret: encryptionKey,
      wheel: {
        getStatus: async () => ({
          wheelEnabled: true,
          configured: true,
          qualifyingDepositCents: 4000,
          qualificationCentsRequired: 4000,
          available: true,
          consumed: false,
          pointsAwarded: null,
          cycleSequence: 1
        }),
        spin
      }
    });

    await handler.handleWebhook({
      integrationId: integrationA,
      secretHeader: "whsec",
      update: {
        update_id: 90,
        callback_query: {
          id: "cbq-90",
          // Tampered payload — ignored; only constant is accepted.
          data: `leaderboard:wheel:spin:${contactB}:${ownerB}`,
          from: { id: Number(telegramUserA), is_bot: false, first_name: "A" }
        }
      }
    });

    expect(spin).not.toHaveBeenCalled();
  });

  it("O: unknown callback data does not spin", async () => {
    const prisma = createBotPrisma();
    seedOwnerA(prisma);
    const { client, state } = makeClient();
    const spin = vi.fn(async () => spinResult());
    const handler = new LeaderboardBotUpdateHandler({
      prisma,
      client,
      encryptionKey,
      startTokenSecret: encryptionKey,
      wheel: {
        getStatus: async () => ({
          wheelEnabled: true,
          configured: true,
          qualifyingDepositCents: 4000,
          qualificationCentsRequired: 4000,
          available: true,
          consumed: false,
          pointsAwarded: null,
          cycleSequence: 1
        }),
        spin
      }
    });

    await handler.handleWebhook({
      integrationId: integrationA,
      secretHeader: "whsec",
      update: {
        update_id: 91,
        callback_query: {
          id: "cbq-91",
          data: "leaderboard:unknown",
          from: { id: Number(telegramUserA), is_bot: false, first_name: "A" }
        }
      }
    });

    expect(spin).not.toHaveBeenCalled();
    expect(state.callbackAnswers?.at(-1)?.text).toBe("Unsupported action.");
  });

  it("maps locked wheel error to safe callback text", async () => {
    const prisma = createBotPrisma();
    seedOwnerA(prisma);
    const { client, state } = makeClient();
    const handler = new LeaderboardBotUpdateHandler({
      prisma,
      client,
      encryptionKey,
      startTokenSecret: encryptionKey,
      wheel: {
        getStatus: async () => ({
          wheelEnabled: true,
          configured: true,
          qualifyingDepositCents: 1000,
          qualificationCentsRequired: 4000,
          available: false,
          consumed: false,
          pointsAwarded: null,
          cycleSequence: 1
        }),
        spin: async () => {
          throw wheelNotAvailable("Need $40");
        }
      }
    });

    await handler.handleWebhook({
      integrationId: integrationA,
      secretHeader: "whsec",
      update: {
        update_id: 92,
        callback_query: {
          id: "cbq-92",
          data: LEADERBOARD_WHEEL_SPIN_CALLBACK_DATA,
          from: { id: Number(telegramUserA), is_bot: false, first_name: "A" }
        }
      }
    });

    expect(state.callbackAnswers?.at(-1)?.text).toBe("Wheel is not available yet.");
  });

  it("rejects generic LeaderboardError without leaking internals", async () => {
    const prisma = createBotPrisma();
    seedOwnerA(prisma);
    const { client, state } = makeClient();
    const handler = new LeaderboardBotUpdateHandler({
      prisma,
      client,
      encryptionKey,
      startTokenSecret: encryptionKey,
      wheel: {
        getStatus: async () => ({
          wheelEnabled: true,
          configured: true,
          qualifyingDepositCents: 4000,
          qualificationCentsRequired: 4000,
          available: true,
          consumed: false,
          pointsAwarded: null,
          cycleSequence: 1
        }),
        spin: async () => {
          throw new LeaderboardError("WHEEL_RNG_INVALID", "secret prisma stack");
        }
      }
    });

    await handler.handleWebhook({
      integrationId: integrationA,
      secretHeader: "whsec",
      update: {
        update_id: 93,
        callback_query: {
          id: "cbq-93",
          data: LEADERBOARD_WHEEL_SPIN_CALLBACK_DATA,
          from: { id: Number(telegramUserA), is_bot: false, first_name: "A" }
        }
      }
    });

    expect(state.callbackAnswers?.at(-1)?.text).toBe(
      "Could not spin right now. Try again later."
    );
    expect(JSON.stringify(state.callbackAnswers)).not.toContain("prisma");
  });
});
