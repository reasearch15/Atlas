import { describe, expect, it } from "vitest";
import type { RequestUser } from "../auth/auth.types";
import { TelegramService } from "./telegram.service";
import { telegramAccountLeaseBusy, telegramWorkerUnavailable } from "./telegram.errors";

const encryptionKey = "e".repeat(64);
const workspaceId = "11111111-1111-4111-8111-111111111111";
const coadmin: RequestUser = {
  id: "44444444-4444-4444-8444-444444444444",
  email: "coadmin",
  name: "Coadmin",
  role: "COADMIN",
  workspaceId,
  sessionId: "55555555-5555-4555-8555-555555555555"
};

describe("Telegram outbound send enqueue", () => {
  it("documents the prior 409 as TELEGRAM_ACCOUNT_LEASE_BUSY", () => {
    const error = telegramAccountLeaseBusy();
    expect(error).toMatchObject({
      statusCode: 409,
      code: "TELEGRAM_ACCOUNT_LEASE_BUSY"
    });
  });

  it("queues outbound text without requiring an active worker lease and returns 202", async () => {
    const jobs: Array<{ commandId: string }> = [];
    const messages: Array<Record<string, unknown>> = [];
    const commands: Array<Record<string, unknown>> = [];
    const chats = [
      {
        id: "chat-1",
        workspaceId,
        telegramAccountId: "account-1",
        telegramChatId: "-1001",
        title: "Support",
        chatType: "PRIVATE",
        username: null
      }
    ];
    const accounts = [
      {
        id: "account-1",
        workspaceId,
        developerAppId: "app-1",
        displayName: "Support",
        telegramUserId: "42",
        telegramUsername: null,
        phoneNumberEncrypted: null,
        sessionEncrypted: { ciphertext: "x" },
        status: "CONNECTED",
        authorizationState: "AUTHORIZED",
        syncState: "LIVE",
        lastConnectedAt: new Date(),
        lastUpdateAt: new Date(),
        lastErrorCode: null,
        lastErrorMessage: null,
        workerLeaseOwner: null,
        workerLeaseExpiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date()
      }
    ];

    const service = new TelegramService({
      prisma: {
        telegramAccount: {
          findFirst: async ({ where }: { where: { id: string; workspaceId: string } }) =>
            accounts.find((row) => row.id === where.id && row.workspaceId === where.workspaceId) ?? null
        },
        telegramChat: {
          findFirst: async ({ where }: { where: Record<string, unknown> }) => {
            if (where.id && where.workspaceId) {
              return chats.find((row) => row.id === where.id && row.workspaceId === where.workspaceId) ?? null;
            }
            return (
              chats.find(
                (row) =>
                  row.id === where.id &&
                  row.workspaceId === where.workspaceId &&
                  row.telegramAccountId === where.telegramAccountId
              ) ?? null
            );
          },
          findUnique: async ({ where }: { where: { id: string }; select?: { unreadCount: true } }) => {
            const chat = chats.find((row) => row.id === where.id);
            return chat ? { unreadCount: 0 } : null;
          },
          update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            const chat = chats.find((row) => row.id === where.id);
            Object.assign(chat!, data);
            return chat;
          }
        },
        telegramMessage: {
          findFirst: async () => null,
          upsert: async ({ create }: { create: Record<string, unknown> }) => {
            const row = { ...create, id: `msg-${messages.length + 1}`, updatedAt: new Date() };
            messages.push(row);
            return row;
          }
        },
        telegramOutboundCommand: {
          findUnique: async () => null,
          upsert: async ({ create }: { create: Record<string, unknown> }) => {
            const row = { ...create, id: `cmd-${commands.length + 1}`, status: "QUEUED", attempts: 0 };
            commands.push(row);
            return row;
          }
        },
        auditLog: {
          create: async () => undefined
        }
      },
      redis: {
        publish: async () => 1
      },
      queues: {
        telegramOutbound: {
          add: async (_name: string, payload: { commandId: string }) => {
            jobs.push(payload);
          },
          getJobCounts: async () => ({ waiting: 0, active: 0, delayed: 0, failed: 0 })
        }
      },
      env: { TELEGRAM_SESSION_ENCRYPTION_KEY: encryptionKey }
    } as never);

    const result = await service.sendTextByChatId(coadmin, "chat-1", {
      text: "hello from atlas",
      idempotencyKey: "send:chat-1:test-1"
    });

    expect(result.statusCode).toBe(202);
    expect(result.message).toMatchObject({
      text: "hello from atlas",
      direction: "OUTBOUND",
      sendStatus: "QUEUED"
    });
    expect(jobs).toHaveLength(1);
    expect(commands[0]).toMatchObject({ operation: "SEND_TEXT_MESSAGE" });
    expect(accounts[0]?.workerLeaseOwner).toBeNull();
  });

  it("returns WORKER_UNAVAILABLE when durable queueing fails", async () => {
    expect(telegramWorkerUnavailable()).toMatchObject({ statusCode: 503, code: "WORKER_UNAVAILABLE" });
  });
});
