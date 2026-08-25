import { Prisma, type PrismaClient } from "@prisma/client";
import { FreeplayService } from "../freeplay/freeplay.service";
import type { LeaderboardTelegramOutboxService } from "../leaderboard/telegram/leaderboard-telegram.outbox";
import { DAILY_PRIZES_CENTS } from "./engagement.constants";
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
  winningOptionIndex,
  type EngagementScoreTotal
} from "./engagement.scoring";
import { shuffleIds, validateQuestionBank, type EngagementQuestionInput } from "./question-bank";
import {
  parseVoteCallbackData,
  formatOpenPollMessage,
  formatClosedPollMessage,
  formatDailyWinnersMessage,
  buildPollInlineKeyboard,
  EMPTY_INLINE_KEYBOARD
} from "./engagement.messages";
import type { LeaderboardTelegramClient } from "../leaderboard/telegram/leaderboard-telegram.client";

export type EngagementVoteStatus =
  | "recorded"
  | "already_voted"
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
    private readonly freeplay?: FreeplayService
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
      await this.declareDue(integration, now);
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
    if (!poll.channelId || !poll.questionText || !poll.option1) return;
    const sent = await client.sendMessage(token, poll.channelId, formatOpenPollMessage(poll.questionText), {
      replyMarkup: buildPollInlineKeyboard(poll.id, [poll.option1, poll.option2!, poll.option3!, poll.option4!])
    });
    await this.prisma.engagementPoll.updateMany({
      where: { id: pollId, telegramMessageId: null },
      data: {
        telegramMessageId: String(sent.messageId),
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
    if (!poll?.telegramMessageId || !poll.channelId || !poll.questionText || poll.closeEditedAt) return;
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

  public async completeAnnounce(
    dailyResultId: string,
    client: LeaderboardTelegramClient,
    token: string
  ): Promise<void> {
    const result = await this.prisma.engagementDailyResult.findUnique({
      where: { id: dailyResultId },
      include: { firstContact: true, secondContact: true, thirdContact: true }
    });
    if (!result || result.telegramMessageId || !result.channelId) {
      if (result?.telegramMessageId) {
        await this.prisma.engagementDailyResult.updateMany({
          where: { id: dailyResultId, status: "SNAPSHOTTED" },
          data: { status: "ANNOUNCED", announcedAt: result.announcedAt ?? new Date() }
        });
      }
      return;
    }
    const sent = await client.sendMessage(
      token,
      result.channelId,
      formatDailyWinnersMessage({
        firstName: result.firstContact?.displayName ?? null,
        secondName: result.secondContact?.displayName ?? null,
        thirdName: result.thirdContact?.displayName ?? null
      })
    );
    await this.prisma.engagementDailyResult.update({
      where: { id: dailyResultId },
      data: { telegramMessageId: String(sent.messageId) }
    });
    await this.prisma.engagementDailyResult.updateMany({
      where: { id: dailyResultId, status: "SNAPSHOTTED" },
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
      if (poll.status !== "SETTLED") {
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
    const counts = countOptionVotes(votes.map((vote) => vote.optionIndex));
    const totalVotes = counts.reduce((sum, n) => sum + n, 0);
    const winner = totalVotes > 0 ? winningOptionIndex(counts) : null;
    if (winner != null) {
      for (const vote of votes) {
        const key = pollParticipationIdempotencyKey(poll.id, vote.crmContactId);
        try {
          await tx.engagementPointLedger.create({
            data: {
              workspaceId: poll.workspaceId,
              ownerCoadminUserId: poll.ownerCoadminUserId,
              crmContactId: vote.crmContactId,
              chicagoDate: poll.chicagoDate,
              kind: "POLL_PARTICIPATION",
              points: pollPointsForVote(vote.optionIndex, winner),
              pollId: poll.id,
              idempotencyKey: key
            }
          });
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
        }
      }
    }
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

  private async declareDue(
    integration: {
      id: string;
      workspaceId: string;
      ownerCoadminUserId: string;
      channelId: string | null;
    },
    now: Date
  ): Promise<void> {
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
    const existing = await this.prisma.engagementDailyResult.findUnique({
      where: {
        ownerCoadminUserId_chicagoDate: {
          ownerCoadminUserId: integration.ownerCoadminUserId,
          chicagoDate
        }
      }
    });
    if (existing) {
      if (this.outbox) {
        await this.outbox.enqueueEngagementJob({
          workspaceId: integration.workspaceId,
          ownerCoadminUserId: integration.ownerCoadminUserId,
          jobType: "ANNOUNCE_ENGAGEMENT_WINNERS",
          idempotencyKey: announceOutboxKey(integration.ownerCoadminUserId, chicagoDate),
          payloadJson: { dailyResultId: existing.id }
        });
      }
      return;
    }
    let resultId: string | null = null;
    try {
      resultId = await this.prisma.$transaction((tx) =>
        this.declareTx(tx, integration, chicagoDate, declareAt, now)
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.prisma.engagementDailyResult.findUnique({
        where: {
          ownerCoadminUserId_chicagoDate: {
            ownerCoadminUserId: integration.ownerCoadminUserId,
            chicagoDate
          }
        }
      });
      resultId = raced?.id ?? null;
    }
    if (!resultId || !this.outbox) return;
    await this.outbox.enqueueEngagementJob({
      workspaceId: integration.workspaceId,
      ownerCoadminUserId: integration.ownerCoadminUserId,
      jobType: "ANNOUNCE_ENGAGEMENT_WINNERS",
      idempotencyKey: announceOutboxKey(integration.ownerCoadminUserId, chicagoDate),
      payloadJson: { dailyResultId: resultId }
    });
  }

  private async declareTx(
    tx: Prisma.TransactionClient,
    integration: {
      id: string;
      workspaceId: string;
      ownerCoadminUserId: string;
      channelId: string | null;
    },
    chicagoDate: string,
    declareAt: Date,
    now: Date
  ): Promise<string> {
    const awards = await tx.referralMilestoneAward.findMany({
      where: {
        milestoneCode: "FIRST_10",
        status: "ACTIVE",
        awardedAt: { lt: declareAt },
        referral: { ownerCoadminUserId: integration.ownerCoadminUserId }
      },
      include: { referral: true }
    });
    for (const award of awards) {
      const points = referralContributionAtDeclaration(award.awardedAt, declareAt);
      if (points <= 0) continue;
      try {
        await tx.engagementPointLedger.create({
          data: {
            workspaceId: integration.workspaceId,
            ownerCoadminUserId: integration.ownerCoadminUserId,
            crmContactId: award.referral.referrerCrmContactId,
            chicagoDate,
            kind: "REFERRAL_CONTRIBUTION",
            points,
            referralId: award.referralId,
            idempotencyKey: referralContributionIdempotencyKey(
              integration.ownerCoadminUserId,
              chicagoDate,
              award.referralId
            )
          }
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    const rows = await tx.engagementPointLedger.findMany({
      where: { ownerCoadminUserId: integration.ownerCoadminUserId, chicagoDate }
    });
    const totals = new Map<string, EngagementScoreTotal>();
    for (const row of rows) {
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
    const created = await tx.engagementDailyResult.create({
      data: {
        workspaceId: integration.workspaceId,
        ownerCoadminUserId: integration.ownerCoadminUserId,
        botIntegrationId: integration.id,
        chicagoDate,
        declaredAt: now,
        status: "SNAPSHOTTED",
        firstCrmContactId: top[0]?.crmContactId ?? null,
        secondCrmContactId: top[1]?.crmContactId ?? null,
        thirdCrmContactId: top[2]?.crmContactId ?? null,
        channelId: integration.channelId,
        snapshotJson: ranked.map((row, index) => ({
          rank: index + 1,
          crmContactId: row.crmContactId,
          totalPoints: row.totalPoints,
          pollPoints: row.pollPoints,
          referralPoints: row.referralPoints,
          pointsReachedAt: row.pointsReachedAt.toISOString()
        }))
      }
    });
    const grants = this.freeplay ?? new FreeplayService({ prisma: this.prisma });
    const winners = [created.firstCrmContactId, created.secondCrmContactId, created.thirdCrmContactId];
    for (const [index, crmContactId] of winners.entries()) {
      if (!crmContactId) continue;
      const prizeRank = index + 1;
      const amountCents = DAILY_PRIZES_CENTS[index]!;
      const granted = await grants.grantEngagementClaim({
        workspaceId: integration.workspaceId,
        ownerCoadminUserId: integration.ownerCoadminUserId,
        crmContactId,
        amountCents,
        idempotencyKey: freeplayGrantIdempotencyKey(integration.ownerCoadminUserId, chicagoDate, prizeRank),
        tx
      });
      await tx.engagementDailyPrize.create({
        data: {
          dailyResultId: created.id,
          workspaceId: integration.workspaceId,
          ownerCoadminUserId: integration.ownerCoadminUserId,
          prizeRank,
          crmContactId,
          amountCents,
          freeplayClaimId: granted.claimId
        }
      });
    }
    return created.id;
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
