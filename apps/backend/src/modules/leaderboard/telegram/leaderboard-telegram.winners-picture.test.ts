import { beforeEach, describe, expect, it, vi } from "vitest";

const { renderWinnersPictureCard } = vi.hoisted(() => ({
  renderWinnersPictureCard: vi.fn(async () => Buffer.from("rendered-png"))
}));

vi.mock("./winners-picture-card", () => ({ renderWinnersPictureCard }));

import { LeaderboardTelegramProcessor } from "./leaderboard-telegram.processor";

const row = {
  id: "outbox-1",
  workspaceId: "workspace-1",
  ownerCoadminUserId: "owner-1",
  competitionId: "competition-1"
};

const integration = {
  id: "integration-1",
  postingEnabled: true,
  channelId: "-100123",
  channelTitle: "Atlas"
};

function contact(displayName: string) {
  return { id: `${displayName}-id`, displayName, username: null, chats: [] };
}

function createHarness(bonusAward: Record<string, unknown> | null) {
  let winnersPictureArtifact: Record<string, unknown> | null = null;
  const sendPhoto = vi.fn(async () => ({ messageId: 321 }));
  const prisma = {
    leaderboardTelegramArtifact: {
      findUnique: vi.fn(async ({ where }: any) => {
        const type = where.competitionId_artifactType.artifactType;
        if (type === "WINNERS_PICTURE") return winnersPictureArtifact;
        return { messageId: "123", chatId: integration.channelId };
      }),
      upsert: vi.fn(async ({ create }: any) => {
        winnersPictureArtifact = create;
        return create;
      })
    },
    leaderboardCompetition: {
      findFirst: vi.fn(async () => ({
        startsAt: new Date("2026-09-01T00:00:00.000Z"),
        endsAt: new Date("2026-09-14T00:00:00.000Z"),
        prizePoolCents: 17500
      }))
    },
    leaderboardSettings: {
      findUnique: vi.fn(async () => ({ timezone: "America/Chicago" }))
    },
    giveawayPayout: {
      findMany: vi.fn(async () => [
        { prizeRank: 1, crmContactId: "top-1", payoutCents: 10000, crmContact: contact("Ada") },
        { prizeRank: 2, crmContactId: "top-2", payoutCents: 5000, crmContact: contact("Grace") },
        { prizeRank: 3, crmContactId: "top-3", payoutCents: 2500, crmContact: contact("Linus") }
      ])
    },
    leaderboardBonusAward: {
      findUnique: vi.fn(async () => bonusAward)
    },
    leaderboardBotIntegration: {
      update: vi.fn(async () => ({}))
    }
  };
  const outbox = { enqueueFinalLeaderboard: vi.fn(async () => "final-job") };
  const processor = new LeaderboardTelegramProcessor({
    prisma: prisma as never,
    encryptionKey: "k".repeat(64),
    outbox: outbox as never,
    client: { sendPhoto } as never
  });

  return { processor, prisma, sendPhoto };
}

async function publish(processor: LeaderboardTelegramProcessor) {
  await (processor as any).processPublishWinnersPicture(row, integration, "token");
}

describe("winner picture processor", () => {
  beforeEach(() => {
    renderWinnersPictureCard.mockClear();
  });

  it("loads the persisted bonus award and sends one combined winners image exactly once", async () => {
    const bonus = {
      crmContactId: "bonus-1",
      leaderboardRank: 7,
      rewardAmountCents: 1500,
      crmContact: contact("Bonus Winner")
    };
    const { processor, prisma, sendPhoto } = createHarness(bonus);

    await publish(processor);
    await publish(processor);

    expect(prisma.leaderboardBonusAward.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.leaderboardBonusAward.findUnique).toHaveBeenCalledWith({
      where: { competitionId: row.competitionId },
      include: { crmContact: { select: expect.any(Object) } }
    });
    expect(renderWinnersPictureCard).toHaveBeenCalledTimes(1);
    expect(renderWinnersPictureCard).toHaveBeenCalledWith(
      expect.objectContaining({
        winners: [
          expect.objectContaining({ prizeRank: 1, displayName: "Ada" }),
          expect.objectContaining({ prizeRank: 2, displayName: "Grace" }),
          expect.objectContaining({ prizeRank: 3, displayName: "Linus" })
        ],
        bonusWinner: {
          displayName: "Bonus Winner",
          leaderboardRank: 7,
          rewardAmountCents: 1500
        }
      })
    );
    expect(sendPhoto).toHaveBeenCalledTimes(1);
    expect(sendPhoto).toHaveBeenCalledWith("token", integration.channelId, Buffer.from("rendered-png"), {
      filename: "competition-winners.png"
    });
  });

  it("keeps the picture path valid when no bonus award was persisted", async () => {
    const { processor, sendPhoto } = createHarness(null);

    await publish(processor);

    expect(renderWinnersPictureCard).toHaveBeenCalledWith(
      expect.objectContaining({ bonusWinner: null })
    );
    expect(sendPhoto).toHaveBeenCalledTimes(1);
  });
});
