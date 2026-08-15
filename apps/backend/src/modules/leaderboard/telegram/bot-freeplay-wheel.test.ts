import { describe, expect, it, vi } from "vitest";
import type { FreeplayPlayerStatusDto, FreeplaySpinResultDto } from "@atlas/shared";
import { encryptSecret } from "@atlas/shared/session-encryption";
import {
  LeaderboardBotUpdateHandler,
  type BotFreeplayServicePort
} from "./bot-update-handler";
import {
  createFakeLeaderboardTelegramClient,
  type FakeLeaderboardTelegramState
} from "./leaderboard-telegram.client";
import {
  FREEPLAY_WHEEL_OPEN_CALLBACK_DATA,
  FREEPLAY_WHEEL_SPIN_CALLBACK_DATA
} from "./personal-rank-message";

const encryptionKey = "k".repeat(64);
const workspaceId = "11111111-1111-4111-8111-111111111111";
const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ownerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const integrationA = "i1111111-iiii-4iii-8iii-iiiiiiiiiii1";
const contactA = "d1111111-dddd-4ddd-8ddd-ddddddddddd1";
const telegramUserA = "900001";
const botTokenA = "bot-token-a";

function playerStatus(status: FreeplayPlayerStatusDto["status"], nextAvailableAt: string | null = null): FreeplayPlayerStatusDto {
  if (status === "ELIGIBLE") {
    return {
      status,
      canSpin: true,
      nextAvailableAt: null,
      playerMessage: "🎁 Your Freeplay Wheel is ready!\nTry your luck and see what you win."
    };
  }
  if (status === "ROLLING_LIMIT") {
    return {
      status,
      canSpin: false,
      nextAvailableAt,
      playerMessage: [
        "⏳ You've used your Freeplay Wheel chances for now.",
        "Your next chance becomes available when your 24-hour window opens again.",
        nextAvailableAt ? `Next spin: ${nextAvailableAt}` : null
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n")
    };
  }
  return {
    status,
    canSpin: false,
    nextAvailableAt: null,
    playerMessage: "🎁 No Freeplay Wheel available yet.\n⭐ Keep earning leaderboard points and playing with us — you're getting closer!"
  };
}

function createBotPrisma() {
  const integrations: any[] = [];
  const playerLinks: any[] = [];
  const participants: any[] = [];

  const prisma: any = {
    leaderboardBotPlayerLink: {
      findUnique: async ({ where }: any) => {
        const key = where.botIntegrationId_telegramUserId;
        return playerLinks.find((row) => row.botIntegrationId === key.botIntegrationId && row.telegramUserId === key.telegramUserId) ?? null;
      },
      update: async ({ where, data }: any) => {
        const row = playerLinks.find((link) => link.id === where.id);
        Object.assign(row, data);
        return row;
      }
    },
    leaderboardParticipant: {
      findUnique: async ({ where }: any) => {
        const key = where.workspaceId_crmContactId;
        return participants.find((row) => row.workspaceId === key.workspaceId && row.crmContactId === key.crmContactId) ?? null;
      }
    },
    leaderboardBotIntegration: {
      findUnique: async ({ where }: any) => integrations.find((row) => row.id === where.id) ?? null,
      update: async ({ where, data }: any) => {
        const row = integrations.find((integration) => integration.id === where.id);
        Object.assign(row, data);
        return row;
      }
    },
    leaderboardCompetition: {
      findFirst: async () => null
    },
    leaderboardSettings: {
      findUnique: async () => null
    },
    leaderboardStanding: {
      findMany: async () => []
    },
    leaderboardTelegramUpdate: {
      create: async () => ({ id: crypto.randomUUID() })
    },
    _state: { integrations, playerLinks, participants }
  };
  return prisma;
}

function seedLinkedPlayer(prisma: any, owner = ownerA, playTelegramUsername: string | null = null) {
  prisma._state.integrations.push({
    id: integrationA,
    workspaceId,
    ownerCoadminUserId: ownerA,
    playTelegramUsername,
    encryptedBotToken: encryptSecret(botTokenA, encryptionKey),
    encryptedWebhookSecret: encryptSecret("whsec", encryptionKey),
    disconnectedAt: null
  });
  prisma._state.playerLinks.push({
    id: "link-1",
    workspaceId,
    ownerCoadminUserId: owner,
    botIntegrationId: integrationA,
    crmContactId: contactA,
    telegramUserId: telegramUserA
  });
  prisma._state.participants.push({
    id: "participant-1",
    workspaceId,
    ownerCoadminUserId: owner,
    crmContactId: contactA
  });
}

function seedIntegrationOnly(prisma: any, playTelegramUsername: string | null = null) {
  prisma._state.integrations.push({
    id: integrationA,
    workspaceId,
    ownerCoadminUserId: ownerA,
    playTelegramUsername,
    encryptedBotToken: encryptSecret(botTokenA, encryptionKey),
    encryptedWebhookSecret: encryptSecret("whsec", encryptionKey),
    disconnectedAt: null
  });
}

function createState(): FakeLeaderboardTelegramState {
  return {
    bots: new Map([[botTokenA, { id: 1, isBot: true, firstName: "AtlasBot", username: "AtlasBot" }]]),
    chats: new Map(),
    callbackAnswers: []
  };
}

function callbackUpdate(data: string, updateId = 42) {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      data,
      from: { id: Number(telegramUserA), is_bot: false, first_name: "Player" }
    }
  };
}

function createHandler(input: {
  prisma: any;
  state: FakeLeaderboardTelegramState;
  freeplay: BotFreeplayServicePort;
}) {
  return new LeaderboardBotUpdateHandler({
    prisma: input.prisma,
    client: createFakeLeaderboardTelegramClient(input.state),
    encryptionKey,
    startTokenSecret: encryptionKey,
    freeplay: input.freeplay
  });
}

describe("Telegram Freeplay Wheel flow", () => {
  it("/rank includes the Freeplay Wheel entry point without internal data", async () => {
    const prisma = createBotPrisma();
    seedLinkedPlayer(prisma, ownerA, "officialsayugaming");
    prisma.leaderboardCompetition.findFirst = async ({ where }: any) =>
      where.status === "ACTIVE"
        ? {
            id: "comp-1",
            workspaceId,
            ownerCoadminUserId: ownerA,
            status: "ACTIVE",
            prizePoolCents: 1000,
            endsAt: new Date("2026-08-20T00:00:00.000Z")
          }
        : null;
    const state = createState();
    const handler = createHandler({
      prisma,
      state,
      freeplay: {
        getTrustedPlayerStatus: vi.fn(async () => playerStatus("NOT_ELIGIBLE")),
        spinTrusted: vi.fn()
      }
    });

    await handler.processUpdate(prisma._state.integrations[0], {
      update_id: 7,
      message: {
        text: "/rank",
        from: { id: Number(telegramUserA), is_bot: false, first_name: "Player" }
      }
    });

    const message = state.chats.get(Number(telegramUserA))?.messages.at(-1);
    expect(JSON.stringify(message?.replyMarkup)).toContain(FREEPLAY_WHEEL_OPEN_CALLBACK_DATA);
    expect(JSON.stringify(message?.replyMarkup)).toContain("https://t.me/officialsayugaming");
    expect(JSON.stringify(message)).not.toContain("$50");
    expect(JSON.stringify(message)).not.toContain("5000");
  });

  it("NOT_ELIGIBLE status sends safe hint and no spin button", async () => {
    const prisma = createBotPrisma();
    seedLinkedPlayer(prisma, ownerA, "officialsayugaming");
    const state = createState();
    const handler = createHandler({
      prisma,
      state,
      freeplay: {
        getTrustedPlayerStatus: vi.fn(async () => playerStatus("NOT_ELIGIBLE")),
        spinTrusted: vi.fn()
      }
    });

    await handler.processUpdate(prisma._state.integrations[0], callbackUpdate(FREEPLAY_WHEEL_OPEN_CALLBACK_DATA));

    const dm = state.chats.get(Number(telegramUserA))?.messages.at(-1);
    expect(dm?.text).toContain("No Freeplay Wheel available yet");
    expect(dm?.text).toContain("leaderboard points");
    expect(JSON.stringify(dm?.replyMarkup)).toContain("https://t.me/officialsayugaming");
    expect(JSON.stringify(dm)).not.toContain(FREEPLAY_WHEEL_SPIN_CALLBACK_DATA);
    expect(JSON.stringify(dm)).not.toContain("$50");
  });

  it("unlinked Telegram player is handled without calling Freeplay service", async () => {
    const prisma = createBotPrisma();
    seedIntegrationOnly(prisma);
    const state = createState();
    const getStatus = vi.fn();
    const spin = vi.fn();
    const handler = createHandler({
      prisma,
      state,
      freeplay: { getTrustedPlayerStatus: getStatus, spinTrusted: spin }
    });

    await handler.processUpdate(prisma._state.integrations[0], callbackUpdate(FREEPLAY_WHEEL_OPEN_CALLBACK_DATA));

    expect(getStatus).not.toHaveBeenCalled();
    expect(spin).not.toHaveBeenCalled();
    expect(state.chats.get(Number(telegramUserA))?.messages.at(-1)?.text).toContain("/start");
  });

  it("ELIGIBLE status sends Spin button", async () => {
    const prisma = createBotPrisma();
    seedLinkedPlayer(prisma);
    const state = createState();
    const handler = createHandler({
      prisma,
      state,
      freeplay: {
        getTrustedPlayerStatus: vi.fn(async () => playerStatus("ELIGIBLE")),
        spinTrusted: vi.fn()
      }
    });

    await handler.processUpdate(prisma._state.integrations[0], callbackUpdate(FREEPLAY_WHEEL_OPEN_CALLBACK_DATA));

    const dm = state.chats.get(Number(telegramUserA))?.messages.at(-1);
    expect(dm?.text).toContain("Freeplay Wheel is ready");
    expect(JSON.stringify(dm?.replyMarkup)).toContain(FREEPLAY_WHEEL_SPIN_CALLBACK_DATA);
  });

  it("$0 spin sends no-win message and reuses safe next status", async () => {
    const prisma = createBotPrisma();
    seedLinkedPlayer(prisma, ownerA, "officialsayugaming");
    const state = createState();
    const spin = vi.fn(async (): Promise<FreeplaySpinResultDto> => ({
      spinId: "spin-0",
      rewardAmountCents: 0,
      claimId: null,
      replay: false,
      playerStatus: playerStatus("ELIGIBLE")
    }));
    const handler = createHandler({
      prisma,
      state,
      freeplay: { getTrustedPlayerStatus: vi.fn(), spinTrusted: spin }
    });

    await handler.processUpdate(prisma._state.integrations[0], callbackUpdate(FREEPLAY_WHEEL_SPIN_CALLBACK_DATA, 50));

    expect(spin).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: `tg:freeplay:${integrationA}:50` }));
    const dm = state.chats.get(Number(telegramUserA))?.messages.at(-1);
    expect(dm?.text).toContain("No Freeplay this time");
    expect(JSON.stringify(dm?.replyMarkup)).toContain(FREEPLAY_WHEEL_SPIN_CALLBACK_DATA);
    expect(JSON.stringify(dm?.replyMarkup)).toContain("https://t.me/officialsayugaming");
    expect(JSON.stringify(dm)).not.toContain("$50");
  });

  it("spin failure falls back to safe rolling-limit status without a spin button", async () => {
    const prisma = createBotPrisma();
    seedLinkedPlayer(prisma, ownerA, "officialsayugaming");
    const state = createState();
    const handler = createHandler({
      prisma,
      state,
      freeplay: {
        getTrustedPlayerStatus: vi.fn(async () => playerStatus("ROLLING_LIMIT", "2026-08-16T03:22:00.000Z")),
        spinTrusted: vi.fn(async () => {
          throw new Error("rolling limit");
        })
      }
    });

    await handler.processUpdate(prisma._state.integrations[0], callbackUpdate(FREEPLAY_WHEEL_SPIN_CALLBACK_DATA, 51));

    const dm = state.chats.get(Number(telegramUserA))?.messages.at(-1);
    expect(dm?.text).toContain("used your Freeplay Wheel chances");
    expect(dm?.text).toContain("2026-08-16T03:22:00.000Z");
    expect(JSON.stringify(dm?.replyMarkup)).toContain("https://t.me/officialsayugaming");
    expect(JSON.stringify(dm)).not.toContain(FREEPLAY_WHEEL_SPIN_CALLBACK_DATA);
    expect(JSON.stringify(dm)).not.toContain("$50");
  });

  it.each([
    [100, "$1"],
    [200, "$2"],
    [300, "$3"]
  ])("positive %s spin tells player staff will load reward", async (rewardAmountCents, display) => {
    const prisma = createBotPrisma();
    seedLinkedPlayer(prisma, ownerA, "officialsayugaming");
    const state = createState();
    const handler = createHandler({
      prisma,
      state,
      freeplay: {
        getTrustedPlayerStatus: vi.fn(),
        spinTrusted: vi.fn(async (): Promise<FreeplaySpinResultDto> => ({
          spinId: "spin-win",
          rewardAmountCents,
          claimId: "claim-1",
          replay: false,
          playerStatus: playerStatus("ROLLING_LIMIT", "2026-08-16T03:22:00.000Z")
        }))
      }
    });

    await handler.processUpdate(prisma._state.integrations[0], callbackUpdate(FREEPLAY_WHEEL_SPIN_CALLBACK_DATA, rewardAmountCents));

    const dm = state.chats.get(Number(telegramUserA))?.messages.at(-1);
    expect(dm?.text).toContain(`You won ${display} Freeplay`);
    expect(dm?.text).toContain("staff to load");
    expect(dm?.text).toContain("24-hour window");
    expect(JSON.stringify(dm?.replyMarkup)).toContain("https://t.me/officialsayugaming");
    expect(JSON.stringify(dm)).not.toContain("$50");
  });

  it("duplicate callback idempotency key lets service replay one persisted result", async () => {
    const prisma = createBotPrisma();
    seedLinkedPlayer(prisma);
    const state = createState();
    const byKey = new Map<string, FreeplaySpinResultDto>();
    const spin = vi.fn(async (input: { idempotencyKey: string }): Promise<FreeplaySpinResultDto> => {
      const existing = byKey.get(input.idempotencyKey);
      if (existing) return { ...existing, replay: true };
      const created = {
        spinId: "spin-once",
        rewardAmountCents: 100,
        claimId: "claim-once",
        replay: false,
        playerStatus: playerStatus("ROLLING_LIMIT", "2026-08-16T03:22:00.000Z")
      };
      byKey.set(input.idempotencyKey, created);
      return created;
    });
    const handler = createHandler({
      prisma,
      state,
      freeplay: { getTrustedPlayerStatus: vi.fn(), spinTrusted: spin }
    });

    const update = callbackUpdate(FREEPLAY_WHEEL_SPIN_CALLBACK_DATA, 77);
    await handler.processUpdate(prisma._state.integrations[0], update);
    await handler.processUpdate(prisma._state.integrations[0], update);

    expect(spin).toHaveBeenCalledTimes(2);
    expect(byKey).toHaveLength(1);
    expect(new Set([...byKey.values()].map((result) => result.claimId))).toEqual(new Set(["claim-once"]));
  });

  it("wrong-owner player link is handled without calling Freeplay service", async () => {
    const prisma = createBotPrisma();
    seedLinkedPlayer(prisma, ownerB);
    const state = createState();
    const getStatus = vi.fn();
    const spin = vi.fn();
    const handler = createHandler({
      prisma,
      state,
      freeplay: { getTrustedPlayerStatus: getStatus, spinTrusted: spin }
    });

    await handler.processUpdate(prisma._state.integrations[0], callbackUpdate(FREEPLAY_WHEEL_OPEN_CALLBACK_DATA));

    expect(getStatus).not.toHaveBeenCalled();
    expect(spin).not.toHaveBeenCalled();
    expect(state.chats.get(Number(telegramUserA))?.messages.at(-1)?.text).toContain("/start");
  });
});
