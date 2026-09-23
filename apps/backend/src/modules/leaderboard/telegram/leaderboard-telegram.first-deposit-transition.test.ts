import { describe, expect, it } from "vitest";
import { encryptSecret } from "@atlas/shared/session-encryption";
import {
  createFakeLeaderboardTelegramClient,
  LeaderboardTelegramApiError,
  type FakeLeaderboardTelegramState,
  type FakeTelegramChatState
} from "./leaderboard-telegram.client";
import { LeaderboardTelegramOutboxService } from "./leaderboard-telegram.outbox";
import { LeaderboardTelegramProcessor } from "./leaderboard-telegram.processor";
import { createMemoryPrisma } from "./leaderboard-telegram.test-harness";

/**
 * REMOVE_FINAL_LEADERBOARD_BUTTONS must be best-effort cleanup only: a
 * "Bad Request: message to edit not found" response (the old/final message from
 * a PREVIOUS, already-FINALIZED competition is simply gone) must be treated as an
 * idempotent/already-removed outcome, not retried, and must never block the
 * CURRENT competition's REFRESH_PUBLIC_LEADERBOARD from running.
 */

const workspaceId = "11111111-1111-4111-8111-111111111111";
const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const previousCompetitionId = "f45443db-6a45-4057-836a-7aa8460202e8"; // sequence 70, FINALIZED
const currentCompetitionId = "67683d90-6517-4616-a481-b7c1b51a5487"; // sequence 71, ACTIVE
const playerId = "b1e1e379-82bf-494c-aa45-0de204e72209";
const encryptionKey = "k".repeat(64);
const channelId = "-1001";

function seedIntegration(prisma: ReturnType<typeof createMemoryPrisma>, oldMessageId: string) {
  const integrationId = crypto.randomUUID();
  prisma._state.integrations.push({
    id: integrationId,
    workspaceId,
    ownerCoadminUserId: ownerA,
    encryptedBotToken: encryptSecret("token-a", encryptionKey),
    botUsername: "atlas_lb_bot",
    channelId,
    channelTitle: "LB",
    postingEnabled: true,
    // Stale pointer left over from the previous (sequence 70) competition's
    // final leaderboard message — exactly what sequence 70/71 rollover leaves
    // behind while REMOVE_FINAL_LEADERBOARD_BUTTONS keeps failing.
    persistentMessageId: oldMessageId,
    persistentMessageCompetitionId: previousCompetitionId,
    lastPublicTop10Json: null,
    disconnectedAt: null,
    lastError: null
  });
  return integrationId;
}

function seedCurrentCompetitionWithStandings(prisma: ReturnType<typeof createMemoryPrisma>) {
  prisma._state.competitions.push({
    id: currentCompetitionId,
    workspaceId,
    ownerCoadminUserId: ownerA,
    status: "ACTIVE",
    prizePoolCents: 12_400,
    endsAt: new Date(Date.now() + 86_400_000),
    startsAt: new Date(),
    sequence: 71
  });
  prisma._state.standings.push({
    competitionId: currentCompetitionId,
    ownerCoadminUserId: ownerA,
    crmContactId: playerId,
    totalPoints: 124,
    pointsReachedAt: new Date(),
    crmContact: { displayName: "Player", chats: [] }
  });
  prisma._state.settings.push({ ownerCoadminUserId: ownerA, timezone: "America/Chicago" });
}

function seedCleanupJob(prisma: ReturnType<typeof createMemoryPrisma>, integrationId: string): string {
  const id = crypto.randomUUID();
  prisma._state.outbox.push({
    id,
    workspaceId,
    ownerCoadminUserId: ownerA,
    competitionId: currentCompetitionId,
    botIntegrationId: integrationId,
    jobType: "REMOVE_FINAL_LEADERBOARD_BUTTONS",
    status: "QUEUED",
    idempotencyKey: `lb:first-deposit:${ownerA}:${currentCompetitionId}`,
    payloadJson: { competitionId: currentCompetitionId, previousCompetitionId },
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
  return id;
}

function seedOldFinalArtifact(prisma: ReturnType<typeof createMemoryPrisma>, oldMessageId: string) {
  prisma._state.artifacts.push({
    id: crypto.randomUUID(),
    competitionId: previousCompetitionId,
    artifactType: "FINAL_LEADERBOARD",
    status: "SENT",
    chatId: channelId,
    messageId: oldMessageId,
    buttonsRemovedAt: null
  });
}

function makeChannel(oldMessageId: number, includeOldMessage: boolean): FakeTelegramChatState {
  return {
    id: Number(channelId),
    type: "channel",
    title: "LB",
    members: new Map([[101, "administrator"]]),
    messages: includeOldMessage ? [{ messageId: oldMessageId, text: "final board", deleted: false }] : [],
    nextMessageId: oldMessageId + 1
  };
}

describe("REMOVE_FINAL_LEADERBOARD_BUTTONS: best-effort cleanup only", () => {
  it("2) 'message to edit not found' is treated as already-removed — job succeeds, current leaderboard still refreshes, no 12-attempt retry loop", async () => {
    const prisma = createMemoryPrisma();
    const oldMessageId = 42;
    const integrationId = seedIntegration(prisma, String(oldMessageId));
    seedCurrentCompetitionWithStandings(prisma);
    seedOldFinalArtifact(prisma, String(oldMessageId));

    // The old message is gone from Telegram's side (deleted/expired) — the client
    // returns exactly the production error text.
    const tgState: FakeLeaderboardTelegramState = {
      bots: new Map([["token-a", { id: 101, isBot: true, firstName: "BotA", username: "bot_a" }]]),
      chats: new Map([[Number(channelId), makeChannel(oldMessageId, false)]]),
      failures: new Map([
        [
          "token-a:editMessageReplyMarkup",
          new LeaderboardTelegramApiError({
            httpStatus: 400,
            telegramErrorCode: 400,
            description: "Bad Request: message to edit not found",
            permanent: false // matches production classification — must not matter to the fix
          })
        ]
      ])
    };
    const client = createFakeLeaderboardTelegramClient(tgState);
    const outbox = new LeaderboardTelegramOutboxService(prisma, async () => undefined);
    const processor = new LeaderboardTelegramProcessor({ prisma, encryptionKey, outbox, client });

    const cleanupId = seedCleanupJob(prisma, integrationId);

    await processor.processJob(cleanupId);

    const cleanupRow = prisma._state.outbox.find((r: any) => r.id === cleanupId);
    expect(cleanupRow.status).toBe("SUCCEEDED"); // not RETRY_SCHEDULED, not FAILED
    expect(cleanupRow.attemptCount).toBeLessThan(12);

    const artifact = prisma._state.artifacts.find((a: any) => a.competitionId === previousCompetitionId);
    expect(artifact.buttonsRemovedAt).not.toBeNull(); // treated as done

    // 5) The stale sequence-70 pointer is cleared and, because the chained refresh
    // (below) runs in the same job, immediately replaced by the new sequence-71
    // message — never left dangling on the old (now-deleted) message id.
    const integration = prisma._state.integrations.find((i: any) => i.id === integrationId);
    expect(integration.persistentMessageId).not.toBe(String(oldMessageId));
    expect(integration.persistentMessageCompetitionId).toBe(currentCompetitionId);

    // The current (sequence 71) leaderboard was refreshed as part of this same job.
    const refreshRow = prisma._state.outbox.find(
      (r: any) => r.jobType === "REFRESH_PUBLIC_LEADERBOARD" && r.competitionId === currentCompetitionId
    );
    expect(refreshRow).toBeTruthy();
    expect(refreshRow.status).toBe("SUCCEEDED");

    // A brand-new message was sent for the CURRENT competition with the real points.
    const chat = tgState.chats.get(Number(channelId))!;
    expect(chat.messages.some((m) => !m.deleted && m.messageId !== oldMessageId)).toBe(true);
  });

  it("a genuinely transient failure (not 'message not found') still retries normally, not swallowed", async () => {
    const prisma = createMemoryPrisma();
    const oldMessageId = 42;
    const integrationId = seedIntegration(prisma, String(oldMessageId));
    seedCurrentCompetitionWithStandings(prisma);
    seedOldFinalArtifact(prisma, String(oldMessageId));

    const tgState: FakeLeaderboardTelegramState = {
      bots: new Map([["token-a", { id: 101, isBot: true, firstName: "BotA", username: "bot_a" }]]),
      chats: new Map([[Number(channelId), makeChannel(oldMessageId, true)]]),
      failures: new Map([
        [
          "token-a:editMessageReplyMarkup",
          new LeaderboardTelegramApiError({
            httpStatus: 429,
            telegramErrorCode: 429,
            description: "Too Many Requests",
            retryAfterSeconds: 1,
            permanent: false
          })
        ]
      ])
    };
    const client = createFakeLeaderboardTelegramClient(tgState);
    const outbox = new LeaderboardTelegramOutboxService(prisma, async () => undefined);
    const processor = new LeaderboardTelegramProcessor({ prisma, encryptionKey, outbox, client });

    const cleanupId = seedCleanupJob(prisma, integrationId);
    await processor.processJob(cleanupId);

    const cleanupRow = prisma._state.outbox.find((r: any) => r.id === cleanupId);
    expect(cleanupRow.status).toBe("RETRY_SCHEDULED"); // genuinely transient errors still retry
    const artifact = prisma._state.artifacts.find((a: any) => a.competitionId === previousCompetitionId);
    expect(artifact.buttonsRemovedAt).toBeNull();
  });

  it("6) reprocessing the already-SUCCEEDED cleanup job (duplicate wake/retry) does not send a duplicate current-board message", async () => {
    const prisma = createMemoryPrisma();
    const oldMessageId = 42;
    const integrationId = seedIntegration(prisma, String(oldMessageId));
    seedCurrentCompetitionWithStandings(prisma);
    seedOldFinalArtifact(prisma, String(oldMessageId));

    const tgState: FakeLeaderboardTelegramState = {
      bots: new Map([["token-a", { id: 101, isBot: true, firstName: "BotA", username: "bot_a" }]]),
      chats: new Map([[Number(channelId), makeChannel(oldMessageId, false)]]),
      failures: new Map([
        [
          "token-a:editMessageReplyMarkup",
          new LeaderboardTelegramApiError({
            httpStatus: 400,
            telegramErrorCode: 400,
            description: "Bad Request: message to edit not found",
            permanent: false
          })
        ]
      ])
    };
    const client = createFakeLeaderboardTelegramClient(tgState);
    const outbox = new LeaderboardTelegramOutboxService(prisma, async () => undefined);
    const processor = new LeaderboardTelegramProcessor({ prisma, encryptionKey, outbox, client });

    const cleanupId = seedCleanupJob(prisma, integrationId);
    await processor.processJob(cleanupId);
    // Re-claim/re-process the same (already SUCCEEDED) job id directly — this is
    // what a stray duplicate BullMQ wake would do.
    await processor.processJob(cleanupId);

    const chat = tgState.chats.get(Number(channelId))!;
    const liveMessages = chat.messages.filter((m) => !m.deleted);
    expect(liveMessages).toHaveLength(1); // exactly one current-board message, not two
  });
});
