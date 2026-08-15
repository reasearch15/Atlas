import { describe, expect, it } from "vitest";
import { encryptSecret } from "@atlas/shared/session-encryption";
import {
  createFakeLeaderboardTelegramClient,
  LeaderboardTelegramApiError,
  type FakeLeaderboardTelegramState
} from "./leaderboard-telegram.client";
import { LeaderboardTelegramOutboxService } from "./leaderboard-telegram.outbox";
import { LeaderboardTelegramProcessor } from "./leaderboard-telegram.processor";
import { createMemoryPrisma } from "./leaderboard-telegram.test-harness";

const encryptionKey = "k".repeat(64);
const workspaceA = "11111111-1111-4111-8111-111111111111";
const workspaceB = "22222222-2222-4222-8222-222222222222";
const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ownerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const competitionA = "c1111111-cccc-4ccc-8ccc-ccccccccccc1";
const competitionB = "c2222222-cccc-4ccc-8ccc-ccccccccccc2";
const channelId = "-1003981197633";
const player = "d0000000-dddd-4ddd-8ddd-dddddddddddd";

function ids(count: number) {
  return Array.from({ length: count }, (_, i) => `d${String(i + 1).padStart(7, "0")}-dddd-4ddd-8ddd-dddddddddddd`);
}

function seedProcessor() {
  const prisma = createMemoryPrisma();
  prisma._state.integrations.push({
    id: "99999999-9999-4999-8999-999999999999",
    workspaceId: workspaceA,
    ownerCoadminUserId: ownerA,
    encryptedBotToken: encryptSecret("tok", encryptionKey),
    botUsername: "atlas_lb_bot",
    channelId,
    channelTitle: "Test",
    postingEnabled: true,
    disconnectedAt: null,
    lastError: null
  });
  prisma._state.competitions.push({
    id: competitionA,
    workspaceId: workspaceA,
    ownerCoadminUserId: ownerA,
    status: "ACTIVE",
    prizePoolCents: 1000,
    startsAt: new Date("2026-08-01T00:00:00.000Z"),
    endsAt: new Date("2026-08-20T00:00:00.000Z"),
    sequence: 1
  });
  const tgState: FakeLeaderboardTelegramState = {
    bots: new Map([["tok", { id: 1, isBot: true, firstName: "Bot", username: "atlas_lb_bot" }]]),
    chats: new Map([
      [
        Number(channelId),
        {
          id: Number(channelId),
          type: "channel",
          title: "Test",
          members: new Map([[1, "administrator"]]),
          messages: [],
          nextMessageId: 1
        }
      ]
    ])
  };
  const client = createFakeLeaderboardTelegramClient(tgState);
  const outbox = new LeaderboardTelegramOutboxService(prisma as never, async () => undefined);
  const processor = new LeaderboardTelegramProcessor({
    prisma: prisma as never,
    encryptionKey,
    outbox,
    client
  });
  return { prisma, tgState, outbox, processor };
}

function addStanding(
  prisma: ReturnType<typeof createMemoryPrisma>,
  crmContactId: string,
  totalPoints: number,
  options: {
    readonly name?: string;
    readonly competitionId?: string;
    readonly ownerCoadminUserId?: string;
    readonly workspaceId?: string;
    readonly reachedAt?: Date;
  } = {}
) {
  prisma._state.standings.push({
    workspaceId: options.workspaceId ?? workspaceA,
    competitionId: options.competitionId ?? competitionA,
    ownerCoadminUserId: options.ownerCoadminUserId ?? ownerA,
    crmContactId,
    totalPoints,
    pointsReachedAt: options.reachedAt ?? new Date(`2026-08-15T00:${String(prisma._state.standings.length).padStart(2, "0")}:00.000Z`),
    crmContact: { displayName: options.name ?? crmContactId, chats: [] }
  });
}

async function enqueueAnnouncement(
  outbox: LeaderboardTelegramOutboxService,
  input: {
    readonly fromRank: number | null;
    readonly toRank: number;
    readonly pointsBehindNext?: number | null;
    readonly kind?: string;
  }
) {
  return outbox.enqueueRankAnnouncement({
    workspaceId: workspaceA,
    ownerCoadminUserId: ownerA,
    competitionId: competitionA,
    crmContactId: player,
    fromRank: input.fromRank,
    toRank: input.toRank,
    displayName: "John Mccloud",
    reason: "entering Top 10",
    kind: input.kind ?? "ENTER_TOP_10",
    totalPoints: 10,
    pointsGained: 10,
    pointsBehindNext: input.pointsBehindNext ?? null
  });
}

function sentTexts(tgState: FakeLeaderboardTelegramState) {
  return tgState.chats.get(Number(channelId))!.messages.map((m) => m.text ?? "");
}

describe("current-state rank announcements", () => {
  it("sends current #6 for a queued unranked-to-#10 announcement", async () => {
    const { prisma, tgState, outbox, processor } = seedProcessor();
    ids(5).forEach((id, i) => addStanding(prisma, id, 200 - i * 10));
    addStanding(prisma, player, 110, { name: "John Mccloud" });
    ids(4).forEach((id, i) => addStanding(prisma, id, 90 - i * 10));

    const id = await enqueueAnnouncement(outbox, { fromRank: null, toRank: 10 });
    await processor.processJob(id);

    expect(sentTexts(tgState)).toEqual([
      "🔥 John Mccloud entered the leaderboard and climbed to #6!\nNow only 50 points behind #5."
    ]);
    expect(sentTexts(tgState)[0]).not.toContain("#10");
  });

  it("recomputes stale pointsBehindNext from the current player above", async () => {
    const { prisma, tgState, outbox, processor } = seedProcessor();
    addStanding(prisma, "above", 117);
    addStanding(prisma, player, 110, { name: "John Mccloud" });

    const id = await enqueueAnnouncement(outbox, {
      fromRank: null,
      toRank: 10,
      pointsBehindNext: 999
    });
    await processor.processJob(id);

    expect(sentTexts(tgState)[0]).toContain("Now only 7 points behind #1.");
    expect(sentTexts(tgState)[0]).not.toContain("999");
    expect(sentTexts(tgState)[0]).not.toContain("behind #9");
  });

  it("coalesces rapid unranked-to-#10-to-#8-to-#6 alerts into one pending send", async () => {
    const { prisma, tgState, outbox, processor } = seedProcessor();
    ids(5).forEach((id, i) => addStanding(prisma, id, 200 - i * 10));
    addStanding(prisma, player, 110, { name: "John Mccloud" });

    const first = await enqueueAnnouncement(outbox, { fromRank: null, toRank: 10 });
    const second = await enqueueAnnouncement(outbox, { fromRank: 10, toRank: 8 });
    const third = await enqueueAnnouncement(outbox, { fromRank: 8, toRank: 6 });

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(prisma._state.outbox.filter((r: any) => r.jobType === "POST_RANK_ANNOUNCEMENT")).toHaveLength(1);
    expect(prisma._state.outbox[0].payloadJson.fromRank).toBeNull();

    await processor.processJob(first);
    expect(sentTexts(tgState)).toHaveLength(1);
    expect(sentTexts(tgState)[0]).toContain("entered the leaderboard and climbed to #6");
  });

  it("preserves earliest ranked context across coalesced #7-to-#5-to-#3 alerts", async () => {
    const { prisma, tgState, outbox, processor } = seedProcessor();
    addStanding(prisma, "first", 200);
    addStanding(prisma, "second", 180);
    addStanding(prisma, player, 160, { name: "John Mccloud" });

    const first = await enqueueAnnouncement(outbox, { fromRank: 7, toRank: 5, kind: "ENTER_TOP_10" });
    await enqueueAnnouncement(outbox, { fromRank: 5, toRank: 3, kind: "ENTER_TOP_3" });

    expect(prisma._state.outbox[0].payloadJson.fromRank).toBe(7);
    await processor.processJob(first);
    expect(sentTexts(tgState)[0]).toBe(
      "🔥 John Mccloud climbed from #7 → #3!\nNow only 20 points behind #2."
    );
  });

  it("skips cleanly when the player falls outside Top 10 before send", async () => {
    const { prisma, tgState, outbox, processor } = seedProcessor();
    ids(10).forEach((id, i) => addStanding(prisma, id, 200 - i * 10));
    addStanding(prisma, player, 1, { name: "John Mccloud" });

    const id = await enqueueAnnouncement(outbox, { fromRank: null, toRank: 10 });
    await processor.processJob(id);

    expect(sentTexts(tgState)).toEqual([]);
    expect(prisma._state.outbox[0].status).toBe("SUCCEEDED");
  });

  it("does not include a points-behind line for current #1", async () => {
    const { prisma, tgState, outbox, processor } = seedProcessor();
    addStanding(prisma, player, 300, { name: "John Mccloud" });
    addStanding(prisma, "second", 200);

    const id = await enqueueAnnouncement(outbox, {
      fromRank: 5,
      toRank: 3,
      pointsBehindNext: 10,
      kind: "ENTER_TOP_3"
    });
    await processor.processJob(id);

    expect(sentTexts(tgState)[0]).toBe("👑 NEW #1\nJohn Mccloud just took the top spot with 300 points.");
    expect(sentTexts(tgState)[0]).not.toContain("behind");
  });

  it("retry re-reads standings and sends the newest current state", async () => {
    const { prisma, tgState, outbox, processor } = seedProcessor();
    tgState.failures = new Map([
      [
        "tok:sendMessage",
        new LeaderboardTelegramApiError({
          httpStatus: 429,
          telegramErrorCode: 429,
          description: "Too Many Requests: retry after 1",
          permanent: false,
          retryAfterSeconds: 1
        })
      ]
    ]);
    addStanding(prisma, "a", 200);
    addStanding(prisma, "b", 180);
    addStanding(prisma, "c", 160);
    addStanding(prisma, player, 140, { name: "John Mccloud" });

    const id = await enqueueAnnouncement(outbox, { fromRank: 7, toRank: 5 });
    await processor.processJob(id);
    expect(prisma._state.outbox[0].status).toBe("RETRY_SCHEDULED");
    expect(sentTexts(tgState)).toEqual([]);

    prisma._state.standings.find((s: any) => s.crmContactId === player).totalPoints = 190;
    tgState.failures.clear();
    await processor.processJob(id);

    expect(sentTexts(tgState)[0]).toContain("climbed from #7 → #2");
  });

  it("processes old persisted payloads by correcting frozen rank fields", async () => {
    const { prisma, tgState, outbox, processor } = seedProcessor();
    addStanding(prisma, "a", 200);
    addStanding(prisma, player, 150, { name: "John Mccloud" });

    const id = await enqueueAnnouncement(outbox, {
      fromRank: null,
      toRank: 10,
      pointsBehindNext: 900
    });
    await processor.processJob(id);

    expect(sentTexts(tgState)[0]).toContain("climbed to #2");
    expect(sentTexts(tgState)[0]).toContain("50 points behind #1");
  });

  it("does not read another coadmin's standings during revalidation", async () => {
    const { prisma, tgState, outbox, processor } = seedProcessor();
    addStanding(prisma, player, 300, {
      name: "Other Owner John",
      ownerCoadminUserId: ownerB,
      workspaceId: workspaceB
    });

    const id = await enqueueAnnouncement(outbox, { fromRank: null, toRank: 10 });
    await processor.processJob(id);

    expect(sentTexts(tgState)).toEqual([]);
  });

  it("does not resolve an announcement against another competition", async () => {
    const { prisma, tgState, outbox, processor } = seedProcessor();
    prisma._state.competitions.push({
      id: competitionB,
      workspaceId: workspaceA,
      ownerCoadminUserId: ownerA,
      status: "ACTIVE",
      prizePoolCents: 1000,
      startsAt: new Date("2026-08-01T00:00:00.000Z"),
      endsAt: new Date("2026-08-20T00:00:00.000Z"),
      sequence: 2
    });
    addStanding(prisma, player, 300, {
      name: "John Mccloud",
      competitionId: competitionB
    });

    const id = await enqueueAnnouncement(outbox, { fromRank: null, toRank: 10 });
    await processor.processJob(id);

    expect(sentTexts(tgState)).toEqual([]);
  });
});
