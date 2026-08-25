import { describe, expect, it } from "vitest";
import { chicagoWallTimeToUtc } from "../leaderboard/competition-schedule";
import { createFakeLeaderboardTelegramClient, type FakeLeaderboardTelegramState } from "../leaderboard/telegram/leaderboard-telegram.client";
import { MemoryEngagementRuntime } from "./engagement.memory";
import { buildVoteCallbackData } from "./engagement.messages";
import type { EngagementQuestionInput } from "./question-bank";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const workspace = "11111111-1111-4111-8111-111111111111";
const integrationId = "i1111111-iiii-4iii-8iii-iiiiiiiiiii1";
const channelId = "-100123";
const contactA = "d1111111-dddd-4ddd-8ddd-ddddddddddd1";
const contactB = "d2222222-dddd-4ddd-8ddd-ddddddddddd2";
const contactC = "d3333333-dddd-4ddd-8ddd-ddddddddddd3";

function pollChannelMessages(state: FakeLeaderboardTelegramState) {
  return (state.chats.get(Number(channelId))?.messages ?? []).filter(
    (m) => !m.deleted && (m.text?.includes("WHICH WOULD YOU CHOOSE") || m.text?.includes("POLL CLOSED"))
  );
}

function tinyBank(count = 4): EngagementQuestionInput[] {
  return Array.from({ length: count }, (_, i) => ({
    externalId: String(i + 1),
    category: "Test",
    question: `Question ${i + 1}?`,
    options: ["A", "B", "C", "D"],
    active: true
  }));
}

function setup(now = chicagoWallTimeToUtc("2026-08-25T10:00:00"), questions = tinyBank()) {
  const state: FakeLeaderboardTelegramState = {
    bots: new Map([["token", { id: 1, isBot: true, firstName: "Bot", username: "sayubot" }]]),
    chats: new Map([
      [
        Number(channelId),
        { id: Number(channelId), type: "channel", members: new Map(), messages: [], nextMessageId: 1 }
      ]
    ])
  };
  const client = createFakeLeaderboardTelegramClient(state);
  const runtime = new MemoryEngagementRuntime(undefined, client);
  runtime.importQuestions(questions);
  runtime.integrations.push({
    id: integrationId,
    workspaceId: workspace,
    ownerCoadminUserId: owner,
    channelId,
    postingEnabled: true,
    disconnectedAt: null,
    botToken: "token"
  });
  runtime.contacts.set(contactA, { displayName: "Emily" });
  runtime.contacts.set(contactB, { displayName: "John" });
  runtime.contacts.set(contactC, { displayName: "Sarah" });
  runtime.playerLinks.push(
    { botIntegrationId: integrationId, telegramUserId: "100", crmContactId: contactA, ownerCoadminUserId: owner },
    { botIntegrationId: integrationId, telegramUserId: "200", crmContactId: contactB, ownerCoadminUserId: owner },
    { botIntegrationId: integrationId, telegramUserId: "300", crmContactId: contactC, ownerCoadminUserId: owner }
  );
  return { runtime, state, now };
}

describe("engagement cycle", () => {
  it("uses every question once before repeating, then starts a new shuffled cycle", async () => {
    const { runtime } = setup();
    const first = [];
    for (let i = 0; i < 4; i += 1) first.push((await runtime.drawNext(owner, workspace, new Date())).question.externalId);
    expect(first.sort()).toEqual(["1", "2", "3", "4"]);
    const next = (await runtime.drawNext(owner, workspace, new Date())).question.externalId;
    expect(["1", "2", "3", "4"]).toContain(next);
  });

  it("does not draw the same question concurrently in one cycle", async () => {
    const { runtime } = setup(undefined, tinyBank(20));
    const drawn = await Promise.all(
      Array.from({ length: 8 }, () => runtime.drawNext(owner, workspace, new Date()))
    );
    const ids = drawn.map((row) => row.question.id);
    expect(new Set(ids).size).toBe(8);
  });

  it("can cycle a larger approved-bank shaped import without repeats", async () => {
    const { runtime } = setup(undefined, tinyBank(12));
    const seen = new Set<string>();
    for (let i = 0; i < 12; i += 1) {
      seen.add((await runtime.drawNext(owner, workspace, new Date())).question.externalId);
    }
    expect(seen.size).toBe(12);
  });
});

describe("engagement voting and settlement", () => {
  it("records a registered vote and rejects unregistered, duplicates, and post-close votes", async () => {
    const { runtime } = setup(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    const poll = runtime.polls.find((p) => p.status === "OPEN")!;
    expect(runtime.vote({ pollId: poll.id, telegramUserId: "100", optionIndex: 0, now: new Date() })).toBe("recorded");
    expect(runtime.vote({ pollId: poll.id, telegramUserId: "100", optionIndex: 1, now: new Date() })).toBe("already_voted");
    expect(runtime.vote({ pollId: poll.id, telegramUserId: "999", optionIndex: 1, now: new Date() })).toBe("unregistered");
    expect(
      runtime.voteFromCallback(buildVoteCallbackData(poll.id, 2), "200", new Date(), "changed_name")
    ).toBe("recorded");
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T14:00:00"));
    expect(runtime.vote({ pollId: poll.id, telegramUserId: "300", optionIndex: 0, now: new Date() })).toBe("closed");
  });

  it("settles 5 vs 10 total and is idempotent", async () => {
    const { runtime } = setup(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    const poll = runtime.polls.find((p) => p.status === "OPEN")!;
    runtime.vote({ pollId: poll.id, telegramUserId: "100", optionIndex: 0, now: new Date() });
    runtime.vote({ pollId: poll.id, telegramUserId: "200", optionIndex: 1, now: new Date() });
    runtime.vote({ pollId: poll.id, telegramUserId: "300", optionIndex: 0, now: new Date() });
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T14:00:00"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T14:00:30"));
    const awards = runtime.ledger.filter((row) => row.kind === "POLL_PARTICIPATION");
    expect(awards).toHaveLength(3);
    expect(awards.find((row) => row.crmContactId === contactA)?.points).toBe(10);
    expect(awards.find((row) => row.crmContactId === contactB)?.points).toBe(5);
    expect(awards.every((row) => row.points === 5 || row.points === 10)).toBe(true);
    expect(awards.some((row) => row.points === 15)).toBe(false);
    expect(poll.winningOptionIndex).toBe(0);
  });

  it("does not post more than one poll for a slot and persists message ids", async () => {
    const { runtime, state } = setup(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:20"));
    const opens = runtime.polls.filter((p) => p.slotKey === "2026-08-25T10:00");
    expect(opens).toHaveLength(1);
    expect(opens[0]?.telegramMessageId).toBe("1");
    expect(pollChannelMessages(state)).toHaveLength(1);
  });

  it("closes with percentages and removes voting controls", async () => {
    const { runtime, state } = setup(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    const poll = runtime.polls.find((p) => p.status === "OPEN")!;
    runtime.vote({ pollId: poll.id, telegramUserId: "100", optionIndex: 0, now: new Date() });
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T14:00:00"));
    const message = state.chats.get(Number(channelId))?.messages[0];
    expect(message?.text).toContain("POLL CLOSED");
    expect(message?.text).toContain("Winning choice:");
    expect(message?.replyMarkup?.inline_keyboard).toEqual([]);
    expect(poll.closeEditedAt).not.toBeNull();
  });
});

describe("engagement daily declaration", () => {
  it("keeps the 10 PM poll on the next declaration day", async () => {
    const { runtime } = setup(chicagoWallTimeToUtc("2026-08-25T22:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T22:00:01"));
    const poll = runtime.polls.find((p) => p.slotKey === "2026-08-25T22:00")!;
    runtime.vote({ pollId: poll.id, telegramUserId: "100", optionIndex: 0, now: new Date() });
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T23:00:00"));
    expect(runtime.results.find((r) => r.chicagoDate === "2026-08-25")).toBeTruthy();
    expect(runtime.ledger.filter((row) => row.chicagoDate === "2026-08-25" && row.kind === "POLL_PARTICIPATION")).toHaveLength(0);
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-26T02:00:00"));
    expect(runtime.ledger.filter((row) => row.chicagoDate === "2026-08-26" && row.kind === "POLL_PARTICIPATION")).toHaveLength(1);
  });

  it("sums poll points plus independently aged referrals and declares Top 3 once", async () => {
    const { runtime, state } = setup(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    runtime.referrals.push(
      { id: "ref-old", ownerCoadminUserId: owner, referrerCrmContactId: contactA, status: "ACTIVE", awardedAt: chicagoWallTimeToUtc("2026-01-01T12:00:00") },
      { id: "ref-new", ownerCoadminUserId: owner, referrerCrmContactId: contactA, status: "ACTIVE", awardedAt: chicagoWallTimeToUtc("2026-08-25T12:00:00") },
      { id: "ref-dead", ownerCoadminUserId: owner, referrerCrmContactId: contactB, status: "REVERSED", awardedAt: chicagoWallTimeToUtc("2026-08-25T12:00:00") }
    );
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    const poll = runtime.polls.find((p) => p.status === "OPEN")!;
    runtime.vote({ pollId: poll.id, telegramUserId: "200", optionIndex: 0, now: new Date() });
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T14:00:00"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T23:00:00"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T23:00:30"));
    const result = runtime.results.find((r) => r.chicagoDate === "2026-08-25")!;
    expect(runtime.results.filter((r) => r.chicagoDate === "2026-08-25")).toHaveLength(1);
    expect(result.firstCrmContactId).toBe(contactA);
    const emily = (result.snapshot as Array<{ crmContactId: string; referralPoints: number; pollPoints: number }>).find(
      (row) => row.crmContactId === contactA
    );
    expect(emily?.referralPoints).toBe(70);
    const aug25Grants = runtime.claims.filter((c) =>
      c.idempotencyKey.startsWith(`eng:fp:${owner}:2026-08-25:`)
    );
    expect(aug25Grants).toHaveLength(2);
    expect(runtime.claims.find((c) => c.crmContactId === contactA)?.rewardAmountCents).toBe(500);
    expect(runtime.claims.find((c) => c.crmContactId === contactB)?.rewardAmountCents).toBe(200);
    const announcement = state.chats.get(Number(channelId))?.messages.at(-1)?.text ?? "";
    expect(announcement).toContain("DAILY ENGAGEMENT WINNERS");
    expect(announcement).toContain("Emily — $5 Freeplay");
    expect(announcement).not.toContain("70");
    expect(result.telegramMessageId).toBeTruthy();
    const ledgerCount = runtime.ledger.length;
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T23:01:00"));
    expect(runtime.ledger.length).toBe(ledgerCount);
    expect(runtime.claims.filter((c) => c.idempotencyKey.startsWith(`eng:fp:${owner}:2026-08-25:`))).toHaveLength(2);
  });

  it("does not carry prior-day poll points into the next declaration", async () => {
    const { runtime } = setup(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    const poll = runtime.polls.find((p) => p.status === "OPEN")!;
    runtime.vote({ pollId: poll.id, telegramUserId: "100", optionIndex: 0, now: new Date() });
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T14:00:00"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T23:00:00"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-26T23:00:00"));
    const next = runtime.results.find((r) => r.chicagoDate === "2026-08-26");
    const snapshot = (next?.snapshot as Array<{ crmContactId: string; pollPoints: number }> | undefined) ?? [];
    expect(snapshot.find((row) => row.crmContactId === contactA)?.pollPoints ?? 0).toBe(0);
    expect(runtime.ledger.filter((row) => row.chicagoDate === "2026-08-25")).not.toHaveLength(0);
  });
});

describe("engagement recovery", () => {
  it("posts a missed open slot and closes an overdue poll after restart", async () => {
    const { runtime } = setup(chicagoWallTimeToUtc("2026-08-25T11:00:00"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T11:00:00"));
    const poll = runtime.polls.find((p) => p.slotKey === "2026-08-25T10:00")!;
    expect(poll.status).toBe("OPEN");
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T14:05:00"));
    expect(poll.status).toBe("SETTLED");
  });

  it("completes an undeclared 11 PM result on startup", async () => {
    const { runtime } = setup(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    const poll = runtime.polls.find((p) => p.status === "OPEN")!;
    runtime.vote({ pollId: poll.id, telegramUserId: "100", optionIndex: 0, now: new Date() });
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-26T08:00:00"));
    expect(runtime.results.some((r) => r.chicagoDate === "2026-08-25")).toBe(true);
  });

  it("does not duplicate a poll message after a successful send", async () => {
    const { runtime, state } = setup(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:15"));
    expect(pollChannelMessages(state)).toHaveLength(1);
  });

  it("resumes a POSTING poll and a SETTLED poll that never finished Telegram edits", async () => {
    const { runtime, state } = setup(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    const poll = runtime.polls.find((p) => p.slotKey === "2026-08-25T10:00")!;
    poll.status = "POSTING";
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:20"));
    expect(poll.status).toBe("OPEN");
    expect(pollChannelMessages(state)).toHaveLength(1);
    runtime.vote({ pollId: poll.id, telegramUserId: "100", optionIndex: 0, now: new Date() });
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T14:00:00"));
    poll.closeEditedAt = null;
    const closedText = state.chats.get(Number(channelId))?.messages[0]?.text;
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T14:00:30"));
    expect(poll.closeEditedAt).not.toBeNull();
    expect(state.chats.get(Number(channelId))?.messages[0]?.text).toBe(closedText);
  });
});

describe("engagement freeplay grants", () => {
  it("creates wheel-free $5/$2/$1 claims and does not duplicate on retry", () => {
    const { runtime } = setup();
    const first = runtime.grantEngagementClaim({
      ownerCoadminUserId: owner,
      crmContactId: contactA,
      amountCents: 500,
      idempotencyKey: "eng:fp:owner:2026-08-25:1"
    });
    const replay = runtime.grantEngagementClaim({
      ownerCoadminUserId: owner,
      crmContactId: contactA,
      amountCents: 500,
      idempotencyKey: "eng:fp:owner:2026-08-25:1"
    });
    runtime.addWheelClaim({
      ownerCoadminUserId: owner,
      crmContactId: contactA,
      spinId: "spin-1",
      idempotencyKey: "wheel:spin-1",
      rewardAmountCents: 200
    });
    expect(first.replay).toBe(false);
    expect(replay.replay).toBe(true);
    expect(replay.claimId).toBe(first.claimId);
    expect(runtime.claims.find((c) => c.id === first.claimId)?.spinId).toBeNull();
    expect(runtime.claims.find((c) => c.source === "WHEEL")?.spinId).toBe("spin-1");
  });
});
