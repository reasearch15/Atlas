import { randomUUID } from "node:crypto";
import {
  DAILY_PRIZES_CENTS,
  POLL_DURATION_MS
} from "./engagement.constants";
import {
  EMPTY_INLINE_KEYBOARD,
  buildPollInlineKeyboard,
  formatClosedPollMessage,
  formatDailyWinnersMessage,
  formatOpenPollMessage,
  parseVoteCallbackData
} from "./engagement.messages";
import {
  listSlotsInRange,
  latestDeclarationChicagoDate,
  declarationInstantForChicagoDate,
  isEligibleEngagementDeclarationDate
} from "./engagement.schedule";
import {
  announceOutboxKey,
  closePollOutboxKey,
  freeplayGrantIdempotencyKey,
  pollParticipationIdempotencyKey,
  pollPointsForVote,
  postPollOutboxKey,
  rankEngagementPlayers,
  referralContributionAtDeclaration,
  referralContributionIdempotencyKey,
  countOptionVotes,
  parseStoredOptionCounts,
  nativeCountsFromPollOptions,
  winningOptionIndex,
  type EngagementScoreTotal
} from "./engagement.scoring";
import { shuffleIds, validateQuestionBank, type EngagementQuestionInput } from "./question-bank";
import {
  applyFakePollAnswer,
  type FakeLeaderboardTelegramState,
  type LeaderboardTelegramClient
} from "../leaderboard/telegram/leaderboard-telegram.client";

export type VoteStatus =
  | "recorded"
  | "already_voted"
  | "updated"
  | "withdrawn"
  | "unregistered"
  | "closed"
  | "not_found"
  | "invalid";

export interface MemoryQuestion {
  id: string;
  externalId: string;
  category: string;
  question: string;
  option1: string;
  option2: string;
  option3: string;
  option4: string;
  active: boolean;
}

export interface MemoryPoll {
  id: string;
  workspaceId: string;
  ownerCoadminUserId: string;
  botIntegrationId: string;
  slotKey: string;
  opensAt: Date;
  closesAt: Date;
  chicagoDate: string;
  status: "SCHEDULED" | "POSTING" | "OPEN" | "CLOSING" | "CLOSED" | "SETTLED" | "FAILED";
  questionId: string | null;
  cycleId: string | null;
  questionText: string | null;
  option1: string | null;
  option2: string | null;
  option3: string | null;
  option4: string | null;
  category: string | null;
  channelId: string | null;
  telegramMessageId: string | null;
  telegramPollId: string | null;
  postedAt: Date | null;
  closedAt: Date | null;
  closeEditedAt: Date | null;
  settledAt: Date | null;
  optionCounts: number[] | null;
  winningOptionIndex: number | null;
}

interface CycleItem {
  id: string;
  cycleId: string;
  questionId: string;
  drawOrder: number;
  usedAt: Date | null;
}

interface VoteRow {
  pollId: string;
  telegramUserId: string;
  crmContactId: string;
  optionIndex: number;
  votedAt: Date;
}

interface LedgerRow {
  id: string;
  ownerCoadminUserId: string;
  crmContactId: string;
  chicagoDate: string;
  kind: "POLL_PARTICIPATION" | "REFERRAL_CONTRIBUTION";
  points: number;
  pollId: string | null;
  referralId: string | null;
  idempotencyKey: string;
  createdAt: Date;
}

export interface MemoryDailyResult {
  id: string;
  ownerCoadminUserId: string;
  chicagoDate: string;
  declaredAt: Date;
  status: "SNAPSHOTTED" | "ANNOUNCED";
  firstCrmContactId: string | null;
  secondCrmContactId: string | null;
  thirdCrmContactId: string | null;
  snapshot: unknown;
  telegramMessageId: string | null;
  announcedAt: Date | null;
}

export interface MemoryFreeplayClaim {
  id: string;
  ownerCoadminUserId: string;
  crmContactId: string;
  spinId: string | null;
  source: "WHEEL" | "ENGAGEMENT_DAILY";
  idempotencyKey: string;
  rewardAmountCents: number;
}

type ChannelClient = Pick<LeaderboardTelegramClient, "sendMessage" | "editMessageText"> & {
  sendPoll?: LeaderboardTelegramClient["sendPoll"];
  stopPoll?: LeaderboardTelegramClient["stopPoll"];
};

export class MemoryEngagementRuntime {
  public readonly questions: MemoryQuestion[] = [];
  public readonly polls: MemoryPoll[] = [];
  public readonly votes: VoteRow[] = [];
  public readonly ledger: LedgerRow[] = [];
  public readonly results: MemoryDailyResult[] = [];
  public readonly claims: MemoryFreeplayClaim[] = [];
  public readonly outbox: Array<{ jobType: string; idempotencyKey: string; payload: Record<string, unknown>; status: string }> =
    [];
  public readonly contacts = new Map<string, { displayName: string; username?: string }>();
  public readonly playerLinks: Array<{
    botIntegrationId: string;
    telegramUserId: string;
    crmContactId: string;
    ownerCoadminUserId: string;
  }> = [];
  public readonly referrals: Array<{
    id: string;
    ownerCoadminUserId: string;
    referrerCrmContactId: string;
    status: "ACTIVE" | "REVERSED";
    awardedAt: Date;
  }> = [];
  public integrations: Array<{
    id: string;
    workspaceId: string;
    ownerCoadminUserId: string;
    channelId: string | null;
    postingEnabled: boolean;
    disconnectedAt: Date | null;
    botToken: string;
  }> = [];

  private readonly cycles: Array<{
    id: string;
    ownerCoadminUserId: string;
    workspaceId: string;
    cycleNumber: number;
    exhaustedAt: Date | null;
    items: CycleItem[];
  }> = [];
  private chain: Promise<unknown> = Promise.resolve();

  public constructor(
    private readonly random = Math.random,
    private readonly client?: ChannelClient,
    private readonly telegramState?: FakeLeaderboardTelegramState
  ) {}

  private lock<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  public importQuestions(rows: readonly EngagementQuestionInput[]): MemoryQuestion[] {
    const validated = validateQuestionBank(rows);
    for (const row of validated) {
      const existing = this.questions.find((q) => q.externalId === row.externalId);
      if (existing) {
        Object.assign(existing, { ...row, id: existing.id });
      } else {
        this.questions.push({ id: randomUUID(), ...row });
      }
    }
    return this.questions;
  }

  public addWheelClaim(input: Omit<MemoryFreeplayClaim, "id" | "source"> & { source?: "WHEEL" }): MemoryFreeplayClaim {
    const row: MemoryFreeplayClaim = {
      id: randomUUID(),
      source: input.source ?? "WHEEL",
      ownerCoadminUserId: input.ownerCoadminUserId,
      crmContactId: input.crmContactId,
      spinId: input.spinId,
      idempotencyKey: input.idempotencyKey,
      rewardAmountCents: input.rewardAmountCents
    };
    this.claims.push(row);
    return row;
  }

  public async sweep(now: Date): Promise<void> {
    await this.lock(async () => {
      for (const integration of this.integrations) {
        if (integration.disconnectedAt || !integration.postingEnabled || !integration.channelId) continue;
        this.ensureSlots(integration, now);
        await this.postDue(integration, now);
        await this.closeDue(integration, now);
        await this.declareDue(integration, now);
      }
    });
  }

  public vote(input: {
    readonly pollId: string;
    readonly telegramUserId: string;
    readonly optionIndex: number;
    readonly now: Date;
    readonly username?: string;
  }): VoteStatus {
    const poll = this.polls.find((p) => p.id === input.pollId);
    if (!poll) return "not_found";
    if (poll.status !== "OPEN" || input.now.getTime() >= poll.closesAt.getTime()) return "closed";
    if (input.optionIndex < 0 || input.optionIndex > 3) return "invalid";
    const link = this.playerLinks.find(
      (l) => l.botIntegrationId === poll.botIntegrationId && l.telegramUserId === input.telegramUserId
    );
    if (!link || link.ownerCoadminUserId !== poll.ownerCoadminUserId) return "unregistered";
    if (
      this.votes.some(
        (v) =>
          v.pollId === poll.id &&
          (v.telegramUserId === input.telegramUserId || v.crmContactId === link.crmContactId)
      )
    ) {
      return "already_voted";
    }
    this.votes.push({
      pollId: poll.id,
      telegramUserId: input.telegramUserId,
      crmContactId: link.crmContactId,
      optionIndex: input.optionIndex,
      votedAt: input.now
    });
    this.syncNativePollVote(poll, input.telegramUserId, [input.optionIndex]);
    return "recorded";
  }

  public voteFromPollAnswer(input: {
    readonly telegramPollId: string;
    readonly telegramUserId: string;
    readonly optionIds: readonly number[];
    readonly now: Date;
    readonly username?: string;
  }): VoteStatus {
    const poll = this.polls.find((p) => p.telegramPollId === input.telegramPollId);
    if (!poll) return "not_found";
    if (poll.status !== "OPEN" || input.now.getTime() >= poll.closesAt.getTime()) return "closed";
    this.syncNativePollVote(poll, input.telegramUserId, input.optionIds);
    const existing = this.votes.find(
      (v) => v.pollId === poll.id && v.telegramUserId === input.telegramUserId
    );
    if (input.optionIds.length === 0) {
      if (existing) {
        this.votes.splice(this.votes.indexOf(existing), 1);
      }
      return "withdrawn";
    }
    const optionIndex = input.optionIds[0];
    if (optionIndex == null || optionIndex < 0 || optionIndex > 3) return "invalid";
    const link = this.playerLinks.find(
      (l) => l.botIntegrationId === poll.botIntegrationId && l.telegramUserId === input.telegramUserId
    );
    if (!link || link.ownerCoadminUserId !== poll.ownerCoadminUserId) return "unregistered";
    if (existing) {
      if (existing.optionIndex === optionIndex) return "recorded";
      existing.optionIndex = optionIndex;
      existing.votedAt = input.now;
      return "updated";
    }
    this.votes.push({
      pollId: poll.id,
      telegramUserId: input.telegramUserId,
      crmContactId: link.crmContactId,
      optionIndex,
      votedAt: input.now
    });
    return "recorded";
  }

  private syncNativePollVote(poll: MemoryPoll, telegramUserId: string, optionIds: readonly number[]): void {
    if (!poll.telegramPollId || !this.telegramState) return;
    applyFakePollAnswer(this.telegramState, poll.telegramPollId, telegramUserId, optionIds);
  }

  public voteFromCallback(data: string, telegramUserId: string, now: Date, username?: string): VoteStatus {
    const parsed = parseVoteCallbackData(data);
    if (!parsed) return "invalid";
    return this.vote({
      pollId: parsed.pollId,
      telegramUserId,
      optionIndex: parsed.optionIndex,
      now,
      ...(username !== undefined ? { username } : {})
    });
  }

  public async drawNext(
    ownerCoadminUserId: string,
    workspaceId: string,
    now: Date
  ): Promise<{ cycleId: string; question: MemoryQuestion }> {
    return this.lock(() => this.drawNextQuestion(ownerCoadminUserId, workspaceId, now));
  }

  public drawNextQuestion(ownerCoadminUserId: string, workspaceId: string, now: Date): { cycleId: string; question: MemoryQuestion } {
    const active = this.questions.filter((q) => q.active);
    if (active.length === 0) throw new Error("No active engagement questions");
    let cycle = this.cycles.find((c) => c.ownerCoadminUserId === ownerCoadminUserId && !c.exhaustedAt);
    if (!cycle) {
      cycle = this.createCycle(ownerCoadminUserId, workspaceId, now, active);
    }
    let unused = cycle.items.filter((i) => !i.usedAt).sort((a, b) => a.drawOrder - b.drawOrder);
    if (unused.length === 0) {
      cycle.exhaustedAt = now;
      cycle = this.createCycle(ownerCoadminUserId, workspaceId, now, active);
      unused = cycle.items.filter((i) => !i.usedAt).sort((a, b) => a.drawOrder - b.drawOrder);
    }
    const item = unused[0]!;
    item.usedAt = now;
    if (cycle.items.every((i) => i.usedAt)) cycle.exhaustedAt = now;
    const question = this.questions.find((q) => q.id === item.questionId)!;
    return { cycleId: cycle.id, question };
  }

  public grantEngagementClaim(input: {
    ownerCoadminUserId: string;
    crmContactId: string;
    amountCents: number;
    idempotencyKey: string;
  }): { claimId: string; replay: boolean } {
    const existing = this.claims.find((c) => c.idempotencyKey === input.idempotencyKey);
    if (existing) return { claimId: existing.id, replay: true };
    const row: MemoryFreeplayClaim = {
      id: randomUUID(),
      ownerCoadminUserId: input.ownerCoadminUserId,
      crmContactId: input.crmContactId,
      spinId: null,
      source: "ENGAGEMENT_DAILY",
      idempotencyKey: input.idempotencyKey,
      rewardAmountCents: input.amountCents
    };
    this.claims.push(row);
    return { claimId: row.id, replay: false };
  }

  private createCycle(
    ownerCoadminUserId: string,
    workspaceId: string,
    now: Date,
    active: MemoryQuestion[]
  ) {
    const last = this.cycles
      .filter((c) => c.ownerCoadminUserId === ownerCoadminUserId)
      .sort((a, b) => b.cycleNumber - a.cycleNumber)[0];
    const cycle = {
      id: randomUUID(),
      ownerCoadminUserId,
      workspaceId,
      cycleNumber: (last?.cycleNumber ?? 0) + 1,
      exhaustedAt: null as Date | null,
      items: shuffleIds(active, this.random).map((question, drawOrder) => ({
        id: randomUUID(),
        cycleId: "",
        questionId: question.id,
        drawOrder,
        usedAt: null
      }))
    };
    cycle.items.forEach((item) => {
      item.cycleId = cycle.id;
    });
    this.cycles.push(cycle);
    return cycle;
  }

  private ensureSlots(
    integration: (typeof this.integrations)[number],
    now: Date
  ): void {
    const slots = listSlotsInRange(new Date(now.getTime() - 36 * 3600_000), new Date(now.getTime() + 36 * 3600_000));
    for (const slot of slots) {
      if (this.polls.some((p) => p.ownerCoadminUserId === integration.ownerCoadminUserId && p.slotKey === slot.slotKey)) {
        continue;
      }
      if (slot.closesAt.getTime() <= now.getTime()) continue;
      this.polls.push({
        id: randomUUID(),
        workspaceId: integration.workspaceId,
        ownerCoadminUserId: integration.ownerCoadminUserId,
        botIntegrationId: integration.id,
        slotKey: slot.slotKey,
        opensAt: slot.opensAt,
        closesAt: slot.closesAt,
        chicagoDate: slot.chicagoDate,
        status: "SCHEDULED",
        questionId: null,
        cycleId: null,
        questionText: null,
        option1: null,
        option2: null,
        option3: null,
        option4: null,
        category: null,
        channelId: integration.channelId,
        telegramMessageId: null,
        telegramPollId: null,
        postedAt: null,
        closedAt: null,
        closeEditedAt: null,
        settledAt: null,
        optionCounts: null,
        winningOptionIndex: null
      });
    }
  }

  private async postDue(integration: (typeof this.integrations)[number], now: Date): Promise<void> {
    const due = this.polls.filter(
      (p) =>
        p.botIntegrationId === integration.id &&
        (p.status === "SCHEDULED" || p.status === "POSTING") &&
        p.opensAt.getTime() <= now.getTime() &&
        p.closesAt.getTime() > now.getTime()
    );
    for (const poll of due) {
      if (poll.status === "SCHEDULED") {
        poll.status = "POSTING";
        const drawn = this.drawNextQuestion(poll.ownerCoadminUserId, poll.workspaceId, now);
        poll.questionId = drawn.question.id;
        poll.cycleId = drawn.cycleId;
        poll.questionText = drawn.question.question;
        poll.option1 = drawn.question.option1;
        poll.option2 = drawn.question.option2;
        poll.option3 = drawn.question.option3;
        poll.option4 = drawn.question.option4;
        poll.category = drawn.question.category;
      }
      this.enqueue("POST_ENGAGEMENT_POLL", postPollOutboxKey(poll.id), { pollId: poll.id });
      if (this.client && integration.channelId && poll.questionText && poll.option1) {
        if (!poll.telegramMessageId) {
          if (this.client.sendPoll) {
            try {
              const sent = await this.client.sendPoll(integration.botToken, integration.channelId, {
                question: poll.questionText,
                options: [poll.option1, poll.option2!, poll.option3!, poll.option4!],
                isAnonymous: false,
                type: "regular",
                allowsMultipleAnswers: false,
                allowsRevoting: false
              });
              poll.telegramMessageId = String(sent.messageId);
              poll.telegramPollId = sent.poll?.id ?? null;
            } catch {
              const sent = await this.client.sendMessage(
                integration.botToken,
                integration.channelId,
                formatOpenPollMessage(poll.questionText),
                {
                  replyMarkup: buildPollInlineKeyboard(poll.id, [
                    poll.option1,
                    poll.option2!,
                    poll.option3!,
                    poll.option4!
                  ])
                }
              );
              poll.telegramMessageId = String(sent.messageId);
            }
          } else {
            const sent = await this.client.sendMessage(
              integration.botToken,
              integration.channelId,
              formatOpenPollMessage(poll.questionText),
              {
                replyMarkup: buildPollInlineKeyboard(poll.id, [
                  poll.option1,
                  poll.option2!,
                  poll.option3!,
                  poll.option4!
                ])
              }
            );
            poll.telegramMessageId = String(sent.messageId);
          }
        }
        poll.status = "OPEN";
        poll.postedAt = now;
        this.completeOutbox(postPollOutboxKey(poll.id));
      }
    }
  }

  private async closeDue(integration: (typeof this.integrations)[number], now: Date): Promise<void> {
    const due = this.polls.filter(
      (p) =>
        p.botIntegrationId === integration.id &&
        (((p.status === "OPEN" || p.status === "CLOSING" || p.status === "CLOSED") &&
          p.closesAt.getTime() <= now.getTime()) ||
          (p.status === "SETTLED" && !p.closeEditedAt && p.telegramMessageId))
    );
    for (const poll of due) {
      if (poll.telegramPollId) {
        if (poll.status === "OPEN") poll.status = "CLOSING";
        this.enqueue("CLOSE_ENGAGEMENT_POLL", closePollOutboxKey(poll.id), { pollId: poll.id });
        if (this.client?.stopPoll && poll.channelId && poll.telegramMessageId && !poll.closeEditedAt) {
          let counts = parseStoredOptionCounts(poll.optionCounts);
          try {
            const stopped = await this.client.stopPoll(
              integration.botToken,
              poll.channelId,
              Number(poll.telegramMessageId)
            );
            counts = nativeCountsFromPollOptions(stopped.options) ?? counts;
          } catch {
            // Fake/retry: already-closed polls keep previously stored native counts.
          }
          if (counts) poll.optionCounts = counts;
          if (poll.status !== "SETTLED") this.settlePoll(poll, now);
          poll.closeEditedAt = now;
          this.completeOutbox(closePollOutboxKey(poll.id));
        } else if (poll.status !== "SETTLED") {
          this.settlePoll(poll, now);
        }
        continue;
      }
      if (poll.status === "OPEN") poll.status = "CLOSING";
      if (poll.status !== "SETTLED") this.settlePoll(poll, now);
      this.enqueue("CLOSE_ENGAGEMENT_POLL", closePollOutboxKey(poll.id), { pollId: poll.id });
      if (this.client && poll.channelId && poll.telegramMessageId && !poll.closeEditedAt) {
        const options = [poll.option1!, poll.option2!, poll.option3!, poll.option4!] as [
          string,
          string,
          string,
          string
        ];
        const counts = countOptionVotes(
          this.votes.filter((vote) => vote.pollId === poll.id).map((vote) => vote.optionIndex)
        );
        await this.client.editMessageText(
          integration.botToken,
          poll.channelId,
          Number(poll.telegramMessageId),
          formatClosedPollMessage({
            question: poll.questionText ?? "",
            options,
            counts
          }),
          undefined,
          EMPTY_INLINE_KEYBOARD
        );
        poll.closeEditedAt = now;
        this.completeOutbox(closePollOutboxKey(poll.id));
      }
    }
  }

  private settlePoll(poll: MemoryPoll, now: Date): void {
    if (poll.status === "SETTLED") return;
    const votes = this.votes.filter((v) => v.pollId === poll.id);
    const registeredCounts = countOptionVotes(votes.map((vote) => vote.optionIndex));
    const nativeCounts = poll.telegramPollId ? parseStoredOptionCounts(poll.optionCounts) : null;
    const counts = nativeCounts ?? registeredCounts;
    const totalVotes = counts.reduce((sum, n) => sum + n, 0);
    const winner = totalVotes > 0 ? winningOptionIndex(counts) : null;
    if (winner != null) {
      for (const vote of votes) {
        const key = pollParticipationIdempotencyKey(poll.id, vote.crmContactId);
        if (this.ledger.some((row) => row.idempotencyKey === key)) continue;
        this.ledger.push({
          id: randomUUID(),
          ownerCoadminUserId: poll.ownerCoadminUserId,
          crmContactId: vote.crmContactId,
          chicagoDate: poll.chicagoDate,
          kind: "POLL_PARTICIPATION",
          points: pollPointsForVote(vote.optionIndex, winner),
          pollId: poll.id,
          referralId: null,
          idempotencyKey: key,
          createdAt: now
        });
      }
    }
    poll.optionCounts = counts;
    poll.winningOptionIndex = winner;
    poll.closedAt = now;
    poll.settledAt = now;
    poll.status = "SETTLED";
  }

  private async declareDue(integration: (typeof this.integrations)[number], now: Date): Promise<void> {
    const chicagoDate = latestDeclarationChicagoDate(now);
    const declareAt = declarationInstantForChicagoDate(chicagoDate);
    if (now.getTime() < declareAt.getTime()) return;
    const pollDates = this.polls
      .filter((p) => p.ownerCoadminUserId === integration.ownerCoadminUserId)
      .map((p) => p.chicagoDate);
    if (!isEligibleEngagementDeclarationDate(chicagoDate, pollDates)) return;
    if (this.results.some((r) => r.ownerCoadminUserId === integration.ownerCoadminUserId && r.chicagoDate === chicagoDate)) {
      const existing = this.results.find(
        (r) => r.ownerCoadminUserId === integration.ownerCoadminUserId && r.chicagoDate === chicagoDate
      )!;
      await this.announce(existing, integration, now);
      return;
    }
    const referralRows = this.referrals.filter(
      (r) =>
        r.ownerCoadminUserId === integration.ownerCoadminUserId &&
        r.status === "ACTIVE" &&
        r.awardedAt.getTime() < declareAt.getTime()
    );
    for (const referral of referralRows) {
      const points = referralContributionAtDeclaration(referral.awardedAt, declareAt);
      if (points <= 0) continue;
      const key = referralContributionIdempotencyKey(integration.ownerCoadminUserId, chicagoDate, referral.id);
      if (this.ledger.some((row) => row.idempotencyKey === key)) continue;
      this.ledger.push({
        id: randomUUID(),
        ownerCoadminUserId: integration.ownerCoadminUserId,
        crmContactId: referral.referrerCrmContactId,
        chicagoDate,
        kind: "REFERRAL_CONTRIBUTION",
        points,
        pollId: null,
        referralId: referral.id,
        idempotencyKey: key,
        createdAt: now
      });
    }
    const totals = new Map<string, EngagementScoreTotal>();
    for (const row of this.ledger.filter(
      (l) => l.ownerCoadminUserId === integration.ownerCoadminUserId && l.chicagoDate === chicagoDate
    )) {
      const current = totals.get(row.crmContactId) ?? {
        crmContactId: row.crmContactId,
        totalPoints: 0,
        pollPoints: 0,
        referralPoints: 0,
        pointsReachedAt: row.createdAt
      };
      totals.set(row.crmContactId, {
        ...current,
        totalPoints: current.totalPoints + row.points,
        pollPoints: current.pollPoints + (row.kind === "POLL_PARTICIPATION" ? row.points : 0),
        referralPoints: current.referralPoints + (row.kind === "POLL_PARTICIPATION" ? 0 : row.points),
        pointsReachedAt:
          row.createdAt.getTime() >= current.pointsReachedAt.getTime()
            ? row.createdAt
            : current.pointsReachedAt
      });
    }
    const ranked = rankEngagementPlayers([...totals.values()]);
    const top = ranked.slice(0, 3);
    const result: MemoryDailyResult = {
      id: randomUUID(),
      ownerCoadminUserId: integration.ownerCoadminUserId,
      chicagoDate,
      declaredAt: now,
      status: "SNAPSHOTTED",
      firstCrmContactId: top[0]?.crmContactId ?? null,
      secondCrmContactId: top[1]?.crmContactId ?? null,
      thirdCrmContactId: top[2]?.crmContactId ?? null,
      snapshot: ranked.map((row, index) => ({
        rank: index + 1,
        crmContactId: row.crmContactId,
        totalPoints: row.totalPoints,
        pollPoints: row.pollPoints,
        referralPoints: row.referralPoints,
        pointsReachedAt: row.pointsReachedAt.toISOString()
      })),
      telegramMessageId: null,
      announcedAt: null
    };
    this.results.push(result);
    const winners = [result.firstCrmContactId, result.secondCrmContactId, result.thirdCrmContactId];
    winners.forEach((crmContactId, index) => {
      if (!crmContactId) return;
      const prizeRank = index + 1;
      const amountCents = DAILY_PRIZES_CENTS[index]!;
      this.grantEngagementClaim({
        ownerCoadminUserId: integration.ownerCoadminUserId,
        crmContactId,
        amountCents,
        idempotencyKey: freeplayGrantIdempotencyKey(integration.ownerCoadminUserId, chicagoDate, prizeRank)
      });
    });
    this.enqueue("ANNOUNCE_ENGAGEMENT_WINNERS", announceOutboxKey(integration.ownerCoadminUserId, chicagoDate), {
      dailyResultId: result.id
    });
    await this.announce(result, integration, now);
  }

  private async announce(
    result: MemoryDailyResult,
    integration: (typeof this.integrations)[number],
    now: Date
  ): Promise<void> {
    if (result.telegramMessageId) {
      result.status = "ANNOUNCED";
      return;
    }
    if (!this.client || !integration.channelId) return;
    const name = (id: string | null) => (id ? this.contacts.get(id)?.displayName ?? "Player" : null);
    const sent = await this.client.sendMessage(
      integration.botToken,
      integration.channelId,
      formatDailyWinnersMessage({
        firstName: name(result.firstCrmContactId),
        secondName: name(result.secondCrmContactId),
        thirdName: name(result.thirdCrmContactId)
      })
    );
    result.telegramMessageId = String(sent.messageId);
    result.announcedAt = now;
    result.status = "ANNOUNCED";
    this.completeOutbox(announceOutboxKey(integration.ownerCoadminUserId, result.chicagoDate));
  }

  private enqueue(jobType: string, idempotencyKey: string, payload: Record<string, unknown>): void {
    if (this.outbox.some((j) => j.idempotencyKey === idempotencyKey)) return;
    this.outbox.push({ jobType, idempotencyKey, payload, status: "QUEUED" });
  }

  private completeOutbox(idempotencyKey: string): void {
    const job = this.outbox.find((j) => j.idempotencyKey === idempotencyKey);
    if (job) job.status = "SUCCEEDED";
  }
}

export function missedOpenStillCloseable(now: Date, closesAt: Date): boolean {
  return now.getTime() - closesAt.getTime() < 7 * 24 * POLL_DURATION_MS;
}
