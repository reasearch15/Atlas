import { describe, expect, it } from "vitest";
import { chicagoWallTimeToUtc } from "../leaderboard/competition-schedule";
import { createFakeLeaderboardTelegramClient, type FakeLeaderboardTelegramState } from "../leaderboard/telegram/leaderboard-telegram.client";
import type { WheelRng } from "../leaderboard/wheel-rng";
import { MemoryEngagementRuntime } from "./engagement.memory";
import { buildVoteCallbackData } from "./engagement.messages";
import type { EngagementQuestionInput } from "./question-bank";
import { DAILY_DRAW_PRIZE_CENTS } from "./engagement.constants";
import { dailyDrawFreeplayIdempotencyKey } from "./engagement.draw";

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

function rngPick(pick: number): WheelRng {
  return {
    nextInt(maxExclusive: number) {
      if (pick < 0 || pick >= maxExclusive) {
        throw new Error(`pick ${pick} is outside 0..${maxExclusive - 1}`);
      }
      return pick;
    }
  };
}

function setup(
  now = chicagoWallTimeToUtc("2026-08-25T10:00:00"),
  questions = tinyBank(),
  rng?: WheelRng
) {
  const state: FakeLeaderboardTelegramState = {
    bots: new Map([["token", { id: 1, isBot: true, firstName: "Bot", username: "sayubot" }]]),
    chats: new Map([
      [
        Number(channelId),
        {
          id: Number(channelId),
          type: "channel",
          members: new Map([
            [100, "member"],
            [200, "member"],
            [300, "member"]
          ]),
          messages: [],
          nextMessageId: 1
        }
      ]
    ])
  };
  const client = createFakeLeaderboardTelegramClient(state);
  const runtime = new MemoryEngagementRuntime(undefined, client, state, rng);
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

  it("settles poll counts without awarding engagement points", async () => {
    const { runtime } = setup(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    const poll = runtime.polls.find((p) => p.status === "OPEN")!;
    runtime.vote({ pollId: poll.id, telegramUserId: "100", optionIndex: 0, now: new Date() });
    runtime.vote({ pollId: poll.id, telegramUserId: "200", optionIndex: 1, now: new Date() });
    runtime.vote({ pollId: poll.id, telegramUserId: "300", optionIndex: 0, now: new Date() });
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T14:00:00"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T14:00:30"));
    expect(runtime.ledger.filter((row) => row.kind === "POLL_PARTICIPATION")).toHaveLength(0);
    expect(poll.winningOptionIndex).toBe(0);
    expect(poll.optionCounts).toEqual([2, 1, 0, 0]);
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
    expect(message?.poll?.isAnonymous).toBe(true);
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

describe("engagement poll schedule", () => {
  it("keeps the 10 PM poll on the next Chicago scoring date and awards no poll points", async () => {
    const { runtime } = setup(chicagoWallTimeToUtc("2026-08-25T22:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T22:00:01"));
    const poll = runtime.polls.find((p) => p.slotKey === "2026-08-25T22:00")!;
    expect(poll.chicagoDate).toBe("2026-08-26");
    runtime.vote({ pollId: poll.id, telegramUserId: "100", optionIndex: 0, now: new Date() });
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T23:00:00"));
    expect(runtime.ledger.filter((row) => row.kind === "POLL_PARTICIPATION")).toHaveLength(0);
    expect(runtime.results).toHaveLength(0);
    expect(runtime.draws.find((row) => row.chicagoDate === "2026-08-25")).toBeUndefined();
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-26T02:00:00"));
    expect(poll.status).toBe("SETTLED");
    expect(runtime.ledger.filter((row) => row.kind === "POLL_PARTICIPATION")).toHaveLength(0);
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-26T23:00:00"));
    expect(runtime.draws.filter((row) => row.chicagoDate === "2026-08-26")).toHaveLength(1);
    expect(runtime.results).toHaveLength(0);
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

describe("native poll answers without scoring", () => {
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
  });

  it("counts unregistered native votes publicly without awarding anyone points", async () => {
    const { runtime, state } = setup(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    const poll = runtime.polls.find((p) => p.status === "OPEN")!;
    runtime.voteFromPollAnswer({
      telegramPollId: poll.telegramPollId!,
      telegramUserId: "999",
      optionIds: [1],
      now: new Date()
    });
    runtime.voteFromPollAnswer({
      telegramPollId: poll.telegramPollId!,
      telegramUserId: "100",
      optionIds: [0],
      now: new Date()
    });
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T14:00:00"));
    expect(state.chats.get(Number(channelId))?.messages[0]?.poll?.options.map((option) => option.voterCount)).toEqual([
      1, 1, 0, 0
    ]);
    expect(runtime.ledger.filter((row) => row.kind === "POLL_PARTICIPATION")).toHaveLength(0);
  });

  it("keeps old custom-button polls working without a Telegram poll id or points", async () => {
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
    expect(legacyState.chats.get(Number(channelId))?.messages[0]?.replyMarkup?.inline_keyboard).toHaveLength(4);
    expect(legacyRuntime.voteFromCallback(buildVoteCallbackData(poll.id, 0), "100", new Date())).toBe("recorded");
    await legacyRuntime.sweep(chicagoWallTimeToUtc("2026-08-25T14:00:00"));
    expect(legacyState.chats.get(Number(channelId))?.messages[0]?.text).toContain("POLL RESULTS");
    expect(legacyRuntime.ledger.filter((row) => row.kind === "POLL_PARTICIPATION")).toHaveLength(0);
  });
});

