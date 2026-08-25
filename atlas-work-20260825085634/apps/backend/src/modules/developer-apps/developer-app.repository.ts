import type { Prisma, PrismaClient } from "@prisma/client";
import type { RequestUser } from "../auth/auth.types";
import { forbidden } from "../../utils/errors";

/** Accounts that still block Developer App soft-delete (disconnected/deleting rows keep or clear history separately). */
const linkedTelegramAccountCount = {
  select: {
    telegramAccounts: {
      where: { status: { notIn: ["DISCONNECTED", "DELETING"] } }
    }
  }
} as any;

export class DeveloperAppRepository {
  private readonly prisma: PrismaClient;

  /**
   * Creates a repository for workspace-owned developer applications.
   */
  public constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Resolves the workspace for a developer-app operation.
   */
  public workspaceIdFor(user: RequestUser, explicitWorkspaceId?: string): string {
    if (explicitWorkspaceId || user.role !== "COADMIN" || !user.workspaceId) {
      throw forbidden();
    }
    return user.workspaceId;
  }

  /**
   * Lists non-deleted developer apps visible to the actor.
   */
  public async list(user: RequestUser) {
    return this.prisma.developerApp.findMany({
      where: {
        deletedAt: null,
        workspaceId: user.workspaceId ?? ""
      },
      include: { _count: linkedTelegramAccountCount }
    });
  }

  /**
   * Finds a developer app in the actor's authorization boundary.
   */
  public async getForUser(user: RequestUser, id: string) {
    return this.prisma.developerApp.findFirst({
      where: {
        id,
        deletedAt: null,
        workspaceId: user.workspaceId ?? ""
      },
      include: { _count: linkedTelegramAccountCount }
    });
  }

  /**
   * Creates a developer app.
   */
  public async create(data: Prisma.DeveloperAppUncheckedCreateInput) {
    return this.prisma.developerApp.create({
      data,
      include: { _count: linkedTelegramAccountCount }
    });
  }

  /**
   * Finds an active developer app by display name in one workspace.
   */
  public async findActiveByDisplayName(workspaceId: string, displayName: string, excludeId?: string) {
    return this.prisma.developerApp.findFirst({
      where: {
        workspaceId,
        displayName: { equals: displayName, mode: "insensitive" },
        deletedAt: null,
        ...(excludeId ? { id: { not: excludeId } } : {})
      },
      select: { id: true }
    });
  }

  /**
   * Updates a developer app.
   */
  public async update(id: string, data: Prisma.DeveloperAppUpdateInput) {
    return this.prisma.developerApp.update({
      where: { id },
      data,
      include: { _count: linkedTelegramAccountCount }
    });
  }
}
