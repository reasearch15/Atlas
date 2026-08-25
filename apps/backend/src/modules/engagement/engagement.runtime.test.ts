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
    (m) =>
      !m.deleted &&
      (Boolean(m.poll) ||
        m.text?.includes("WHICH WOULD YOU CHOOSE") ||
        m.text?.includes("POLL RESULTS") ||
        m.text?.includes("POLL CLOSED"))
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
  const runtime = new MemoryEngagementRuntime(undefined, client, state);
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

  it("closes with native stopPoll on the same message", async () => {
    const { runtime, state } = setup(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    const poll = runtime.polls.find((p) => p.status === "OPEN")!;
    const openMessageId = poll.telegramMessageId;
    runtime.vote({ pollId: poll.id, telegramUserId: "100", optionIndex: 0, now: new Date() });
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T14:00:00"));
    const message = state.chats.get(Number(channelId))?.messages[0];
    expect(String(message?.messageId)).toBe(openMessageId);
    expect(message?.poll?.isClosed).toBe(true);
    expect(message?.poll?.options.map((option) => option.voterCount)).toEqual([1, 0, 0, 0]);
    expect(message?.replyMarkup).toBeUndefined();
    expect(poll.closeEditedAt).not.toBeNull();
  });
});

describe("engagement poll presentation", () => {
  it("posts a native Telegram poll with four approved options and no callback buttons", async () => {
    const { runtime, state } = setup(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    const poll = runtime.polls.find((p) => p.status === "OPEN")!;
    const message = state.chats.get(Number(channelId))?.messages.find(
      (m) => String(m.messageId) === poll.telegramMessageId
    );
    expect(poll.telegramPollId).toBeTruthy();
    expect(message?.poll?.id).toBe(poll.telegramPollId);
    expect(message?.poll?.question).toBe(poll.questionText);
    expect(message?.poll?.isAnonymous).toBe(false);
    expect(message?.poll?.type).toBe("regular");
    expect(message?.poll?.allowsMultipleAnswers).toBe(false);
    expect(message?.poll?.allowsRevoting).toBe(false);
    expect(message?.poll?.options.map((option) => option.text)).toEqual([
      poll.option1,
      poll.option2,
      poll.option3,
      poll.option4
    ]);
    expect(message?.replyMarkup).toBeUndefined();
    expect(message?.text).toBeUndefined();
  });

  it("does not edit the public native poll after individual votes", async () => {
    const { runtime, state } = setup(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    const poll = runtime.polls.find((p) => p.status === "OPEN")!;
    const before = state.chats.get(Number(channelId))?.messages[0];
    runtime.voteFromPollAnswer({
      telegramPollId: poll.telegramPollId!,
      telegramUserId: "100",
      optionIds: [0],
      now: new Date()
    });
    runtime.voteFromPollAnswer({
      telegramPollId: poll.telegramPollId!,
      telegramUserId: "200",
      optionIds: [1],
      now: new Date()
    });
    const after = state.chats.get(Number(channelId))?.messages[0];
    expect(after?.messageId).toBe(before?.messageId);
    expect(after?.poll?.isClosed).toBe(false);
    expect(after?.replyMarkup).toBeUndefined();
    expect(pollChannelMessages(state)).toHaveLength(1);
  });

  it("closes the same native poll message with Telegram voter counts", async () => {
    const { runtime, state } = setup(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    const poll = runtime.polls.find((p) => p.status === "OPEN")!;
    const openMessageId = poll.telegramMessageId;
    runtime.voteFromPollAnswer({
      telegramPollId: poll.telegramPollId!,
      telegramUserId: "100",
      optionIds: [0],
      now: new Date()
    });
    runtime.voteFromPollAnswer({
      telegramPollId: poll.telegramPollId!,
      telegramUserId: "200",
      optionIds: [0],
      now: new Date()
    });
    runtime.voteFromPollAnswer({
      telegramPollId: poll.telegramPollId!,
      telegramUserId: "300",
      optionIds: [1],
      now: new Date()
    });
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T14:00:00"));
    const message = state.chats.get(Number(channelId))?.messages.find(
      (m) => String(m.messageId) === openMessageId
    );
    expect(runtime.votes).toHaveLength(3);
    expect(poll.optionCounts).toEqual([2, 1, 0, 0]);
    expect(message?.poll?.isClosed).toBe(true);
    expect(message?.poll?.options.map((option) => option.voterCount)).toEqual([2, 1, 0, 0]);
    expect(poll.winningOptionIndex).toBe(0);
    expect(pollChannelMessages(state).filter((m) => String(m.messageId) === openMessageId)).toHaveLength(1);
  });

  it("handles a zero-vote native close without awarding points", async () => {
    const { runtime, state } = setup(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    const poll = runtime.polls.find((p) => p.status === "OPEN")!;
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T14:00:00"));
    const message = state.chats.get(Number(channelId))?.messages[0];
    expect(poll.status).toBe("SETTLED");
    expect(poll.winningOptionIndex).toBeNull();
    expect(runtime.ledger.filter((row) => row.kind === "POLL_PARTICIPATION")).toHaveLength(0);
    expect(message?.poll?.isClosed).toBe(true);
    expect(message?.poll?.totalVoterCount).toBe(0);
  });

  it("does not re-stop a closed native poll inconsistently on retry", async () => {
    const { runtime, state } = setup(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    const poll = runtime.polls.find((p) => p.status === "OPEN")!;
    runtime.vote({ pollId: poll.id, telegramUserId: "100", optionIndex: 2, now: new Date() });
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T14:00:00"));
    const closed = state.chats.get(Number(channelId))?.messages[0];
    const firstCloseAt = poll.closeEditedAt;
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T14:00:30"));
    expect(poll.closeEditedAt).toEqual(firstCloseAt);
    expect(state.chats.get(Number(channelId))?.messages[0]?.poll?.isClosed).toBe(true);
    expect(state.chats.get(Number(channelId))?.messages[0]?.messageId).toBe(closed?.messageId);
    poll.closeEditedAt = null;
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T14:01:00"));
    const original = state.chats.get(Number(channelId))?.messages.find((m) => m.messageId === closed?.messageId);
    expect(original?.poll?.isClosed).toBe(true);
    expect(original?.poll?.options.map((option) => option.voterCount)).toEqual(closed?.poll?.options.map((option) => option.voterCount));
  });
});

describe("engagement daily declaration", () => {
  it("keeps the 10 PM poll on the next declaration day", async () => {
    const { runtime } = setup(chicagoWallTimeToUtc("2026-08-25T22:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T22:00:01"));
    const poll = runtime.polls.find((p) => p.slotKey === "2026-08-25T22:00")!;
    runtime.vote({ pollId: poll.id, telegramUserId: "100", optionIndex: 0, now: new Date() });
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T23:00:00"));
    expect(runtime.results.find((r) => r.chicagoDate === "2026-08-25")).toBeUndefined();
    expect(runtime.ledger.filter((row) => row.chicagoDate === "2026-08-25" && row.kind === "POLL_PARTICIPATION")).toHaveLength(0);
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-26T02:00:00"));
    expect(runtime.ledger.filter((row) => row.chicagoDate === "2026-08-26" && row.kind === "POLL_PARTICIPATION")).toHaveLength(1);
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-26T23:00:00"));
    expect(runtime.results.find((r) => r.chicagoDate === "2026-08-26")).toBeTruthy();
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

describe("engagement activation boundary", () => {
  it("does not synthesize a historical daily result from old referrals on a fresh deploy", async () => {
    const { runtime } = setup(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    runtime.referrals.push(
      {
        id: "ref-old-floor",
        ownerCoadminUserId: owner,
        referrerCrmContactId: contactA,
        status: "ACTIVE",
        awardedAt: chicagoWallTimeToUtc("2026-01-01T12:00:00")
      },
      {
        id: "ref-old-other",
        ownerCoadminUserId: owner,
        referrerCrmContactId: contactB,
        status: "ACTIVE",
        awardedAt: chicagoWallTimeToUtc("2026-02-01T12:00:00")
      }
    );
    expect(runtime.polls).toHaveLength(0);
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:45"));
    expect(runtime.results.find((r) => r.chicagoDate === "2026-08-24")).toBeUndefined();
    expect(runtime.results).toHaveLength(0);
    expect(runtime.claims.filter((c) => c.idempotencyKey.includes(":2026-08-24:"))).toHaveLength(0);
    expect(runtime.ledger.filter((row) => row.chicagoDate === "2026-08-24")).toHaveLength(0);
    expect(runtime.polls.some((p) => p.slotKey === "2026-08-25T10:00" && p.status === "OPEN")).toBe(true);
    expect(runtime.polls.some((p) => p.slotKey === "2026-08-25T14:00")).toBe(true);
    expect(runtime.polls.some((p) => p.slotKey === "2026-08-25T22:00")).toBe(true);
  });

  it("can create the first legitimate daily result after polling has started", async () => {
    const { runtime } = setup(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    runtime.referrals.push({
      id: "ref-old-floor",
      ownerCoadminUserId: owner,
      referrerCrmContactId: contactA,
      status: "ACTIVE",
      awardedAt: chicagoWallTimeToUtc("2026-01-01T12:00:00")
    });
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    const poll = runtime.polls.find((p) => p.status === "OPEN")!;
    runtime.vote({ pollId: poll.id, telegramUserId: "100", optionIndex: 0, now: new Date() });
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T14:00:00"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T23:00:00"));
    const result = runtime.results.find((r) => r.chicagoDate === "2026-08-25");
    expect(result).toBeTruthy();
    expect(runtime.results.find((r) => r.chicagoDate === "2026-08-24")).toBeUndefined();
    const emily = (result?.snapshot as Array<{ crmContactId: string; referralPoints: number; pollPoints: number }>).find(
      (row) => row.crmContactId === contactA
    );
    expect(emily?.pollPoints).toBe(10);
    expect(emily?.referralPoints).toBe(20);
    expect(result?.firstCrmContactId).toBe(contactA);
  });

  it("recovers a missed legitimate declaration after engagement has been running", async () => {
    const { runtime } = setup(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    const poll = runtime.polls.find((p) => p.status === "OPEN")!;
    runtime.vote({ pollId: poll.id, telegramUserId: "100", optionIndex: 0, now: new Date() });
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-26T08:00:00"));
    expect(runtime.results.some((r) => r.chicagoDate === "2026-08-25")).toBe(true);
    expect(runtime.results.some((r) => r.chicagoDate === "2026-08-24")).toBe(false);
  });

  it("lets historical referrals contribute a 20-point floor without creating historical days", async () => {
    const { runtime } = setup(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    runtime.referrals.push({
      id: "ref-old-floor",
      ownerCoadminUserId: owner,
      referrerCrmContactId: contactB,
      status: "ACTIVE",
      awardedAt: chicagoWallTimeToUtc("2026-03-15T12:00:00")
    });
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    expect(runtime.results).toHaveLength(0);
    const poll = runtime.polls.find((p) => p.status === "OPEN")!;
    runtime.vote({ pollId: poll.id, telegramUserId: "200", optionIndex: 0, now: new Date() });
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T14:00:00"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T23:00:00"));
    const result = runtime.results.find((r) => r.chicagoDate === "2026-08-25")!;
    const john = (result.snapshot as Array<{ crmContactId: string; referralPoints: number; totalPoints: number }>).find(
      (row) => row.crmContactId === contactB
    );
    expect(john?.referralPoints).toBe(20);
    expect(john?.totalPoints).toBe(30);
    expect(runtime.results.map((r) => r.chicagoDate)).toEqual(["2026-08-25"]);
  });

  it("does not disturb current or future scheduled polls while skipping historical catch-up", async () => {
    const { runtime, state } = setup(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    runtime.referrals.push({
      id: "ref-old-floor",
      ownerCoadminUserId: owner,
      referrerCrmContactId: contactA,
      status: "ACTIVE",
      awardedAt: chicagoWallTimeToUtc("2026-01-01T12:00:00")
    });
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    const tenAm = runtime.polls.find((p) => p.slotKey === "2026-08-25T10:00")!;
    const twoPm = runtime.polls.find((p) => p.slotKey === "2026-08-25T14:00")!;
    const tenPm = runtime.polls.find((p) => p.slotKey === "2026-08-25T22:00")!;
    expect(tenAm.status).toBe("OPEN");
    expect(tenAm.telegramMessageId).toBeTruthy();
    expect(twoPm.status).toBe("SCHEDULED");
    expect(tenPm.status).toBe("SCHEDULED");
    expect(tenPm.chicagoDate).toBe("2026-08-26");
    expect(pollChannelMessages(state)).toHaveLength(1);
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T14:00:00"));
    expect(runtime.polls.find((p) => p.slotKey === "2026-08-25T10:00")?.status).toBe("SETTLED");
    expect(runtime.polls.find((p) => p.slotKey === "2026-08-25T14:00")?.status).toBe("OPEN");
    expect(runtime.results).toHaveLength(0);
  });

  it("keeps repeated startup sweeps idempotent around the activation boundary", async () => {
    const { runtime, state } = setup(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    runtime.referrals.push({
      id: "ref-old-floor",
      ownerCoadminUserId: owner,
      referrerCrmContactId: contactA,
      status: "ACTIVE",
      awardedAt: chicagoWallTimeToUtc("2026-01-01T12:00:00")
    });
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    const pollCount = runtime.polls.length;
    const ledgerCount = runtime.ledger.length;
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:20"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:01:00"));
    expect(runtime.results).toHaveLength(0);
    expect(runtime.polls).toHaveLength(pollCount);
    expect(runtime.ledger).toHaveLength(ledgerCount);
    expect(pollChannelMessages(state)).toHaveLength(1);
    const poll = runtime.polls.find((p) => p.status === "OPEN")!;
    runtime.vote({ pollId: poll.id, telegramUserId: "100", optionIndex: 0, now: new Date() });
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T23:00:00"));
    const afterDeclare = runtime.results.length;
    const afterClaims = runtime.claims.length;
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T23:00:30"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T23:01:00"));
    expect(runtime.results).toHaveLength(afterDeclare);
    expect(runtime.claims).toHaveLength(afterClaims);
    expect(runtime.results.filter((r) => r.chicagoDate === "2026-08-25")).toHaveLength(1);
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

describe("native poll answers and scoring", () => {
  it("routes poll_answer by Telegram poll id and ignores username", async () => {
    const { runtime } = setup(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    const poll = runtime.polls.find((p) => p.status === "OPEN")!;
    expect(
      runtime.voteFromPollAnswer({
        telegramPollId: poll.telegramPollId!,
        telegramUserId: "100",
        optionIds: [2],
        now: new Date(),
        username: "spoofed"
      })
    ).toBe("recorded");
    expect(runtime.votes[0]?.crmContactId).toBe(contactA);
    expect(runtime.votes[0]?.optionIndex).toBe(2);
    expect(
      runtime.voteFromPollAnswer({
        telegramPollId: "missing-poll",
        telegramUserId: "100",
        optionIds: [0],
        now: new Date()
      })
    ).toBe("not_found");
  });

  it("updates a changed answer, handles empty option_ids, and is duplicate-safe", async () => {
    const { runtime } = setup(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    const poll = runtime.polls.find((p) => p.status === "OPEN")!;
    expect(
      runtime.voteFromPollAnswer({
        telegramPollId: poll.telegramPollId!,
        telegramUserId: "100",
        optionIds: [0],
        now: new Date()
      })
    ).toBe("recorded");
    expect(
      runtime.voteFromPollAnswer({
        telegramPollId: poll.telegramPollId!,
        telegramUserId: "100",
        optionIds: [0],
        now: new Date()
      })
    ).toBe("recorded");
    expect(
      runtime.voteFromPollAnswer({
        telegramPollId: poll.telegramPollId!,
        telegramUserId: "100",
        optionIds: [3],
        now: new Date()
      })
    ).toBe("updated");
    expect(runtime.votes).toHaveLength(1);
    expect(runtime.votes[0]?.optionIndex).toBe(3);
    expect(
      runtime.voteFromPollAnswer({
        telegramPollId: poll.telegramPollId!,
        telegramUserId: "100",
        optionIds: [],
        now: new Date()
      })
    ).toBe("withdrawn");
    expect(runtime.votes).toHaveLength(0);
  });

  it("gives unregistered voters no points while still counting them in the public winner", async () => {
    const { runtime, state } = setup(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    const poll = runtime.polls.find((p) => p.status === "OPEN")!;
    expect(
      runtime.voteFromPollAnswer({
        telegramPollId: poll.telegramPollId!,
        telegramUserId: "999",
        optionIds: [1],
        now: new Date()
      })
    ).toBe("unregistered");
    expect(
      runtime.voteFromPollAnswer({
        telegramPollId: poll.telegramPollId!,
        telegramUserId: "888",
        optionIds: [1],
        now: new Date()
      })
    ).toBe("unregistered");
    expect(
      runtime.voteFromPollAnswer({
        telegramPollId: poll.telegramPollId!,
        telegramUserId: "100",
        optionIds: [0],
        now: new Date()
      })
    ).toBe("recorded");
    expect(runtime.votes).toHaveLength(1);
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T14:00:00"));
    const message = state.chats.get(Number(channelId))?.messages[0];
    expect(message?.poll?.options.map((option) => option.voterCount)).toEqual([1, 2, 0, 0]);
    expect(poll.winningOptionIndex).toBe(1);
    const awards = runtime.ledger.filter((row) => row.kind === "POLL_PARTICIPATION");
    expect(awards).toHaveLength(1);
    expect(awards[0]?.crmContactId).toBe(contactA);
    expect(awards[0]?.points).toBe(5);
  });

  it("uses the lowest option index on a native-count tie and awards 10 vs 5 without doubling", async () => {
    const { runtime } = setup(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    const poll = runtime.polls.find((p) => p.status === "OPEN")!;
    runtime.voteFromPollAnswer({
      telegramPollId: poll.telegramPollId!,
      telegramUserId: "100",
      optionIds: [1],
      now: new Date()
    });
    runtime.voteFromPollAnswer({
      telegramPollId: poll.telegramPollId!,
      telegramUserId: "200",
      optionIds: [2],
      now: new Date()
    });
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T14:00:00"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T14:00:30"));
    expect(poll.winningOptionIndex).toBe(1);
    const awards = runtime.ledger.filter((row) => row.kind === "POLL_PARTICIPATION");
    expect(awards).toHaveLength(2);
    expect(awards.find((row) => row.crmContactId === contactA)?.points).toBe(10);
    expect(awards.find((row) => row.crmContactId === contactB)?.points).toBe(5);
    expect(awards.some((row) => row.points === 15)).toBe(false);
  });

  it("keeps old custom-button polls working without a Telegram poll id", async () => {
    const legacyState: FakeLeaderboardTelegramState = {
      bots: new Map([["token", { id: 1, isBot: true, firstName: "Bot", username: "sayubot" }]]),
      chats: new Map([
        [
          Number(channelId),
          { id: Number(channelId), type: "channel", members: new Map(), messages: [], nextMessageId: 1 }
        ]
      ])
    };
    const fullClient = createFakeLeaderboardTelegramClient(legacyState);
    const legacyRuntime = new MemoryEngagementRuntime(undefined, {
      sendMessage: fullClient.sendMessage.bind(fullClient),
      editMessageText: fullClient.editMessageText.bind(fullClient)
    });
    legacyRuntime.importQuestions(tinyBank());
    legacyRuntime.integrations.push({
      id: integrationId,
      workspaceId: workspace,
      ownerCoadminUserId: owner,
      channelId,
      postingEnabled: true,
      disconnectedAt: null,
      botToken: "token"
    });
    legacyRuntime.contacts.set(contactA, { displayName: "Emily" });
    legacyRuntime.playerLinks.push({
      botIntegrationId: integrationId,
      telegramUserId: "100",
      crmContactId: contactA,
      ownerCoadminUserId: owner
    });
    await legacyRuntime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    const poll = legacyRuntime.polls.find((p) => p.status === "OPEN")!;
    expect(poll.telegramPollId).toBeNull();
    const open = legacyState.chats.get(Number(channelId))?.messages[0];
    expect(open?.replyMarkup?.inline_keyboard).toHaveLength(4);
    expect(
      legacyRuntime.voteFromCallback(buildVoteCallbackData(poll.id, 0), "100", new Date())
    ).toBe("recorded");
    await legacyRuntime.sweep(chicagoWallTimeToUtc("2026-08-25T14:00:00"));
    const closed = legacyState.chats.get(Number(channelId))?.messages[0];
    expect(String(closed?.messageId)).toBe(poll.telegramMessageId);
    expect(closed?.text).toContain("POLL RESULTS");
    expect(closed?.replyMarkup?.inline_keyboard).toEqual([]);
    expect(legacyRuntime.ledger.filter((row) => row.kind === "POLL_PARTICIPATION")[0]?.points).toBe(10);
  });
});

