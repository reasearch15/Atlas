import { Prisma, type PrismaClient } from "@prisma/client";
import { FreeplayService } from "../freeplay/freeplay.service";
import type { LeaderboardTelegramOutboxService } from "../leaderboard/telegram/leaderboard-telegram.outbox";
import { DAILY_DRAW_PRIZE_CENTS, DRAW_BASE_WEIGHT, DRAW_WINNER_COOLDOWN_DRAWS } from "./engagement.constants";
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
  parseVoteCallbackData,
  formatClosedPollMessage,
  formatDailyDrawCaption,
  EMPTY_INLINE_KEYBOARD
} from "./engagement.messages";
import {
  LeaderboardTelegramApiError,
  type LeaderboardTelegramClient
} from "../leaderboard/telegram/leaderboard-telegram.client";
import { createCryptoWheelRng, type WheelRng } from "../leaderboard/wheel-rng";

export type EngagementVoteStatus =
  | "recorded"
  | "already_voted"
  | "updated"
  | "withdrawn"
  | "unregistered"
  | "closed"
  | "not_found"
  | "invalid";

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export class EngagementService {
  public constructor(
    private readonly prisma: PrismaClient,
    private readonly outbox?: LeaderboardTelegramOutboxService,
    private readonly freeplay?: FreeplayService,
    private readonly rng: WheelRng = createCryptoWheelRng()
  ) {}

  public async importQuestionBank(rows: readonly EngagementQuestionInput[]): Promise<{ upserted: number }> {
    const validated = validateQuestionBank(rows);
    for (const row of validated) {
      await this.prisma.engagementQuestion.upsert({
        where: { externalId: row.externalId },
        update: {
          category: row.category,
          question: row.question,
          option1: row.option1,
          option2: row.option2,
          option3: row.option3,
          option4: row.option4,
          active: row.active
        },
        create: row
      });
    }
    return { upserted: validated.length };
  }

  public async sweep(now = new Date()): Promise<void> {
    const integrations = await this.prisma.leaderboardBotIntegration.findMany({
      where: { disconnectedAt: null, postingEnabled: true, channelId: { not: null } }
    });
    for (const integration of integrations) {
      await this.ensureSlots(integration, now);
      await this.enqueueDuePosts(integration, now);
      await this.closeDuePolls(integration, now);
      await this.enqueueDueDailyDraw(integration, now);
    }
  }

  public async voteFromCallback(input: {
    readonly botIntegrationId: string;
    readonly ownerCoadminUserId: string;
    readonly workspaceId: string;
    readonly telegramUserId: string;
    readonly data: string;
    readonly now?: Date;
  }): Promise<EngagementVoteStatus> {
    const parsed = parseVoteCallbackData(input.data);
    if (!parsed) return "invalid";
    const now = input.now ?? new Date();
    try {
      return await this.prisma.$transaction((tx) =>
        this.voteTx(tx, {
          pollId: parsed.pollId,
          botIntegrationId: input.botIntegrationId,
          ownerCoadminUserId: input.ownerCoadminUserId,
          workspaceId: input.workspaceId,
          telegramUserId: input.telegramUserId,
          optionIndex: parsed.optionIndex,
          now
        })
      );
    } catch (error) {
      if (isUniqueViolation(error)) return "already_voted";
      throw error;
    }
  }

  public async voteFromPollAnswer(input: {
    readonly botIntegrationId: string;
    readonly ownerCoadminUserId: string;
    readonly workspaceId: string;
    readonly telegramUserId: string;
    readonly telegramPollId: string;
    readonly optionIds: readonly number[];
    readonly now?: Date;
  }): Promise<EngagementVoteStatus> {
    const now = input.now ?? new Date();
    try {
      return await this.prisma.$transaction((tx) =>
        this.pollAnswerTx(tx, {
          botIntegrationId: input.botIntegrationId,
          ownerCoadminUserId: input.ownerCoadminUserId,
          workspaceId: input.workspaceId,
          telegramUserId: input.telegramUserId,
          telegramPollId: input.telegramPollId,
          optionIds: input.optionIds,
          now
        })
      );
    } catch (error) {
      if (isUniqueViolation(error)) return "already_voted";
      throw error;
    }
  }

  public async persistNativePollCounts(input: {
    readonly telegramPollId: string;
    readonly options: readonly { readonly voterCount: number }[];
    readonly isClosed: boolean;
  }): Promise<void> {
    if (!input.isClosed) return;
    const counts = nativeCountsFromPollOptions(input.options);
    if (!counts) return;
    await this.prisma.engagementPoll.updateMany({
      where: { telegramPollId: input.telegramPollId, closeEditedAt: null },
      data: { optionCountsJson: counts }
    });
  }

  public async completePost(
    pollId: string,
    client: LeaderboardTelegramClient,
    token: string
  ): Promise<void> {
    const poll = await this.prisma.engagementPoll.findUnique({ where: { id: pollId } });
    if (!poll) return;
    if (poll.telegramMessageId) {
      if (poll.status === "POSTING") {
        await this.prisma.engagementPoll.updateMany({
          where: { id: pollId, status: "POSTING" },
          data: { status: "OPEN", postedAt: poll.postedAt ?? new Date() }
        });
      }
      return;
    }
    if (!poll.channelId || !poll.questionText || !poll.option1 || !client.sendPoll) return;
    const sent = await client.sendPoll(token, poll.channelId, {
      question: poll.questionText,
      options: [poll.option1, poll.option2!, poll.option3!, poll.option4!],
      isAnonymous: true,
      type: "regular",
      allowsMultipleAnswers: false,
      allowsRevoting: false
    });
    const telegramPollId = sent.poll?.id;
    if (!telegramPollId) {
      throw new Error("Telegram sendPoll did not return a native poll id");
    }
    await this.prisma.engagementPoll.updateMany({
      where: { id: pollId, telegramMessageId: null },
      data: {
        telegramMessageId: String(sent.messageId),
        telegramPollId,
        status: "OPEN",
        postedAt: new Date()
      }
    });
  }

  public async completeClose(
    pollId: string,
    client: LeaderboardTelegramClient,
    token: string
  ): Promise<void> {
    const poll = await this.prisma.engagementPoll.findUnique({ where: { id: pollId } });
    if (!poll?.telegramMessageId || !poll.channelId || !poll.questionText) return;

    if (poll.telegramPollId) {
      await this.completeNativeClose(poll, client, token);
      return;
    }

    if (poll.closeEditedAt) return;
    const votes = await this.prisma.engagementVote.findMany({
      where: { pollId },
      select: { optionIndex: true }
    });
    const counts = countOptionVotes(votes.map((vote) => vote.optionIndex));
    const options = [poll.option1!, poll.option2!, poll.option3!, poll.option4!] as [
      string,
      string,
      string,
      string
    ];
    await client.editMessageText(
      token,
      poll.channelId,
      Number(poll.telegramMessageId),
      formatClosedPollMessage({
        question: poll.questionText,
        options,
        counts
      }),
      undefined,
      EMPTY_INLINE_KEYBOARD
    );
    await this.prisma.engagementPoll.updateMany({
      where: { id: pollId, closeEditedAt: null },
      data: { closeEditedAt: new Date() }
    });
  }

  private async completeNativeClose(
    poll: {
      id: string;
      channelId: string | null;
      telegramMessageId: string | null;
      telegramPollId: string | null;
      closeEditedAt: Date | null;
      status: string;
      optionCountsJson: unknown;
    },
    client: LeaderboardTelegramClient,
    token: string
  ): Promise<void> {
    if (!poll.channelId || !poll.telegramMessageId) return;
    if (!client.stopPoll) {
      throw new Error("Telegram client does not support stopPoll");
    }
    let counts = parseStoredOptionCounts(poll.optionCountsJson);
    if (!poll.closeEditedAt) {
      try {
        const stopped = await client.stopPoll(token, poll.channelId, Number(poll.telegramMessageId));
        counts = nativeCountsFromPollOptions(stopped.options) ?? counts;
      } catch (error) {
        if (!isPollAlreadyClosedError(error)) throw error;
      }
      if (counts) {
        await this.prisma.engagementPoll.updateMany({
          where: { id: poll.id, closeEditedAt: null },
          data: { optionCountsJson: counts }
        });
      }
    }
    const latest = await this.prisma.engagementPoll.findUnique({ where: { id: poll.id } });
    if (latest && latest.status !== "SETTLED") {
      await this.prisma.$transaction((tx) => this.settleTx(tx, poll.id, new Date()));
    }
    await this.prisma.engagementPoll.updateMany({
      where: { id: poll.id, closeEditedAt: null },
      data: { closeEditedAt: new Date() }
    });
  }

  public async completeAnnounce(
    _dailyResultId: string,
    _client: LeaderboardTelegramClient,
    _token: string
  ): Promise<void> {
    // Old poll-ranking Top 3 $5/$2/$1 declaration stays disabled.
  }

  public async completeDailyDraw(input: {
    readonly ownerCoadminUserId: string;
    readonly chicagoDate: string;
    readonly client: LeaderboardTelegramClient;
    readonly token: string;
    readonly now?: Date;
  }): Promise<void> {
    const now = input.now ?? new Date();
    const declareAt = declarationInstantForChicagoDate(input.chicagoDate);
    if (now.getTime() < declareAt.getTime()) return;
    const integration = await this.prisma.leaderboardBotIntegration.findUnique({
      where: { ownerCoadminUserId: input.ownerCoadminUserId }
    });
    if (!integration || integration.disconnectedAt || !integration.channelId || !integration.postingEnabled) {
      return;
    }
    const earliestPoll = await this.prisma.engagementPoll.findFirst({
      where: { ownerCoadminUserId: integration.ownerCoadminUserId },
      orderBy: { chicagoDate: "asc" },
      select: { chicagoDate: true }
    });
    if (!isEligibleEngagementDeclarationDate(input.chicagoDate, earliestPoll ? [earliestPoll.chicagoDate] : [])) {
      return;
    }
    const existing = await this.prisma.engagementDailyDraw.findUnique({
      where: {
        ownerCoadminUserId_chicagoDate: {
          ownerCoadminUserId: integration.ownerCoadminUserId,
          chicagoDate: input.chicagoDate
        }
      }
    });
    if (existing) {
      await this.ensureDailyDrawClaimAndAnnounce(existing.id, integration, now);
      return;
    }
    const candidates = await this.loadDailyDrawCandidates(integration, input.client, input.token, input.chicagoDate, declareAt);
    const snapshot = snapshotDailyDrawCandidates(candidates);
    const totalWeight = candidates.reduce((sum, row) => sum + row.totalWeight, 0);
    if (candidates.length === 0 || totalWeight <= 0) {
      try {
        await this.prisma.engagementDailyDraw.create({
          data: {
            workspaceId: integration.workspaceId,
            ownerCoadminUserId: integration.ownerCoadminUserId,
            botIntegrationId: integration.id,
            chicagoDate: input.chicagoDate,
            status: "NO_ELIGIBLE",
            candidateCount: 0,
            totalWeight: 0,
            snapshotJson: snapshot as unknown as Prisma.InputJsonValue,
            channelId: integration.channelId,
            drawnAt: now
          }
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
      return;
    }
    const picked = selectWeightedDailyDrawCandidate(candidates, this.rng);
    const winner = picked.selected;
    const grants = this.freeplay ?? new FreeplayService({ prisma: this.prisma });
    let drawId: string | null = null;
    try {
      drawId = await this.prisma.$transaction(async (tx) => {
        const created = await tx.engagementDailyDraw.create({
          data: {
            workspaceId: integration.workspaceId,
            ownerCoadminUserId: integration.ownerCoadminUserId,
            botIntegrationId: integration.id,
            chicagoDate: input.chicagoDate,
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
            snapshotJson: snapshot as unknown as Prisma.InputJsonValue,
            channelId: integration.channelId,
            drawnAt: now
          }
        });
        const granted = await grants.grantEngagementClaim({
          workspaceId: integration.workspaceId,
          ownerCoadminUserId: integration.ownerCoadminUserId,
          crmContactId: winner.crmContactId,
          amountCents: DAILY_DRAW_PRIZE_CENTS,
          idempotencyKey: dailyDrawFreeplayIdempotencyKey(integration.ownerCoadminUserId, input.chicagoDate),
          source: "ENGAGEMENT_DAILY_DRAW",
          tx
        });
        await tx.engagementDailyDraw.update({
          where: { id: created.id },
          data: { freeplayClaimId: granted.claimId }
        });
        return created.id;
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.prisma.engagementDailyDraw.findUnique({
        where: {
          ownerCoadminUserId_chicagoDate: {
            ownerCoadminUserId: integration.ownerCoadminUserId,
            chicagoDate: input.chicagoDate
          }
        }
      });
      drawId = raced?.id ?? null;
    }
    if (!drawId) return;
    await this.ensureDailyDrawClaimAndAnnounce(drawId, integration, now);
  }

  public async completeDailyDrawAnnounce(
    drawId: string,
    client: LeaderboardTelegramClient,
    token: string
  ): Promise<void> {
    const draw = await this.prisma.engagementDailyDraw.findUnique({
      where: { id: drawId },
      include: { winnerContact: true }
    });
    if (!draw || draw.telegramMessageId || !draw.channelId || !draw.winnerCrmContactId) {
      if (draw?.telegramMessageId && draw.status === "DRAWN") {
        await this.prisma.engagementDailyDraw.updateMany({
          where: { id: drawId, status: "DRAWN" },
          data: { status: "ANNOUNCED", announcedAt: draw.announcedAt ?? new Date() }
        });
      }
      return;
    }
    if (!draw.freeplayClaimId) {
      const grants = this.freeplay ?? new FreeplayService({ prisma: this.prisma });
      const granted = await grants.grantEngagementClaim({
        workspaceId: draw.workspaceId,
        ownerCoadminUserId: draw.ownerCoadminUserId,
        crmContactId: draw.winnerCrmContactId,
        amountCents: DAILY_DRAW_PRIZE_CENTS,
        idempotencyKey: dailyDrawFreeplayIdempotencyKey(draw.ownerCoadminUserId, draw.chicagoDate),
        source: "ENGAGEMENT_DAILY_DRAW"
      });
      await this.prisma.engagementDailyDraw.update({
        where: { id: draw.id },
        data: { freeplayClaimId: granted.claimId }
      });
    }
    const displayName = draw.winnerContact?.displayName?.trim() || "Player";
    const photo = await renderDailyDrawWinnerCard({
      displayName,
      activeReferralCount: draw.winnerActiveReferralCount ?? 0,
      referralWeight: draw.winnerReferralWeight ?? 0
    });
    const sent = await client.sendPhoto(token, draw.channelId, photo, {
      caption: formatDailyDrawCaption({
        displayName,
        referralWeight: draw.winnerReferralWeight ?? 0,
        activeReferralCount: draw.winnerActiveReferralCount ?? 0
      }),
      filename: "daily-freeplay-winner.png"
    });
    await this.prisma.engagementDailyDraw.update({
      where: { id: drawId },
      data: { telegramMessageId: String(sent.messageId) }
    });
    await this.prisma.engagementDailyDraw.updateMany({
      where: { id: drawId, status: "DRAWN" },
      data: { status: "ANNOUNCED", announcedAt: new Date() }
    });
  }

  private async voteTx(
    tx: Prisma.TransactionClient,
    input: {
      pollId: string;
      botIntegrationId: string;
      ownerCoadminUserId: string;
      workspaceId: string;
      telegramUserId: string;
      optionIndex: number;
      now: Date;
    }
  ): Promise<EngagementVoteStatus> {
    const locked = await tx.$queryRaw<
      Array<{
        id: string;
        status: string;
        closesAt: Date;
        botIntegrationId: string;
      }>
    >`
      SELECT id, status, closes_at AS "closesAt", bot_integration_id AS "botIntegrationId"
      FROM engagement_polls
      WHERE id = ${input.pollId}::uuid
      FOR UPDATE
    `;
    const poll = locked[0];
    if (!poll || poll.botIntegrationId !== input.botIntegrationId) return "not_found";
    if (poll.status !== "OPEN" || input.now.getTime() >= poll.closesAt.getTime()) return "closed";
    const link = await tx.leaderboardBotPlayerLink.findUnique({
      where: {
        botIntegrationId_telegramUserId: {
          botIntegrationId: input.botIntegrationId,
          telegramUserId: input.telegramUserId
        }
      }
    });
    if (!link || link.ownerCoadminUserId !== input.ownerCoadminUserId) return "unregistered";
    await tx.engagementVote.create({
      data: {
        pollId: poll.id,
        workspaceId: input.workspaceId,
        ownerCoadminUserId: input.ownerCoadminUserId,
        telegramUserId: input.telegramUserId,
        crmContactId: link.crmContactId,
        optionIndex: input.optionIndex,
        votedAt: input.now
      }
    });
    return "recorded";
  }

  private async pollAnswerTx(
    tx: Prisma.TransactionClient,
    input: {
      botIntegrationId: string;
      ownerCoadminUserId: string;
      workspaceId: string;
      telegramUserId: string;
      telegramPollId: string;
      optionIds: readonly number[];
      now: Date;
    }
  ): Promise<EngagementVoteStatus> {
    const locked = await tx.$queryRaw<
      Array<{
        id: string;
        status: string;
        closesAt: Date;
        botIntegrationId: string;
      }>
    >`
      SELECT id, status, closes_at AS "closesAt", bot_integration_id AS "botIntegrationId"
      FROM engagement_polls
      WHERE telegram_poll_id = ${input.telegramPollId}
      FOR UPDATE
    `;
    const poll = locked[0];
    if (!poll || poll.botIntegrationId !== input.botIntegrationId) return "not_found";
    if (poll.status !== "OPEN" || input.now.getTime() >= poll.closesAt.getTime()) return "closed";

    const existing = await tx.engagementVote.findUnique({
      where: {
        pollId_telegramUserId: {
          pollId: poll.id,
          telegramUserId: input.telegramUserId
        }
      }
    });

    if (input.optionIds.length === 0) {
      if (existing) {
        await tx.engagementVote.delete({ where: { id: existing.id } });
      }
      return "withdrawn";
    }

    const optionIndex = input.optionIds[0];
    if (optionIndex == null || optionIndex < 0 || optionIndex > 3) return "invalid";

    const link = await tx.leaderboardBotPlayerLink.findUnique({
      where: {
        botIntegrationId_telegramUserId: {
          botIntegrationId: input.botIntegrationId,
          telegramUserId: input.telegramUserId
        }
      }
    });
    if (!link || link.ownerCoadminUserId !== input.ownerCoadminUserId) return "unregistered";

    if (existing) {
      if (existing.optionIndex === optionIndex) return "recorded";
      await tx.engagementVote.update({
        where: { id: existing.id },
        data: { optionIndex, votedAt: input.now }
      });
      return "updated";
    }

    await tx.engagementVote.create({
      data: {
        pollId: poll.id,
        workspaceId: input.workspaceId,
        ownerCoadminUserId: input.ownerCoadminUserId,
        telegramUserId: input.telegramUserId,
        crmContactId: link.crmContactId,
        optionIndex,
        votedAt: input.now
      }
    });
    return "recorded";
  }

  private async ensureSlots(
    integration: {
      id: string;
      workspaceId: string;
      ownerCoadminUserId: string;
      channelId: string | null;
    },
    now: Date
  ): Promise<void> {
    const slots = listSlotsInRange(new Date(now.getTime() - 36 * 3600_000), new Date(now.getTime() + 36 * 3600_000));
    for (const slot of slots) {
      if (slot.closesAt.getTime() <= now.getTime()) continue;
      try {
        await this.prisma.engagementPoll.create({
          data: {
            workspaceId: integration.workspaceId,
            ownerCoadminUserId: integration.ownerCoadminUserId,
            botIntegrationId: integration.id,
            slotKey: slot.slotKey,
            opensAt: slot.opensAt,
            closesAt: slot.closesAt,
            chicagoDate: slot.chicagoDate,
            status: "SCHEDULED",
            channelId: integration.channelId
          }
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
  }

  private async enqueueDuePosts(
    integration: { id: string; workspaceId: string; ownerCoadminUserId: string },
    now: Date
  ): Promise<void> {
    const due = await this.prisma.engagementPoll.findMany({
      where: {
        botIntegrationId: integration.id,
        status: { in: ["SCHEDULED", "POSTING"] },
        opensAt: { lte: now },
        closesAt: { gt: now }
      }
    });
    for (const poll of due) {
      if (poll.status === "SCHEDULED") {
        const claimed = await this.prisma.$transaction((tx) => this.claimPostTx(tx, poll.id, now));
        if (!claimed) continue;
      }
      if (!this.outbox) continue;
      await this.outbox.enqueueEngagementJob({
        workspaceId: integration.workspaceId,
        ownerCoadminUserId: integration.ownerCoadminUserId,
        jobType: "POST_ENGAGEMENT_POLL",
        idempotencyKey: postPollOutboxKey(poll.id),
        payloadJson: { pollId: poll.id }
      });
    }
  }

  private async claimPostTx(tx: Prisma.TransactionClient, pollId: string, now: Date): Promise<boolean> {
    const claimed = await tx.engagementPoll.updateMany({
      where: { id: pollId, status: "SCHEDULED" },
      data: { status: "POSTING" }
    });
    if (claimed.count !== 1) return false;
    const poll = await tx.engagementPoll.findUnique({ where: { id: pollId } });
    if (!poll) return false;
    const drawn = await this.drawNextQuestionTx(tx, poll.ownerCoadminUserId, poll.workspaceId, now);
    await tx.engagementPoll.update({
      where: { id: pollId },
      data: {
        questionId: drawn.question.id,
        cycleId: drawn.cycleId,
        questionText: drawn.question.question,
        option1: drawn.question.option1,
        option2: drawn.question.option2,
        option3: drawn.question.option3,
        option4: drawn.question.option4,
        category: drawn.question.category
      }
    });
    return true;
  }

  private async drawNextQuestionTx(
    tx: Prisma.TransactionClient,
    ownerCoadminUserId: string,
    workspaceId: string,
    now: Date
  ): Promise<{
    cycleId: string;
    question: {
      id: string;
      question: string;
      option1: string;
      option2: string;
      option3: string;
      option4: string;
      category: string;
    };
  }> {
    const active = await tx.engagementQuestion.findMany({ where: { active: true } });
    if (active.length === 0) throw new Error("No active engagement questions imported");
    let cycle = await this.ensureOpenCycleTx(tx, ownerCoadminUserId, workspaceId, now, active);
    const item = await tx.$queryRaw<Array<{ id: string; questionId: string; cycleId: string }>>`
      SELECT id, question_id AS "questionId", cycle_id AS "cycleId"
      FROM engagement_question_cycle_items
      WHERE cycle_id = ${cycle.id}::uuid AND used_at IS NULL
      ORDER BY draw_order ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `;
    let chosen = item[0];
    if (!chosen) {
      const unused = await tx.engagementQuestionCycleItem.count({
        where: { cycleId: cycle.id, usedAt: null }
      });
      if (unused > 0) {
        throw new Error("Engagement question draw contended");
      }
      await tx.engagementQuestionCycle.updateMany({
        where: { id: cycle.id, exhaustedAt: null },
        data: { exhaustedAt: now }
      });
      cycle = await this.ensureOpenCycleTx(tx, ownerCoadminUserId, workspaceId, now, active);
      const next = await tx.$queryRaw<Array<{ id: string; questionId: string; cycleId: string }>>`
        SELECT id, question_id AS "questionId", cycle_id AS "cycleId"
        FROM engagement_question_cycle_items
        WHERE cycle_id = ${cycle.id}::uuid AND used_at IS NULL
        ORDER BY draw_order ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `;
      chosen = next[0];
    }
    if (!chosen) throw new Error("Failed to draw an engagement question");
    const marked = await tx.engagementQuestionCycleItem.updateMany({
      where: { id: chosen.id, usedAt: null },
      data: { usedAt: now }
    });
    if (marked.count !== 1) throw new Error("Engagement question already drawn");
    const remaining = await tx.engagementQuestionCycleItem.count({
      where: { cycleId: chosen.cycleId, usedAt: null }
    });
    if (remaining === 0) {
      await tx.engagementQuestionCycle.update({
        where: { id: chosen.cycleId },
        data: { exhaustedAt: now }
      });
    }
    const question = active.find((q) => q.id === chosen.questionId);
    if (!question) throw new Error("Drawn engagement question is missing");
    return { cycleId: chosen.cycleId, question };
  }

  private async ensureOpenCycleTx(
    tx: Prisma.TransactionClient,
    ownerCoadminUserId: string,
    workspaceId: string,
    now: Date,
    active: Array<{ id: string }>
  ) {
    const open = await tx.engagementQuestionCycle.findFirst({
      where: { ownerCoadminUserId, exhaustedAt: null },
      orderBy: { cycleNumber: "desc" }
    });
    if (open) return open;
    try {
      return await this.createCycleTx(tx, ownerCoadminUserId, workspaceId, now, active);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await tx.engagementQuestionCycle.findFirst({
        where: { ownerCoadminUserId, exhaustedAt: null },
        orderBy: { cycleNumber: "desc" }
      });
      if (!raced) throw error;
      return raced;
    }
  }

  private async createCycleTx(
    tx: Prisma.TransactionClient,
    ownerCoadminUserId: string,
    workspaceId: string,
    now: Date,
    active: Array<{ id: string }>
  ) {
    const last = await tx.engagementQuestionCycle.findFirst({
      where: { ownerCoadminUserId },
      orderBy: { cycleNumber: "desc" }
    });
    const cycle = await tx.engagementQuestionCycle.create({
      data: {
        workspaceId,
        ownerCoadminUserId,
        cycleNumber: (last?.cycleNumber ?? 0) + 1,
        shuffledAt: now
      }
    });
    const shuffled = shuffleIds(active);
    await tx.engagementQuestionCycleItem.createMany({
      data: shuffled.map((question, drawOrder) => ({
        cycleId: cycle.id,
        questionId: question.id,
        drawOrder
      }))
    });
    return cycle;
  }

  private async closeDuePolls(
    integration: { id: string; workspaceId: string; ownerCoadminUserId: string },
    now: Date
  ): Promise<void> {
    const due = await this.prisma.engagementPoll.findMany({
      where: {
        botIntegrationId: integration.id,
        OR: [
          { status: { in: ["OPEN", "CLOSING", "CLOSED"] }, closesAt: { lte: now } },
          { status: "SETTLED", closeEditedAt: null, telegramMessageId: { not: null } }
        ]
      }
    });
    for (const poll of due) {
      if (poll.telegramPollId) {
        if (poll.status === "OPEN") {
          await this.prisma.engagementPoll.updateMany({
            where: { id: poll.id, status: "OPEN" },
            data: { status: "CLOSING", closedAt: now }
          });
        }
      } else if (poll.status !== "SETTLED") {
        await this.prisma.$transaction((tx) => this.settleTx(tx, poll.id, now));
      }
      if (!this.outbox) continue;
      await this.outbox.enqueueEngagementJob({
        workspaceId: integration.workspaceId,
        ownerCoadminUserId: integration.ownerCoadminUserId,
        jobType: "CLOSE_ENGAGEMENT_POLL",
        idempotencyKey: closePollOutboxKey(poll.id),
        payloadJson: { pollId: poll.id }
      });
    }
  }

  private async settleTx(tx: Prisma.TransactionClient, pollId: string, now: Date): Promise<void> {
    await tx.$queryRaw`
      SELECT id FROM engagement_polls WHERE id = ${pollId}::uuid FOR UPDATE
    `;
    const claimed = await tx.engagementPoll.updateMany({
      where: { id: pollId, status: "OPEN" },
      data: { status: "CLOSING", closedAt: now }
    });
    const poll = await tx.engagementPoll.findUnique({ where: { id: pollId } });
    if (!poll) return;
    if (poll.status === "SETTLED") return;
    if (claimed.count !== 1 && poll.status !== "CLOSING" && poll.status !== "CLOSED") return;
    const votes = await tx.engagementVote.findMany({ where: { pollId } });
    const registeredCounts = countOptionVotes(votes.map((vote) => vote.optionIndex));
    const nativeCounts = poll.telegramPollId ? parseStoredOptionCounts(poll.optionCountsJson) : null;
    const counts = nativeCounts ?? registeredCounts;
    const totalVotes = counts.reduce((sum, n) => sum + n, 0);
    const winner = totalVotes > 0 ? winningOptionIndex(counts) : null;
    await tx.engagementPoll.update({
      where: { id: pollId },
      data: {
        status: "SETTLED",
        settledAt: now,
        optionCountsJson: counts,
        winningOptionIndex: winner,
        closedAt: poll.closedAt ?? now
      }
    });
  }

  private async enqueueDueDailyDraw(
    integration: {
      id: string;
      workspaceId: string;
      ownerCoadminUserId: string;
      channelId: string | null;
    },
    now: Date
  ): Promise<void> {
    if (!this.outbox) return;
    const chicagoDate = latestDeclarationChicagoDate(now);
    const declareAt = declarationInstantForChicagoDate(chicagoDate);
    if (now.getTime() < declareAt.getTime()) return;
    const earliestPoll = await this.prisma.engagementPoll.findFirst({
      where: { ownerCoadminUserId: integration.ownerCoadminUserId },
      orderBy: { chicagoDate: "asc" },
      select: { chicagoDate: true }
    });
    if (!isEligibleEngagementDeclarationDate(chicagoDate, earliestPoll ? [earliestPoll.chicagoDate] : [])) {
      return;
    }
    const existing = await this.prisma.engagementDailyDraw.findUnique({
      where: {
        ownerCoadminUserId_chicagoDate: {
          ownerCoadminUserId: integration.ownerCoadminUserId,
          chicagoDate
        }
      }
    });
    if (existing) {
      if (existing.winnerCrmContactId && !existing.telegramMessageId) {
        await this.outbox.enqueueEngagementJob({
          workspaceId: integration.workspaceId,
          ownerCoadminUserId: integration.ownerCoadminUserId,
          jobType: "ANNOUNCE_ENGAGEMENT_DAILY_DRAW",
          idempotencyKey: dailyDrawAnnounceOutboxKey(integration.ownerCoadminUserId, chicagoDate),
          payloadJson: { drawId: existing.id, chicagoDate }
        });
      }
      return;
    }
    await this.outbox.enqueueEngagementJob({
      workspaceId: integration.workspaceId,
      ownerCoadminUserId: integration.ownerCoadminUserId,
      jobType: "RUN_ENGAGEMENT_DAILY_DRAW",
      idempotencyKey: dailyDrawOutboxKey(integration.ownerCoadminUserId, chicagoDate),
      payloadJson: { chicagoDate }
    });
  }

  private async ensureDailyDrawClaimAndAnnounce(
    drawId: string,
    integration: { workspaceId: string; ownerCoadminUserId: string },
    now: Date
  ): Promise<void> {
    const draw = await this.prisma.engagementDailyDraw.findUnique({ where: { id: drawId } });
    if (!draw) return;
    if (draw.winnerCrmContactId && !draw.freeplayClaimId) {
      const grants = this.freeplay ?? new FreeplayService({ prisma: this.prisma });
      const granted = await grants.grantEngagementClaim({
        workspaceId: draw.workspaceId,
        ownerCoadminUserId: draw.ownerCoadminUserId,
        crmContactId: draw.winnerCrmContactId,
        amountCents: DAILY_DRAW_PRIZE_CENTS,
        idempotencyKey: dailyDrawFreeplayIdempotencyKey(draw.ownerCoadminUserId, draw.chicagoDate),
        source: "ENGAGEMENT_DAILY_DRAW"
      });
      await this.prisma.engagementDailyDraw.update({
        where: { id: draw.id },
        data: { freeplayClaimId: granted.claimId }
      });
    }
    if (!this.outbox || !draw.winnerCrmContactId || draw.telegramMessageId) return;
    await this.outbox.enqueueEngagementJob({
      workspaceId: integration.workspaceId,
      ownerCoadminUserId: integration.ownerCoadminUserId,
      jobType: "ANNOUNCE_ENGAGEMENT_DAILY_DRAW",
      idempotencyKey: dailyDrawAnnounceOutboxKey(integration.ownerCoadminUserId, draw.chicagoDate),
      payloadJson: { drawId: draw.id, chicagoDate: draw.chicagoDate, at: now.toISOString() }
    });
  }

  private async loadDailyDrawCandidates(
    integration: {
      id: string;
      workspaceId: string;
      ownerCoadminUserId: string;
      channelId: string | null;
    },
    client: LeaderboardTelegramClient,
    token: string,
    chicagoDate: string,
    declareAt: Date
  ): Promise<DailyDrawCandidate[]> {
    if (!integration.channelId) return [];
    const links = await this.prisma.leaderboardBotPlayerLink.findMany({
      where: {
        botIntegrationId: integration.id,
        ownerCoadminUserId: integration.ownerCoadminUserId
      },
      include: { crmContact: true }
    });
    const cooldownStart = addChicagoDays(chicagoDate, -DRAW_WINNER_COOLDOWN_DRAWS);
    const recentWins = await this.prisma.engagementDailyDraw.findMany({
      where: {
        ownerCoadminUserId: integration.ownerCoadminUserId,
        winnerCrmContactId: { not: null },
        chicagoDate: { gte: cooldownStart, lt: chicagoDate }
      },
      select: { winnerCrmContactId: true, chicagoDate: true }
    });
    const winsByContact = new Map<string, string[]>();
    for (const row of recentWins) {
      if (!row.winnerCrmContactId) continue;
      const list = winsByContact.get(row.winnerCrmContactId) ?? [];
      list.push(row.chicagoDate);
      winsByContact.set(row.winnerCrmContactId, list);
    }
    const awards = await this.prisma.referralMilestoneAward.findMany({
      where: {
        milestoneCode: "FIRST_10",
        status: "ACTIVE",
        awardedAt: { lt: declareAt },
        referral: { ownerCoadminUserId: integration.ownerCoadminUserId }
      },
      include: { referral: true }
    });
    const referralWeightByContact = new Map<string, { weight: number; activeCount: number }>();
    for (const award of awards) {
      const weight = drawReferralWeightAtDeclaration(award.awardedAt, declareAt);
      const crmContactId = award.referral.referrerCrmContactId;
      const current = referralWeightByContact.get(crmContactId) ?? { weight: 0, activeCount: 0 };
      referralWeightByContact.set(crmContactId, {
        weight: current.weight + weight,
        activeCount: current.activeCount + (weight > 0 ? 1 : 0)
      });
    }
    const candidates: DailyDrawCandidate[] = [];
    for (const link of links) {
      if (isInDailyDrawWinnerCooldown(winsByContact.get(link.crmContactId) ?? [], chicagoDate)) {
        continue;
      }
      let member;
      try {
        member = await client.getChatMember(token, integration.channelId, link.telegramUserId);
      } catch {
        continue;
      }
      if (!isDailyDrawEligibleChatMember(member)) continue;
      const referral = referralWeightByContact.get(link.crmContactId) ?? { weight: 0, activeCount: 0 };
      candidates.push({
        crmContactId: link.crmContactId,
        telegramUserId: link.telegramUserId,
        displayName: link.crmContact.displayName,
        baseWeight: DRAW_BASE_WEIGHT,
        referralWeight: referral.weight,
        totalWeight: candidateDrawWeight(referral.weight),
        activeReferralCount: referral.activeCount
      });
    }
    return candidates;
  }
}

export async function runEngagementSweepSafely(
  service: Pick<EngagementService, "sweep">,
  log: { info: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void }
): Promise<void> {
  try {
    await service.sweep();
    log.info({}, "Engagement sweep completed");
  } catch (error) {
    log.error({ err: error }, "Engagement sweep failed");
  }
}

export function pollIdFromOutboxPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const pollId = (payload as { pollId?: unknown }).pollId;
  return typeof pollId === "string" ? pollId : null;
}

export function dailyResultIdFromOutboxPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const id = (payload as { dailyResultId?: unknown }).dailyResultId;
  return typeof id === "string" ? id : null;
}

export function chicagoDateFromOutboxPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const chicagoDate = (payload as { chicagoDate?: unknown }).chicagoDate;
  return typeof chicagoDate === "string" ? chicagoDate : null;
}

export function drawIdFromOutboxPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const id = (payload as { drawId?: unknown }).drawId;
  return typeof id === "string" ? id : null;
}

function isPollAlreadyClosedError(error: unknown): boolean {
  return (
    error instanceof LeaderboardTelegramApiError &&
    /already been closed|POLL_CLOSED|poll_closed/i.test(error.description)
  );
}
