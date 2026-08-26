import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { chicagoWallTimeToUtc } from "../leaderboard/competition-schedule";
import {
  createFakeLeaderboardTelegramClient,
  LeaderboardTelegramApiError,
  type FakeLeaderboardTelegramState
} from "../leaderboard/telegram/leaderboard-telegram.client";
import type { WheelRng } from "../leaderboard/wheel-rng";
import { MemoryEngagementRuntime } from "./engagement.memory";
import { buildPollInlineKeyboard, buildVoteCallbackData } from "./engagement.messages";
import { POLL_HEADER_THEMES, pollHeaderRepeatsQuestion } from "./engagement.poll-header";
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

function nativePollMessage(
  state: FakeLeaderboardTelegramState,
  poll: { readonly telegramMessageId: string | null }
) {
  return (state.chats.get(Number(channelId))?.messages ?? []).find(
    (m) => String(m.messageId) === poll.telegramMessageId
  );
}

function headerMessage(
  state: FakeLeaderboardTelegramState,
  poll: { readonly telegramHeaderMessageId: string | null }
) {
  return (state.chats.get(Number(channelId))?.messages ?? []).find(
    (m) => String(m.messageId) === poll.telegramHeaderMessageId
  );
}

const emojiChallengeBank: EngagementQuestionInput[] = [
  {
    externalId: "1",
    category: "Sports & Games",
    question: "🏆🔥 Which would you choose for a challenge?",
    options: ["🛶 Kayaking", "🎳 Bowling", "🏊 Swimming", "🏈 Football"],
    active: true
  },
  {
    externalId: "2",
    category: "Sports & Games",
    question: "🎯🔥 Which game are you picking?",
    options: ["🎲 Dice", "🃏 Cards", "🎳 Bowling", "🕹️ Arcade"],
    active: true
  },
  {
    externalId: "3",
    category: "Sports & Games",
    question: "⚡🏆 Ready for the next round?",
    options: ["🛶 Kayaking", "🏈 Football", "🏊 Swimming", "🎯 Darts"],
    active: true
  },
  {
    externalId: "4",
    category: "Sports & Games",
    question: "💥🎰 What's the move?",
    options: ["🎰 Slots", "🎲 Dice", "🃏 Poker", "🎯 Darts"],
    active: true
  }
];

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
    expect(runtime.vote({ pollId: poll.id, telegramUserId: "100", optionIndex: 0, now: chicagoWallTimeToUtc("2026-08-25T10:05:00") })).toBe("recorded");
    expect(runtime.vote({ pollId: poll.id, telegramUserId: "100", optionIndex: 1, now: chicagoWallTimeToUtc("2026-08-25T10:05:00") })).toBe("already_voted");
    expect(runtime.vote({ pollId: poll.id, telegramUserId: "999", optionIndex: 1, now: chicagoWallTimeToUtc("2026-08-25T10:05:00") })).toBe("unregistered");
    expect(
      runtime.voteFromCallback(buildVoteCallbackData(poll.id, 2), "200", chicagoWallTimeToUtc("2026-08-25T10:05:00"), "changed_name")
    ).toBe("recorded");
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T14:00:00"));
    expect(runtime.vote({ pollId: poll.id, telegramUserId: "300", optionIndex: 0, now: chicagoWallTimeToUtc("2026-08-25T10:05:00") })).toBe("closed");
  });

  it("settles poll counts without awarding engagement points", async () => {
    const { runtime } = setup(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    const poll = runtime.polls.find((p) => p.status === "OPEN")!;
    runtime.vote({ pollId: poll.id, telegramUserId: "100", optionIndex: 0, now: chicagoWallTimeToUtc("2026-08-25T10:05:00") });
    runtime.vote({ pollId: poll.id, telegramUserId: "200", optionIndex: 1, now: chicagoWallTimeToUtc("2026-08-25T10:05:00") });
    runtime.vote({ pollId: poll.id, telegramUserId: "300", optionIndex: 0, now: chicagoWallTimeToUtc("2026-08-25T10:05:00") });
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
    expect(opens[0]?.telegramHeaderMessageId).toBe("1");
    expect(opens[0]?.telegramMessageId).toBe("2");
    expect(pollChannelMessages(state)).toHaveLength(1);
  });

  it("closes with native stopPoll on the same message", async () => {
    const { runtime, state } = setup(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    const poll = runtime.polls.find((p) => p.status === "OPEN")!;
    const openMessageId = poll.telegramMessageId;
    runtime.vote({ pollId: poll.id, telegramUserId: "100", optionIndex: 0, now: chicagoWallTimeToUtc("2026-08-25T10:05:00") });
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T14:00:00"));
    const message = nativePollMessage(state, poll);
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

  it("sends emoji question text and options to native sendPoll unchanged", async () => {
    const { runtime, state } = setup(chicagoWallTimeToUtc("2026-08-25T10:00:01"), [
      emojiChallengeBank[0]!
    ]);
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    const poll = runtime.polls.find((p) => p.status === "OPEN")!;
    const message = nativePollMessage(state, poll);
    expect(poll.questionText).toBe("🏆🔥 Which would you choose for a challenge?");
    expect(message?.poll?.question).toBe("🏆🔥 Which would you choose for a challenge?");
    expect(message?.poll?.options.map((option) => option.text)).toEqual([
      "🛶 Kayaking",
      "🎳 Bowling",
      "🏊 Swimming",
      "🏈 Football"
    ]);
    expect(message?.poll?.isAnonymous).toBe(true);
    expect(message?.poll?.type).toBe("regular");
    expect(runtime.ledger.filter((row) => row.kind === "POLL_PARTICIPATION")).toHaveLength(0);
  });

  it("sends a decorative header before the native poll without repeating the question", async () => {
    const { runtime, state } = setup(chicagoWallTimeToUtc("2026-08-25T10:00:01"), emojiChallengeBank);
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    const poll = runtime.polls.find((p) => p.status === "OPEN")!;
    const header = headerMessage(state, poll);
    const message = nativePollMessage(state, poll);
    expect(poll.telegramHeaderMessageId).toBeTruthy();
    expect(poll.telegramMessageId).toBeTruthy();
    expect(poll.telegramHeaderMessageId).not.toBe(poll.telegramMessageId);
    expect(Number(poll.telegramHeaderMessageId)).toBeLessThan(Number(poll.telegramMessageId));
    expect(header?.text).toBeTruthy();
    expect(header?.poll).toBeUndefined();
    expect(POLL_HEADER_THEMES.some((theme) => theme.id === poll.headerThemeId && theme.text === header?.text)).toBe(
      true
    );
    expect(pollHeaderRepeatsQuestion(header?.text ?? "", poll.questionText ?? "")).toBe(false);
    expect(header?.text).not.toContain(poll.questionText);
    expect(message?.poll?.question).toBe(poll.questionText);
  });

  it("rotates header themes across consecutive polls", async () => {
    const { runtime, state } = setup(chicagoWallTimeToUtc("2026-08-25T06:00:01"), emojiChallengeBank);
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T06:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T14:00:01"));
    const posted = runtime.polls
      .filter((p) => p.telegramPollId && p.headerThemeId)
      .sort((a, b) => (a.postedAt?.getTime() ?? 0) - (b.postedAt?.getTime() ?? 0));
    expect(posted).toHaveLength(3);
    expect(new Set(posted.map((p) => p.headerThemeId)).size).toBeGreaterThan(1);
    expect(posted[1]?.headerThemeId).not.toBe(posted[0]?.headerThemeId);
    expect(posted[2]?.headerThemeId).not.toBe(posted[1]?.headerThemeId);
    expect(headerMessage(state, posted[0]!)?.text).not.toBe(headerMessage(state, posted[1]!)?.text);
  });

  it("does not edit the public native poll after individual votes", async () => {
    const { runtime, state } = setup(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    const poll = runtime.polls.find((p) => p.status === "OPEN")!;
    const before = nativePollMessage(state, poll);
    runtime.voteFromPollAnswer({
      telegramPollId: poll.telegramPollId!,
      telegramUserId: "100",
      optionIds: [0],
      now: chicagoWallTimeToUtc("2026-08-25T10:05:00")
    });
    runtime.voteFromPollAnswer({
      telegramPollId: poll.telegramPollId!,
      telegramUserId: "200",
      optionIds: [1],
      now: chicagoWallTimeToUtc("2026-08-25T10:05:00")
    });
    const after = nativePollMessage(state, poll);
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
      now: chicagoWallTimeToUtc("2026-08-25T10:05:00")
    });
    runtime.voteFromPollAnswer({
      telegramPollId: poll.telegramPollId!,
      telegramUserId: "200",
      optionIds: [0],
      now: chicagoWallTimeToUtc("2026-08-25T10:05:00")
    });
    runtime.voteFromPollAnswer({
      telegramPollId: poll.telegramPollId!,
      telegramUserId: "300",
      optionIds: [1],
      now: chicagoWallTimeToUtc("2026-08-25T10:05:00")
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
    const message = nativePollMessage(state, poll);
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
    runtime.vote({ pollId: poll.id, telegramUserId: "100", optionIndex: 2, now: chicagoWallTimeToUtc("2026-08-25T10:05:00") });
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T14:00:00"));
    const closed = nativePollMessage(state, poll);
    const firstCloseAt = poll.closeEditedAt;
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T14:00:30"));
    expect(poll.closeEditedAt).toEqual(firstCloseAt);
    expect(nativePollMessage(state, poll)?.poll?.isClosed).toBe(true);
    expect(nativePollMessage(state, poll)?.messageId).toBe(closed?.messageId);
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
    runtime.vote({ pollId: poll.id, telegramUserId: "100", optionIndex: 0, now: chicagoWallTimeToUtc("2026-08-25T10:05:00") });
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
    runtime.vote({ pollId: poll.id, telegramUserId: "100", optionIndex: 0, now: chicagoWallTimeToUtc("2026-08-25T10:05:00") });
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
        now: chicagoWallTimeToUtc("2026-08-25T10:05:00"),
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
      now: chicagoWallTimeToUtc("2026-08-25T10:05:00")
    });
    runtime.voteFromPollAnswer({
      telegramPollId: poll.telegramPollId!,
      telegramUserId: "100",
      optionIds: [0],
      now: chicagoWallTimeToUtc("2026-08-25T10:05:00")
    });
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T14:00:00"));
    expect(nativePollMessage(state, poll)?.poll?.options.map((option) => option.voterCount)).toEqual([
      1, 1, 0, 0
    ]);
    expect(runtime.ledger.filter((row) => row.kind === "POLL_PARTICIPATION")).toHaveLength(0);
  });

  it("still closes historical custom-button polls without a Telegram poll id or points", async () => {
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
      editMessageText: fullClient.editMessageText.bind(fullClient),
      sendPoll: fullClient.sendPoll.bind(fullClient),
      stopPoll: fullClient.stopPoll.bind(fullClient)
    });
    legacyRuntime.integrations.push({
      id: integrationId,
      workspaceId: workspace,
      ownerCoadminUserId: owner,
      channelId,
      postingEnabled: true,
      disconnectedAt: null,
      botToken: "token"
    });
    legacyRuntime.importQuestions(tinyBank());
    const legacyPollId = randomUUID();
    const opensAt = chicagoWallTimeToUtc("2026-08-25T06:00:00");
    const closesAt = chicagoWallTimeToUtc("2026-08-25T10:00:00");
    legacyRuntime.polls.push({
      id: legacyPollId,
      workspaceId: workspace,
      ownerCoadminUserId: owner,
      botIntegrationId: integrationId,
      slotKey: "2026-08-25T06:00",
      opensAt,
      closesAt,
      chicagoDate: "2026-08-25",
      status: "OPEN",
      channelId,
      questionText: "Which sounds most valuable to you?",
      option1: "A",
      option2: "B",
      option3: "C",
      option4: "D",
      telegramMessageId: "1",
      telegramPollId: null,
      telegramHeaderMessageId: null,
      headerThemeId: null,
      postedAt: opensAt,
      closedAt: null,
      settledAt: null,
      closeEditedAt: null,
      optionCounts: null,
      winningOptionIndex: null
    });
    await fullClient.sendMessage("token", channelId, "Legacy poll", {
      replyMarkup: buildPollInlineKeyboard(legacyPollId, ["A", "B", "C", "D"])
    });
    legacyRuntime.contacts.set(contactA, { displayName: "Emily" });
    legacyRuntime.playerLinks.push({
      botIntegrationId: integrationId,
      telegramUserId: "100",
      crmContactId: contactA,
      ownerCoadminUserId: owner
    });
    expect(legacyRuntime.voteFromCallback(buildVoteCallbackData(legacyPollId, 0), "100", opensAt)).toBe("recorded");
    await legacyRuntime.sweep(closesAt);
    const legacyMessage = legacyState.chats
      .get(Number(channelId))
      ?.messages.find((message) => message.messageId === 1);
    expect(legacyMessage?.text).toContain("POLL RESULTS");
    expect(legacyRuntime.ledger.filter((row) => row.kind === "POLL_PARTICIPATION")).toHaveLength(0);
  });
});

describe("native poll channel visibility retention", () => {
  function visibleNativePollMessages(state: FakeLeaderboardTelegramState) {
    return (state.chats.get(Number(channelId))?.messages ?? []).filter((m) => !m.deleted && Boolean(m.poll));
  }

  function trackedVisiblePolls(runtime: MemoryEngagementRuntime) {
    return runtime.polls
      .filter((p) => p.telegramPollId && p.telegramMessageId)
      .sort((a, b) => (a.postedAt?.getTime() ?? 0) - (b.postedAt?.getTime() ?? 0));
  }

  it("keeps the first three native polls visible with nothing deleted", async () => {
    const { runtime, state } = setup(chicagoWallTimeToUtc("2026-08-25T06:00:01"), tinyBank(12));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T06:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T14:00:01"));
    expect(visibleNativePollMessages(state)).toHaveLength(3);
    expect(trackedVisiblePolls(runtime)).toHaveLength(3);
    expect(state.chats.get(Number(channelId))?.messages.every((m) => !m.deleted)).toBe(true);
  });

  it("deletes the oldest native poll when the 4th is posted", async () => {
    const { runtime, state } = setup(chicagoWallTimeToUtc("2026-08-25T06:00:01"), tinyBank(12));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T06:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T14:00:01"));
    const first = runtime.polls.find((p) => p.slotKey === "2026-08-25T06:00")!;
    const firstMessageId = first.telegramMessageId;
    const firstHeaderId = first.telegramHeaderMessageId;
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T18:00:01"));
    expect(visibleNativePollMessages(state)).toHaveLength(3);
    expect(first.telegramMessageId).toBeNull();
    expect(first.telegramHeaderMessageId).toBeNull();
    expect(
      state.chats.get(Number(channelId))?.messages.find((m) => String(m.messageId) === firstMessageId)?.deleted
    ).toBe(true);
    expect(
      state.chats.get(Number(channelId))?.messages.find((m) => String(m.messageId) === firstHeaderId)?.deleted
    ).toBe(true);
    expect(trackedVisiblePolls(runtime).map((p) => p.slotKey)).toEqual([
      "2026-08-25T10:00",
      "2026-08-25T14:00",
      "2026-08-25T18:00"
    ]);
  });

  it("deletes the next-oldest when the 5th native poll posts", async () => {
    const { runtime, state } = setup(chicagoWallTimeToUtc("2026-08-25T06:00:01"), tinyBank(12));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T06:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T14:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T18:00:01"));
    const second = runtime.polls.find((p) => p.slotKey === "2026-08-25T10:00")!;
    const secondMessageId = second.telegramMessageId;
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T22:00:01"));
    expect(visibleNativePollMessages(state)).toHaveLength(3);
    expect(second.telegramMessageId).toBeNull();
    expect(
      state.chats.get(Number(channelId))?.messages.find((m) => String(m.messageId) === secondMessageId)?.deleted
    ).toBe(true);
    expect(trackedVisiblePolls(runtime).map((p) => p.slotKey)).toEqual([
      "2026-08-25T14:00",
      "2026-08-25T18:00",
      "2026-08-25T22:00"
    ]);
  });

  it("continues when an old poll message was already deleted manually", async () => {
    const { runtime, state } = setup(chicagoWallTimeToUtc("2026-08-25T06:00:01"), tinyBank(12));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T06:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T14:00:01"));
    const first = runtime.polls.find((p) => p.slotKey === "2026-08-25T06:00")!;
    const firstMessage = state.chats
      .get(Number(channelId))
      ?.messages.find((m) => String(m.messageId) === first.telegramMessageId);
    expect(firstMessage).toBeTruthy();
    firstMessage!.deleted = true;
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T18:00:01"));
    expect(runtime.polls.find((p) => p.slotKey === "2026-08-25T18:00")?.telegramPollId).toBeTruthy();
    expect(first.telegramMessageId).toBeNull();
    expect(visibleNativePollMessages(state)).toHaveLength(3);
  });

  it("never deletes unrelated channel messages when pruning old polls", async () => {
    const { runtime, state, now } = setup(chicagoWallTimeToUtc("2026-08-25T06:00:01"), tinyBank(12));
    const client = createFakeLeaderboardTelegramClient(state);
    await client.sendMessage("token", channelId, "Leaderboard snapshot — do not delete");
    await client.sendPhoto("token", channelId, Buffer.from("fake-png"), {
      caption: "Daily Freeplay winner"
    });
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T06:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T14:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T18:00:01"));
    const messages = state.chats.get(Number(channelId))?.messages ?? [];
    const leaderboard = messages.find((m) => m.text?.includes("Leaderboard snapshot"));
    const draw = messages.find((m) => m.caption?.includes("Daily Freeplay winner"));
    expect(leaderboard?.deleted).toBeFalsy();
    expect(draw?.deleted).toBeFalsy();
    expect(visibleNativePollMessages(state)).toHaveLength(3);
    expect(now).toBeTruthy();
  });

  it("cleans up the correct old poll after a restart using persisted message ids", async () => {
    const sharedState: FakeLeaderboardTelegramState = {
      bots: new Map([["token", { id: 1, isBot: true, firstName: "Bot", username: "sayubot" }]]),
      chats: new Map([
        [
          Number(channelId),
          {
            id: Number(channelId),
            type: "channel",
            members: new Map([[100, "member"]]),
            messages: [],
            nextMessageId: 1
          }
        ]
      ])
    };
    const firstClient = createFakeLeaderboardTelegramClient(sharedState);
    const firstRuntime = new MemoryEngagementRuntime(undefined, firstClient, sharedState);
    firstRuntime.importQuestions(tinyBank(12));
    firstRuntime.integrations.push({
      id: integrationId,
      workspaceId: workspace,
      ownerCoadminUserId: owner,
      channelId,
      postingEnabled: true,
      disconnectedAt: null,
      botToken: "token"
    });
    await firstRuntime.sweep(chicagoWallTimeToUtc("2026-08-25T06:00:01"));
    await firstRuntime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await firstRuntime.sweep(chicagoWallTimeToUtc("2026-08-25T14:00:01"));

    // Simulate process restart: new runtime reloads durable poll rows (message ids included).
    const restartedClient = createFakeLeaderboardTelegramClient(sharedState);
    const restarted = new MemoryEngagementRuntime(undefined, restartedClient, sharedState);
    restarted.importQuestions(tinyBank(12));
    restarted.integrations.push({
      id: integrationId,
      workspaceId: workspace,
      ownerCoadminUserId: owner,
      channelId,
      postingEnabled: true,
      disconnectedAt: null,
      botToken: "token"
    });
    for (const poll of firstRuntime.polls) {
      restarted.polls.push({ ...poll });
    }
    const oldest = restarted.polls.find((p) => p.slotKey === "2026-08-25T06:00");
    const oldestMessageId = oldest?.telegramMessageId;
    const oldestHeaderId = oldest?.telegramHeaderMessageId;
    expect(oldestMessageId).toBeTruthy();
    expect(oldestHeaderId).toBeTruthy();
    await restarted.sweep(chicagoWallTimeToUtc("2026-08-25T18:00:01"));
    expect(
      sharedState.chats.get(Number(channelId))?.messages.find((m) => String(m.messageId) === oldestMessageId)
        ?.deleted
    ).toBe(true);
    expect(
      sharedState.chats.get(Number(channelId))?.messages.find((m) => String(m.messageId) === oldestHeaderId)
        ?.deleted
    ).toBe(true);
    expect(
      restarted.polls.filter((p) => p.telegramPollId && p.telegramMessageId).map((p) => p.slotKey).sort()
    ).toEqual(["2026-08-25T10:00", "2026-08-25T14:00", "2026-08-25T18:00"]);
  });

  it("still posts the new poll when Telegram deletion of an old set fails", async () => {
    const { runtime, state } = setup(chicagoWallTimeToUtc("2026-08-25T06:00:01"), tinyBank(12));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T06:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T14:00:01"));
    state.failures = new Map([
      [
        "token:deleteMessage",
        new LeaderboardTelegramApiError({
          httpStatus: 400,
          telegramErrorCode: 400,
          description: "Bad Request: failed to delete message",
          permanent: false
        })
      ]
    ]);
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T18:00:01"));
    const fourth = runtime.polls.find((p) => p.slotKey === "2026-08-25T18:00")!;
    expect(fourth.telegramPollId).toBeTruthy();
    expect(fourth.telegramMessageId).toBeTruthy();
    expect(fourth.telegramHeaderMessageId).toBeTruthy();
    expect(fourth.status).toBe("OPEN");
    expect(nativePollMessage(state, fourth)?.poll?.isAnonymous).toBe(true);
    expect(runtime.ledger.filter((row) => row.kind === "POLL_PARTICIPATION")).toHaveLength(0);
  });
});

