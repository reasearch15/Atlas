import { describe, expect, it, vi } from "vitest";
import type { Queue } from "bullmq";
import { encryptSecret } from "@atlas/shared/session-encryption";
import {
  createFakeLeaderboardTelegramClient,
  type FakeLeaderboardTelegramState,
  type FakeTelegramChatState
} from "./leaderboard-telegram.client";
import {
  buildLeaderboardTelegramWakeJobId,
  LeaderboardTelegramOutboxService,
  resumeLeaderboardTelegramOutboxSafely
} from "./leaderboard-telegram.outbox";
import { LeaderboardTelegramProcessor } from "./leaderboard-telegram.processor";
import { createMemoryPrisma } from "./leaderboard-telegram.test-harness";

const workspaceA = "11111111-1111-4111-8111-111111111111";
const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const competitionA = "f9db36db-d526-47bb-8942-91e316e2cf19";
const encryptionKey = "k".repeat(64);
const channelId = "-1003981197633";

function makeChannel(existingMessageId?: number): FakeTelegramChatState {
  return {
    id: Number(channelId),
    type: "channel",
    title: "Test",
    members: new Map([[1, "administrator"]]),
    messages:
      existingMessageId != null
        ? [{ messageId: existingMessageId, text: "old", deleted: false }]
        : [],
    nextMessageId: (existingMessageId ?? 0) + 1
  };
}

function seedRefreshReadyPrisma(options?: {
  readonly status?: string;
  readonly attemptCount?: number;
  readonly persistentMessageId?: string | null;
}) {
  const prisma = createMemoryPrisma();
  const integrationId = crypto.randomUUID();
  const outboxId = crypto.randomUUID();
  prisma._state.integrations.push({
    id: integrationId,
    workspaceId: workspaceA,
    ownerCoadminUserId: ownerA,
    encryptedBotToken: encryptSecret("tok", encryptionKey),
    botUsername: "atlas_lb_bot",
    channelId,
    channelTitle: "Test",
    postingEnabled: true,
    lastChannelVerifiedAt: new Date(),
    persistentMessageId: options?.persistentMessageId ?? "42",
    persistentMessageCompetitionId: competitionA,
    lastPublicTop10Json: [],
    disconnectedAt: null,
    lastError: null
  });
  prisma._state.competitions.push({
    id: competitionA,
    workspaceId: workspaceA,
    ownerCoadminUserId: ownerA,
    status: "ACTIVE",
    prizePoolCents: 20,
    endsAt: new Date(Date.now() + 86_400_000),
    startsAt: new Date(),
    sequence: 1
  });
  prisma._state.standings.push({
    competitionId: competitionA,
    ownerCoadminUserId: ownerA,
    crmContactId: "b1e1e379-82bf-494c-aa45-0de204e72209",
    totalPoints: 10,
    pointsReachedAt: new Date(),
    crmContact: { displayName: "Picasso", chats: [] }
  });
  prisma._state.settings.push({
    ownerCoadminUserId: ownerA,
    timezone: "America/Chicago"
  });
  prisma._state.outbox.push({
    id: outboxId,
    workspaceId: workspaceA,
    ownerCoadminUserId: ownerA,
    competitionId: competitionA,
    botIntegrationId: integrationId,
    jobType: "REFRESH_PUBLIC_LEADERBOARD",
    status: options?.status ?? "QUEUED",
    idempotencyKey: `lb:refresh:${ownerA}:${competitionA}`,
    payloadJson: { competitionId: competitionA, skipRankAnnouncements: false },
    attemptCount: options?.attemptCount ?? 0,
    nextAttemptAt: options?.status === "RETRY_SCHEDULED" ? new Date(Date.now() - 1000) : null,
    lastErrorCode: options?.status === "RETRY_SCHEDULED" ? "429" : null,
    lastErrorMessage: options?.status === "RETRY_SCHEDULED" ? "retry" : null,
    succeededAt: null,
    failedAt: null,
    cancelledAt: null,
    createdAt: new Date(),
    updatedAt: new Date()
  });
  return { prisma, outboxId, integrationId };
}

describe("BullMQ wake job id uniqueness", () => {
  it("generated BullMQ custom job IDs contain no colon characters", () => {
    const id = "6af55936-1624-4e42-af24-982a645e717b";
    const a = buildLeaderboardTelegramWakeJobId(id, 1_700_000_000_000);
    const b = buildLeaderboardTelegramWakeJobId(id, 1_700_000_000_000);
    expect(a).not.toContain(":");
    expect(b).not.toContain(":");
    expect(a.startsWith(`lb-tg-${id}-`)).toBe(true);
    expect(a).not.toMatch(/-now$/);
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(120);
  });

  it("same outbox id woken twice immediately → two distinct BullMQ job ids", async () => {
    const added: Array<{ jobId: string; data: { outboxId: string } }> = [];
    const queue = {
      add: async (_name: string, data: { outboxId: string }, opts: { jobId?: string }) => {
        if (opts.jobId?.includes(":")) {
          throw new Error("Custom Id cannot contain :");
        }
        added.push({ jobId: opts.jobId!, data });
        return { id: opts.jobId };
      }
    } as unknown as Queue;

    const wake = LeaderboardTelegramOutboxService.createWakeFromQueue(queue);
    const outboxId = "6af55936-1624-4e42-af24-982a645e717b";
    await wake(outboxId, 0);
    await wake(outboxId, 0);

    expect(added).toHaveLength(2);
    expect(added[0]!.jobId).not.toBe(added[1]!.jobId);
    expect(added[0]!.data.outboxId).toBe(outboxId);
    expect(added[1]!.data.outboxId).toBe(outboxId);
    expect(added.every((j) => !j.jobId.includes(":"))).toBe(true);
    expect(added.every((j) => !j.jobId.endsWith("-now"))).toBe(true);
  });

  it("delayed wakes in the same second still get distinct BullMQ job ids", async () => {
    const added: string[] = [];
    const queue = {
      add: async (_name: string, _data: unknown, opts: { jobId?: string }) => {
        if (opts.jobId?.includes(":")) {
          throw new Error("Custom Id cannot contain :");
        }
        added.push(opts.jobId!);
        return { id: opts.jobId };
      }
    } as unknown as Queue;

    const wake = LeaderboardTelegramOutboxService.createWakeFromQueue(queue);
    const outboxId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    await wake(outboxId, 5_000);
    await wake(outboxId, 5_000);
    await wake(outboxId, 5_000);

    expect(new Set(added).size).toBe(3);
    expect(added.every((id) => !id.includes(":"))).toBe(true);
  });

  it("previously completed wake exists → later wake still creates runnable job", async () => {
    const completedIds = new Set<string>();
    const runnable: string[] = [];
    const queue = {
      add: async (_name: string, _data: { outboxId: string }, opts: { jobId?: string }) => {
        const jobId = opts.jobId!;
        if (jobId.includes(":")) {
          throw new Error("Custom Id cannot contain :");
        }
        if (completedIds.has(jobId)) {
          return { id: jobId, reused: true };
        }
        runnable.push(jobId);
        completedIds.add(jobId);
        return { id: jobId };
      }
    } as unknown as Queue;

    const wake = LeaderboardTelegramOutboxService.createWakeFromQueue(queue);
    const outboxId = "6af55936-1624-4e42-af24-982a645e717b";
    await wake(outboxId, 0);
    await wake(outboxId, 0);
    expect(runnable).toHaveLength(2);
    expect(runnable[0]).not.toBe(runnable[1]);
  });

  it("resumePending called repeatedly does not permanently suppress wakes", async () => {
    const wakeIds: string[] = [];
    const prisma = createMemoryPrisma();
    const outboxId = crypto.randomUUID();
    prisma._state.outbox.push({
      id: outboxId,
      workspaceId: workspaceA,
      ownerCoadminUserId: ownerA,
      competitionId: competitionA,
      botIntegrationId: null,
      jobType: "REFRESH_PUBLIC_LEADERBOARD",
      status: "QUEUED",
      idempotencyKey: `lb:refresh:${ownerA}:${competitionA}`,
      payloadJson: { competitionId: competitionA },
      attemptCount: 0,
      nextAttemptAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      succeededAt: null,
      failedAt: null,
      cancelledAt: null,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    const queue = {
      add: async (_n: string, _d: unknown, opts: { jobId?: string }) => {
        if (opts.jobId?.includes(":")) {
          throw new Error("Custom Id cannot contain :");
        }
        wakeIds.push(opts.jobId!);
        return { id: opts.jobId };
      }
    } as unknown as Queue;

    const service = new LeaderboardTelegramOutboxService(
      prisma as never,
      LeaderboardTelegramOutboxService.createWakeFromQueue(queue)
    );

    expect(await service.resumePending()).toBe(1);
    expect(await service.resumePending()).toBe(1);
    expect(wakeIds).toHaveLength(2);
    expect(wakeIds[0]).not.toBe(wakeIds[1]);
    expect(prisma._state.outbox[0].status).toBe("QUEUED");
  });

  it("resumePending BullMQ wake failure is logged via safeResume and does not crash startup", async () => {
    const prisma = createMemoryPrisma();
    const outboxId = crypto.randomUUID();
    prisma._state.outbox.push({
      id: outboxId,
      workspaceId: workspaceA,
      ownerCoadminUserId: ownerA,
      competitionId: competitionA,
      botIntegrationId: null,
      jobType: "REFRESH_PUBLIC_LEADERBOARD",
      status: "QUEUED",
      idempotencyKey: `lb:refresh:${ownerA}:${competitionA}`,
      payloadJson: { competitionId: competitionA },
      attemptCount: 0,
      nextAttemptAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      succeededAt: null,
      failedAt: null,
      cancelledAt: null,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    const service = new LeaderboardTelegramOutboxService(prisma as never, async () => {
      throw new Error("Custom Id cannot contain :");
    });
    const log = { info: vi.fn(), error: vi.fn() };

    await expect(resumeLeaderboardTelegramOutboxSafely(service, log)).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(String(log.error.mock.calls[0]?.[1])).toMatch(/Failed to resume pending leaderboard Telegram/);
    expect(prisma._state.outbox[0].status).toBe("QUEUED");
  });
});

describe("resumeLeaderboardTelegramOutboxSafely", () => {
  it("logs resumePending failure and does not reject (startup lifecycle)", async () => {
    const errors: unknown[] = [];
    const log = {
      info: vi.fn(),
      error: (obj: unknown, msg?: string) => {
        errors.push({ obj, msg });
      }
    };
    const outbox = {
      resumePending: async () => {
        throw new Error("Custom Id cannot contain :");
      }
    };

    await expect(resumeLeaderboardTelegramOutboxSafely(outbox, log)).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(String((errors[0] as { msg?: string }).msg)).toMatch(/Failed to resume pending leaderboard Telegram/);
  });

  it("maintenance resume failure is logged and backend continues", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    let calls = 0;
    const outbox = {
      resumePending: async () => {
        calls += 1;
        throw new Error("Redis connection refused");
      }
    };

    await resumeLeaderboardTelegramOutboxSafely(outbox, log);
    await resumeLeaderboardTelegramOutboxSafely(outbox, log);
    expect(calls).toBe(2);
    expect(log.error).toHaveBeenCalledTimes(2);
    expect(log.info).not.toHaveBeenCalled();
  });
});

describe("processJob atomic claim under duplicate wakes", () => {
  it("multiple wake races → only one Telegram delivery and SUCCEEDED", async () => {
    const { prisma, outboxId } = seedRefreshReadyPrisma({ persistentMessageId: "42" });
    const tgState: FakeLeaderboardTelegramState = {
      bots: new Map([["tok", { id: 1, isBot: true, firstName: "Bot", username: "atlas_lb_bot" }]]),
      chats: new Map([[Number(channelId), makeChannel(42)]])
    };
    const client = createFakeLeaderboardTelegramClient(tgState);
    const editSpy = vi.spyOn(client, "editMessageText");
    const sendSpy = vi.spyOn(client, "sendMessage");

    const processor = new LeaderboardTelegramProcessor({
      prisma: prisma as never,
      encryptionKey,
      outbox: new LeaderboardTelegramOutboxService(prisma as never, async () => undefined),
      client
    });

    await Promise.all([
      processor.processJob(outboxId),
      processor.processJob(outboxId),
      processor.processJob(outboxId)
    ]);

    expect(editSpy.mock.calls.length + sendSpy.mock.calls.length).toBe(1);
    expect(prisma._state.outbox[0].status).toBe("SUCCEEDED");
    expect(prisma._state.outbox[0].attemptCount).toBe(1);
    expect(prisma._state.integrations[0].persistentMessageId).toBeTruthy();
  });

  it("QUEUED → DISPATCHING → SUCCEEDED updates persistent leaderboard", async () => {
    const { prisma, outboxId } = seedRefreshReadyPrisma({ persistentMessageId: null });
    const tgState: FakeLeaderboardTelegramState = {
      bots: new Map([["tok", { id: 1, isBot: true, firstName: "Bot", username: "atlas_lb_bot" }]]),
      chats: new Map([[Number(channelId), makeChannel()]])
    };
    const processor = new LeaderboardTelegramProcessor({
      prisma: prisma as never,
      encryptionKey,
      outbox: new LeaderboardTelegramOutboxService(prisma as never, async () => undefined),
      client: createFakeLeaderboardTelegramClient(tgState)
    });

    await processor.processJob(outboxId);
    expect(prisma._state.outbox[0].status).toBe("SUCCEEDED");
    expect(prisma._state.integrations[0].persistentMessageId).toBeTruthy();
    expect(prisma._state.integrations[0].lastPublicTop10Json).toBeTruthy();
  });

  it("RETRY_SCHEDULED → new wake → processed", async () => {
    const { prisma, outboxId } = seedRefreshReadyPrisma({
      status: "RETRY_SCHEDULED",
      attemptCount: 2,
      persistentMessageId: null
    });
    const tgState: FakeLeaderboardTelegramState = {
      bots: new Map([["tok", { id: 1, isBot: true, firstName: "Bot", username: "atlas_lb_bot" }]]),
      chats: new Map([[Number(channelId), makeChannel()]])
    };
    const processor = new LeaderboardTelegramProcessor({
      prisma: prisma as never,
      encryptionKey,
      outbox: new LeaderboardTelegramOutboxService(prisma as never, async () => undefined),
      client: createFakeLeaderboardTelegramClient(tgState)
    });

    await processor.processJob(outboxId);
    expect(prisma._state.outbox[0].status).toBe("SUCCEEDED");
    expect(prisma._state.outbox[0].attemptCount).toBe(3);
  });
});
