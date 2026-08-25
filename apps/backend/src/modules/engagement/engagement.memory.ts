import { randomUUID } from "node:crypto";
import {
  DAILY_DRAW_PRIZE_CENTS,
  DRAW_BASE_WEIGHT,
  DRAW_WINNER_COOLDOWN_DRAWS,
  POLL_DURATION_MS
} from "./engagement.constants";
import { selectNativePollMessagesToPrune } from "./engagement.poll-visibility";
import {
  EMPTY_INLINE_KEYBOARD,
  formatClosedPollMessage,
  formatDailyDrawCaption,
  parseVoteCallbackData
} from "./engagement.messages";
import {
  addChicagoDays,
  listSlotsInRange,
  latestDeclarationChicagoDate,
  declarationInstantForChicagoDate,
  isEligibleEngagementDeclarationDate
} from "./engagement.schedule";
import {
  closePollOutboxKey,
  postPollOutboxKey,
  countOptionVotes,
  parseStoredOptionCounts,
  nativeCountsFromPollOptions,
  winningOptionIndex
} from "./engagement.scoring";
import {
  candidateDrawWeight,
  dailyDrawAnnounceOutboxKey,
  dailyDrawFreeplayIdempotencyKey,
  dailyDrawOutboxKey,
  drawReferralWeightAtDeclaration,
  isDailyDrawEligibleChatMember,
  isInDailyDrawWinnerCooldown,
  selectWeightedDailyDrawCandidate,
  snapshotDailyDrawCandidates,
  type DailyDrawCandidate
} from "./engagement.draw";
import { renderDailyDrawWinnerCard } from "./engagement.draw-card";
import { shuffleIds, validateQuestionBank, type EngagementQuestionInput } from "./question-bank";
import {
  applyFakePollAnswer,
  type FakeLeaderboardTelegramState,
  type LeaderboardTelegramClient
} from "../leaderboard/telegram/leaderboard-telegram.client";
import { createCryptoWheelRng, type WheelRng } from "../leaderboard/wheel-rng";

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

export interface MemoryDailyDraw {
  id: string;
  ownerCoadminUserId: string;
  chicagoDate: string;
  status: "DRAWN" | "ANNOUNCED" | "NO_ELIGIBLE";
  winnerCrmContactId: string | null;
  winnerTelegramUserId: string | null;
  winnerBaseWeight: number | null;
  winnerReferralWeight: number | null;
  winnerTotalWeight: number | null;
  winnerActiveReferralCount: number | null;
  candidateCount: number;
  totalWeight: number;
  randomPick: number | null;
  snapshot: unknown;
  freeplayClaimId: string | null;
  telegramMessageId: string | null;
  drawnAt: Date;
  announcedAt: Date | null;
}

export interface MemoryFreeplayClaim {
  id: string;
  ownerCoadminUserId: string;
  crmContactId: string;
  spinId: string | null;
  source: "WHEEL" | "ENGAGEMENT_DAILY" | "ENGAGEMENT_DAILY_DRAW";
  idempotencyKey: string;
  rewardAmountCents: number;
}

type ChannelClient = Pick<LeaderboardTelegramClient, "sendMessage" | "editMessageText"> & {
  sendPoll?: LeaderboardTelegramClient["sendPoll"];
  stopPoll?: LeaderboardTelegramClient["stopPoll"];
  deleteMessage?: LeaderboardTelegramClient["deleteMessage"];
  getChatMember?: LeaderboardTelegramClient["getChatMember"];
  sendPhoto?: LeaderboardTelegramClient["sendPhoto"];
};

export class MemoryEngagementRuntime {
  public readonly questions: MemoryQuestion[] = [];
  public readonly polls: MemoryPoll[] = [];
  public readonly votes: VoteRow[] = [];
  public readonly ledger: LedgerRow[] = [];
  public readonly results: MemoryDailyResult[] = [];
  public readonly draws: MemoryDailyDraw[] = [];
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
    private readonly telegramState?: FakeLeaderboardTelegramState,
    private readonly rng: WheelRng = createCryptoWheelRng()
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
        await this.drawDue(integration, now);
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
    source?: "ENGAGEMENT_DAILY" | "ENGAGEMENT_DAILY_DRAW";
  }): { claimId: string; replay: boolean } {
    const existing = this.claims.find((c) => c.idempotencyKey === input.idempotencyKey);
    if (existing) return { claimId: existing.id, replay: true };
    const row: MemoryFreeplayClaim = {
      id: randomUUID(),
      ownerCoadminUserId: input.ownerCoadminUserId,
      crmContactId: input.crmContactId,
      spinId: null,
      source: input.source ?? "ENGAGEMENT_DAILY",
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
          if (!this.client.sendPoll) {
            throw new Error("sendPoll is required for engagement channel polls");
          }
          const sent = await this.client.sendPoll(integration.botToken, integration.channelId, {
            question: poll.questionText,
            options: [poll.option1, poll.option2!, poll.option3!, poll.option4!],
            isAnonymous: true,
            type: "regular",
            allowsMultipleAnswers: false,
            allowsRevoting: false
          });
          poll.telegramMessageId = String(sent.messageId);
          poll.telegramPollId = sent.poll?.id ?? null;
        }
        poll.status = "OPEN";
        poll.postedAt = now;
        this.completeOutbox(postPollOutboxKey(poll.id));
        await this.pruneExcessVisibleNativePollMessages(integration);
      }
    }
  }

  private async pruneExcessVisibleNativePollMessages(
    integration: (typeof this.integrations)[number]
  ): Promise<void> {
    if (!integration.channelId || !this.client?.deleteMessage) return;
    const visible = this.polls.filter(
      (p) =>
        p.ownerCoadminUserId === integration.ownerCoadminUserId &&
        p.channelId === integration.channelId &&
        Boolean(p.telegramPollId) &&
        Boolean(p.telegramMessageId)
    );
    const candidates = visible.flatMap((p) => {
      if (!p.channelId || !p.telegramMessageId || !p.telegramPollId) return [];
      return [
        {
          id: p.id,
          channelId: p.channelId,
          telegramMessageId: p.telegramMessageId,
          telegramPollId: p.telegramPollId,
          postedAt: p.postedAt
        }
      ];
    });
    const toPrune = selectNativePollMessagesToPrune(candidates);
    for (const old of toPrune) {
      const poll = this.polls.find((p) => p.id === old.id);
      if (!poll || poll.telegramMessageId !== old.telegramMessageId) continue;
      try {
        await this.client.deleteMessage(
          integration.botToken,
          old.channelId,
          Number(old.telegramMessageId)
        );
      } catch {
        // Missing/already-deleted Telegram messages must not block posting.
      }
      if (
        poll.telegramMessageId === old.telegramMessageId &&
        poll.telegramPollId === old.telegramPollId &&
        poll.channelId === old.channelId
      ) {
        poll.telegramMessageId = null;
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
    poll.optionCounts = counts;
    poll.winningOptionIndex = winner;
    poll.closedAt = now;
    poll.settledAt = now;
    poll.status = "SETTLED";
  }

  private async drawDue(integration: (typeof this.integrations)[number], now: Date): Promise<void> {
    const chicagoDate = latestDeclarationChicagoDate(now);
    const declareAt = declarationInstantForChicagoDate(chicagoDate);
    if (now.getTime() < declareAt.getTime()) return;
    const pollDates = this.polls
      .filter((p) => p.ownerCoadminUserId === integration.ownerCoadminUserId)
      .map((p) => p.chicagoDate);
    if (!isEligibleEngagementDeclarationDate(chicagoDate, pollDates)) return;
    const existing = this.draws.find(
      (row) => row.ownerCoadminUserId === integration.ownerCoadminUserId && row.chicagoDate === chicagoDate
    );
    if (existing) {
      await this.announceDraw(existing, integration, now);
      return;
    }
    this.enqueue("RUN_ENGAGEMENT_DAILY_DRAW", dailyDrawOutboxKey(integration.ownerCoadminUserId, chicagoDate), {
      chicagoDate
    });
    const candidates = await this.loadDrawCandidates(integration, chicagoDate, declareAt);
    const snapshot = snapshotDailyDrawCandidates(candidates);
    const totalWeight = candidates.reduce((sum, row) => sum + row.totalWeight, 0);
    if (candidates.length === 0 || totalWeight <= 0) {
      this.draws.push({
        id: randomUUID(),
        ownerCoadminUserId: integration.ownerCoadminUserId,
        chicagoDate,
        status: "NO_ELIGIBLE",
        winnerCrmContactId: null,
        winnerTelegramUserId: null,
        winnerBaseWeight: null,
        winnerReferralWeight: null,
        winnerTotalWeight: null,
        winnerActiveReferralCount: null,
        candidateCount: 0,
        totalWeight: 0,
        randomPick: null,
        snapshot,
        freeplayClaimId: null,
        telegramMessageId: null,
        drawnAt: now,
        announcedAt: null
      });
      this.completeOutbox(dailyDrawOutboxKey(integration.ownerCoadminUserId, chicagoDate));
      return;
    }
    const picked = selectWeightedDailyDrawCandidate(candidates, this.rng);
    const winner = picked.selected;
    const granted = this.grantEngagementClaim({
      ownerCoadminUserId: integration.ownerCoadminUserId,
      crmContactId: winner.crmContactId,
      amountCents: DAILY_DRAW_PRIZE_CENTS,
      idempotencyKey: dailyDrawFreeplayIdempotencyKey(integration.ownerCoadminUserId, chicagoDate),
      source: "ENGAGEMENT_DAILY_DRAW"
    });
    const draw: MemoryDailyDraw = {
      id: randomUUID(),
      ownerCoadminUserId: integration.ownerCoadminUserId,
      chicagoDate,
      status: "DRAWN",
      winnerCrmContactId: winner.crmContactId,
      winnerTelegramUserId: winner.telegramUserId,
      winnerBaseWeight: winner.baseWeight,
      winnerReferralWeight: winner.referralWeight,
      winnerTotalWeight: winner.totalWeight,
      winnerActiveReferralCount: winner.activeReferralCount,
      candidateCount: candidates.length,
      totalWeight: picked.totalWeight,
      randomPick: picked.pick,
      snapshot,
      freeplayClaimId: granted.claimId,
      telegramMessageId: null,
      drawnAt: now,
      announcedAt: null
    };
    this.draws.push(draw);
    this.completeOutbox(dailyDrawOutboxKey(integration.ownerCoadminUserId, chicagoDate));
    this.enqueue(
      "ANNOUNCE_ENGAGEMENT_DAILY_DRAW",
      dailyDrawAnnounceOutboxKey(integration.ownerCoadminUserId, chicagoDate),
      { drawId: draw.id, chicagoDate }
    );
    await this.announceDraw(draw, integration, now);
  }

  private async loadDrawCandidates(
    integration: (typeof this.integrations)[number],
    chicagoDate: string,
    declareAt: Date
  ): Promise<DailyDrawCandidate[]> {
    if (!integration.channelId || !this.client?.getChatMember) return [];
    const getChatMember = this.client.getChatMember;
    const cooldownStart = addChicagoDays(chicagoDate, -DRAW_WINNER_COOLDOWN_DRAWS);
    const recentWins = this.draws.filter(
      (row) =>
        row.ownerCoadminUserId === integration.ownerCoadminUserId &&
        row.winnerCrmContactId &&
        row.chicagoDate >= cooldownStart &&
        row.chicagoDate < chicagoDate
    );
    const winsByContact = new Map<string, string[]>();
    for (const row of recentWins) {
      if (!row.winnerCrmContactId) continue;
      const list = winsByContact.get(row.winnerCrmContactId) ?? [];
      list.push(row.chicagoDate);
      winsByContact.set(row.winnerCrmContactId, list);
    }
    const referralWeightByContact = new Map<string, { weight: number; activeCount: number }>();
    for (const referral of this.referrals) {
      if (referral.ownerCoadminUserId !== integration.ownerCoadminUserId || referral.status !== "ACTIVE") continue;
      if (referral.awardedAt.getTime() >= declareAt.getTime()) continue;
      const weight = drawReferralWeightAtDeclaration(referral.awardedAt, declareAt);
      const current = referralWeightByContact.get(referral.referrerCrmContactId) ?? { weight: 0, activeCount: 0 };
      referralWeightByContact.set(referral.referrerCrmContactId, {
        weight: current.weight + weight,
        activeCount: current.activeCount + (weight > 0 ? 1 : 0)
      });
    }
    const candidates: DailyDrawCandidate[] = [];
    for (const link of this.playerLinks) {
      if (link.botIntegrationId !== integration.id || link.ownerCoadminUserId !== integration.ownerCoadminUserId) {
        continue;
      }
      if (isInDailyDrawWinnerCooldown(winsByContact.get(link.crmContactId) ?? [], chicagoDate)) continue;
      let member;
      try {
        member = await getChatMember(integration.botToken, integration.channelId, link.telegramUserId);
      } catch {
        continue;
      }
      if (!isDailyDrawEligibleChatMember(member)) continue;
      const referral = referralWeightByContact.get(link.crmContactId) ?? { weight: 0, activeCount: 0 };
      candidates.push({
        crmContactId: link.crmContactId,
        telegramUserId: link.telegramUserId,
        displayName: this.contacts.get(link.crmContactId)?.displayName ?? "Player",
        baseWeight: DRAW_BASE_WEIGHT,
        referralWeight: referral.weight,
        totalWeight: candidateDrawWeight(referral.weight),
        activeReferralCount: referral.activeCount
      });
    }
    return candidates;
  }

  private async announceDraw(
    draw: MemoryDailyDraw,
    integration: (typeof this.integrations)[number],
    now: Date
  ): Promise<void> {
    if (draw.telegramMessageId) {
      draw.status = "ANNOUNCED";
      return;
    }
    if (!draw.winnerCrmContactId || !this.client?.sendPhoto || !integration.channelId) return;
    const displayName = this.contacts.get(draw.winnerCrmContactId)?.displayName ?? "Player";
    const photo = await renderDailyDrawWinnerCard({
      displayName,
      activeReferralCount: draw.winnerActiveReferralCount ?? 0,
      referralWeight: draw.winnerReferralWeight ?? 0
    });
    const sent = await this.client.sendPhoto(integration.botToken, integration.channelId, photo, {
      caption: formatDailyDrawCaption({
        displayName,
        referralWeight: draw.winnerReferralWeight ?? 0,
        activeReferralCount: draw.winnerActiveReferralCount ?? 0
      }),
      filename: "daily-freeplay-winner.png"
    });
    draw.telegramMessageId = String(sent.messageId);
    draw.announcedAt = now;
    draw.status = "ANNOUNCED";
    this.completeOutbox(dailyDrawAnnounceOutboxKey(integration.ownerCoadminUserId, draw.chicagoDate));
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
