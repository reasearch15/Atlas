import { Prisma, type PrismaClient } from "@prisma/client";
import type { RequestUser } from "../auth/auth.types";
import { telegramNotFound } from "./telegram.errors";

export class TelegramRepository {
  private readonly prisma: PrismaClient;

  /**
   * Creates a repository for tenant-scoped Telegram persistence.
   */
  public constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Resolves the workspace where a user is allowed to operate.
   */
  public workspaceIdFor(user: RequestUser, explicitWorkspaceId?: string): string {
    if (explicitWorkspaceId || user.role !== "COADMIN" || !user.workspaceId) {
      throw telegramNotFound();
    }
    return user.workspaceId;
  }

  /**
   * Lists Telegram accounts visible to the actor.
   */
  public async listAccounts(user: RequestUser) {
    return this.prisma.telegramAccount.findMany({
      where: { workspaceId: user.workspaceId ?? "" },
      orderBy: { createdAt: "desc" }
    });
  }

  /**
   * Finds an account and verifies tenant access.
   */
  public async getAccountForUser(user: RequestUser, accountId: string) {
    const account = await this.prisma.telegramAccount.findFirst({
      where: { id: accountId, workspaceId: user.workspaceId ?? "" }
    });
    if (!account) {
      throw telegramNotFound();
    }
    return account;
  }

  /**
   * Creates a pending Telegram account linked to a workspace-owned developer app.
   */
  public async createAccountForDeveloperApp(user: RequestUser, developerAppId: string, displayName: string, workspaceId?: string) {
    const resolvedWorkspaceId = this.workspaceIdFor(user, workspaceId);
    const developerApp = await this.prisma.developerApp.findFirst({
      where: { id: developerAppId, workspaceId: resolvedWorkspaceId, provider: "TELEGRAM", status: "ACTIVE", deletedAt: null }
    });
    if (!developerApp) {
      throw telegramNotFound("Developer app was not found");
    }
    return this.prisma.telegramAccount.create({
      data: {
        workspaceId: resolvedWorkspaceId,
        developerAppId,
        displayName,
        createdByUserId: user.id
      }
    });
  }

  /**
   * Lists account phone envelopes in a workspace for duplicate checks.
   */
  public async listPhoneEnvelopes(workspaceId: string) {
    return this.prisma.telegramAccount.findMany({
      where: { workspaceId, phoneNumberEncrypted: { not: Prisma.JsonNull }, status: { not: "DISCONNECTED" } },
      select: { id: true, phoneNumberEncrypted: true }
    });
  }

  /**
   * Persists an account state transition.
   */
  public async updateAccount(id: string, data: Prisma.TelegramAccountUpdateInput) {
    return this.prisma.telegramAccount.update({ where: { id }, data });
  }

  /**
   * Lists chats for a tenant-scoped Telegram account.
   */
  public async listChats(user: RequestUser, accountId: string) {
    const account = await this.getAccountForUser(user, accountId);
    return this.prisma.telegramChat.findMany({
      where: { workspaceId: account.workspaceId, telegramAccountId: account.id },
      orderBy: [{ isPinned: "desc" }, { lastMessageAt: "desc" }],
      take: 100,
      include: {
        messages: {
          orderBy: { telegramCreatedAt: "desc" },
          take: 1,
          select: { direction: true }
        },
        assignedUser: { select: { name: true } },
        tags: { include: { tag: true } }
      }
    });
  }

  /**
   * Finds a workspace-scoped chat by database id.
   */
  public async getChatForUser(user: RequestUser, chatDbId: string) {
    const chat = await this.prisma.telegramChat.findFirst({
      where: { id: chatDbId, workspaceId: user.workspaceId ?? "" }
    });
    if (!chat) {
      throw telegramNotFound();
    }
    return chat;
  }

  /**
   * Lists recent cached text messages for a chat by account + chat ids.
   */
  public async listMessages(user: RequestUser, accountId: string, chatDbId: string) {
    const account = await this.getAccountForUser(user, accountId);
    const messages = await this.prisma.telegramMessage.findMany({
      where: { workspaceId: account.workspaceId, telegramAccountId: account.id, telegramChatDbId: chatDbId },
      orderBy: { telegramCreatedAt: "desc" },
      take: 100
    });
    return messages.reverse();
  }

  /**
   * Lists recent cached text messages for a workspace-scoped chat id.
   */
  public async listMessagesByChatId(user: RequestUser, chatDbId: string) {
    const chat = await this.getChatForUser(user, chatDbId);
    const messages = await this.prisma.telegramMessage.findMany({
      where: {
        workspaceId: chat.workspaceId,
        telegramAccountId: chat.telegramAccountId,
        telegramChatDbId: chat.id
      },
      orderBy: { telegramCreatedAt: "desc" },
      take: 100
    });
    return { chat, messages: messages.reverse() };
  }
}
