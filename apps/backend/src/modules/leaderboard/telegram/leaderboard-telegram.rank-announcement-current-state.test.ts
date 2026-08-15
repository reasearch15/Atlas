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

    expect(sentTexts(tgState)).toEqual(["🔥 John Mccloud is now #6!\n50 points behind #5."]);
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

    expect(sentTexts(tgState)[0]).toBe("🔥 John Mccloud is now #2!\n7 points behind #1.");
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
    expect(sentTexts(tgState)[0]).toBe("🔥 John Mccloud is now #6!\n50 points behind #5.");
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
    expect(sentTexts(tgState)[0]).toBe("🔥 John Mccloud moved #7 → #3!\n20 points behind #2.");
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

    expect(sentTexts(tgState)[0]).toBe(
      "🔥 John Mccloud is now #1!\nLeading the leaderboard with 300 PTS."
    );
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

    expect(sentTexts(tgState)[0]).toBe("🔥 John Mccloud moved #7 → #2!\n10 points behind #1.");
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

    expect(sentTexts(tgState)[0]).toContain("is now #2");
    expect(sentTexts(tgState)[0]).toContain("50 points behind #1");
    expect(sentTexts(tgState)[0]).not.toContain("900");
  });

  it("does not read another coadmin's standings during revalidation", async () => {
    const { prisma, tgState, outbox, processor } = seedProcessor();
    addStanding(prisma, "above", 125);
    addStanding(prisma, player, 110, { name: "John Mccloud" });
    addStanding(prisma, player, 999, {
      name: "Other Owner John",
      ownerCoadminUserId: ownerB,
      workspaceId: workspaceB
    });

    const id = await enqueueAnnouncement(outbox, {
      fromRank: null,
      toRank: 10,
      pointsBehindNext: 4
    });
    await processor.processJob(id);

    expect(sentTexts(tgState)[0]).toBe("🔥 John Mccloud is now #2!\n15 points behind #1.");
  });

  it("skips when the only matching standing belongs to another coadmin", async () => {
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

  it("does not let another competition's points change rank or gap", async () => {
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
    addStanding(prisma, "local-above", 120);
    addStanding(prisma, player, 110, { name: "John Mccloud" });

    const id = await enqueueAnnouncement(outbox, { fromRank: null, toRank: 10 });
    await processor.processJob(id);

    expect(sentTexts(tgState)[0]).toBe("🔥 John Mccloud is now #2!\n10 points behind #1.");
  });

  it("refreshes a stale 4-point gap after #9 gains points", async () => {
    const { prisma, tgState, outbox, processor } = seedProcessor();
    ids(8).forEach((id, i) => addStanding(prisma, id, 200 - i * 5));
    addStanding(prisma, "above", 114);
    addStanding(prisma, player, 110, { name: "John Mccloud" });

    const id = await enqueueAnnouncement(outbox, {
      fromRank: null,
      toRank: 10,
      pointsBehindNext: 4
    });
    prisma._state.standings.find((s: any) => s.crmContactId === "above").totalPoints = 125;
    await processor.processJob(id);

    expect(sentTexts(tgState)[0]).toBe("🔥 John Mccloud is now #10!\n15 points behind #9.");
    expect(sentTexts(tgState)[0]).not.toContain("4 points behind");
  });

  it("uses current #8 when the player climbs before send", async () => {
    const { prisma, tgState, outbox, processor } = seedProcessor();
    ids(7).forEach((id, i) => addStanding(prisma, id, 200 - i * 10));
    addStanding(prisma, "eighth", 135);
    addStanding(prisma, "above", 125);
    addStanding(prisma, player, 110, { name: "John Mccloud" });

    const id = await enqueueAnnouncement(outbox, {
      fromRank: null,
      toRank: 10,
      pointsBehindNext: 15
    });
    prisma._state.standings.find((s: any) => s.crmContactId === player).totalPoints = 138;
    await processor.processJob(id);

    expect(sentTexts(tgState)[0]).toBe("🔥 John Mccloud is now #8!\n2 points behind #7.");
    expect(sentTexts(tgState)[0]).not.toContain("#10");
    expect(sentTexts(tgState)[0]).not.toContain("15 points behind");
  });

  it("sends current-state copy when the original climb snapshot is no longer valid", async () => {
    const { prisma, tgState, outbox, processor } = seedProcessor();
    ids(6).forEach((id, i) => addStanding(prisma, id, 200 - i * 5));
    addStanding(prisma, player, 150, { name: "John Mccloud" });

    const id = await enqueueAnnouncement(outbox, { fromRank: 5, toRank: 3, pointsBehindNext: 8 });
    await processor.processJob(id);

    expect(sentTexts(tgState)).toHaveLength(1);
    expect(sentTexts(tgState)[0]).toBe("🔥 John Mccloud is now #7!\n25 points behind #6.");
    expect(sentTexts(tgState)[0]).not.toContain("moved");
    expect(sentTexts(tgState)[0]).not.toContain("#3");
    expect(sentTexts(tgState)[0]).not.toContain("8 points behind");
  });

  it("skips frozen competitions", async () => {
    const { prisma, tgState, outbox, processor } = seedProcessor();
    prisma._state.competitions[0].status = "FROZEN";
    addStanding(prisma, player, 300, { name: "John Mccloud" });

    const id = await enqueueAnnouncement(outbox, { fromRank: null, toRank: 1 });
    await processor.processJob(id);

    expect(sentTexts(tgState)).toEqual([]);
    expect(prisma._state.outbox[0].status).toBe("SUCCEEDED");
  });

  it("skips finalized competitions", async () => {
    const { prisma, tgState, outbox, processor } = seedProcessor();
    prisma._state.competitions[0].status = "FINALIZED";
    addStanding(prisma, player, 300, { name: "John Mccloud" });

    const id = await enqueueAnnouncement(outbox, { fromRank: 2, toRank: 1 });
    await processor.processJob(id);

    expect(sentTexts(tgState)).toEqual([]);
    expect(prisma._state.outbox[0].status).toBe("SUCCEEDED");
  });

  it("never renders frozen outbox rank or gap after standings change", async () => {
    const { prisma, tgState, outbox, processor } = seedProcessor();
    ids(8).forEach((id, i) => addStanding(prisma, id, 180 - i * 4));
    addStanding(prisma, "above", 114);
    addStanding(prisma, player, 110, { name: "John Mccloud" });

    const id = await enqueueAnnouncement(outbox, {
      fromRank: null,
      toRank: 10,
      pointsBehindNext: 4
    });
    prisma._state.standings.find((s: any) => s.crmContactId === "above").totalPoints = 125;
    prisma._state.standings.find((s: any) => s.crmContactId === player).totalPoints = 118;
    await processor.processJob(id);

    const text = sentTexts(tgState)[0] ?? "";
    expect(text).toBe("🔥 John Mccloud is now #10!\n7 points behind #9.");
    expect(text).not.toContain("moved unranked");
    expect(text).not.toContain("4 points behind");
  });

  it("revalidates rank-sensitive personal DMs from current standings", async () => {
    const { prisma, tgState, outbox, processor } = seedProcessor();
    prisma._state.playerLinks.push({
      id: "link-1",
      botIntegrationId: "99999999-9999-4999-8999-999999999999",
      ownerCoadminUserId: ownerA,
      crmContactId: player,
      telegramUserId: "555"
    });
    addStanding(prisma, "above", 125);
    addStanding(prisma, player, 110, { name: "John Mccloud" });

    const id = await outbox.enqueuePlayerDm({
      workspaceId: workspaceA,
      ownerCoadminUserId: ownerA,
      competitionId: competitionA,
      crmContactId: player,
      kind: "ENTER_TOP_10",
      fromRank: null,
      toRank: 10,
      totalPoints: 10
    });
    await processor.processJob(id);

    const dm = tgState.chats.get(555)?.messages.at(-1)?.text ?? "";
    expect(dm).toContain("You're now #2");
    expect(dm).toContain("Points: 110");
    expect(dm).not.toContain("Moved from unranked → #10");
    expect(dm).not.toContain("Points: 10");
  });
});
