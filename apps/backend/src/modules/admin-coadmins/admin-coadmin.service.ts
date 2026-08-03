import bcrypt from "bcryptjs";
import type { Prisma, PrismaClient, UserStatus, WorkspaceStatus } from "@prisma/client";
import type { AdminCoadminDetail, AdminCoadminListItem, CreateCoadminInput } from "@atlas/shared";
import { createCoadminSchema, passwordSchema } from "@atlas/shared";
import { AppError, forbidden } from "../../utils/errors";
import { AuditService } from "../audit/audit.service";
import type { RequestUser } from "../auth/auth.types";

const reservedSlugs = new Set(["admin", "api", "auth", "login", "settings", "system", "support", "app", "dashboard"]);

type CoadminWithWorkspace = Prisma.UserGetPayload<{ include: { workspace: true } }>;

export interface AdminCoadminCreateResult extends AdminCoadminDetail {
  readonly temporaryPassword: string;
}

/**
 * Handles Platform Admin lifecycle management for tenant Coadmins.
 */
export class AdminCoadminService {
  private readonly audit: AuditService;

  public constructor(private readonly prisma: PrismaClient) {
    this.audit = new AuditService(prisma);
  }

  /**
   * Lists Coadmins with server-side search and status filtering.
   */
  public async list(query: { search?: string; status?: UserStatus }): Promise<AdminCoadminListItem[]> {
    const search = query.search?.trim();
    const where: Prisma.UserWhereInput = { role: "COADMIN" };
    if (query.status) where.status = query.status;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { username: { contains: search.toLowerCase(), mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
        { workspace: { is: { name: { contains: search, mode: "insensitive" } } } },
        { workspace: { is: { slug: { contains: search.toLowerCase(), mode: "insensitive" } } } }
      ];
    }
    const users = await this.prisma.user.findMany({ where, include: { workspace: true }, orderBy: { createdAt: "desc" } });
    return users.map((user) => this.toListItem(user));
  }

  /**
   * Creates a Coadmin and workspace with a one-time temporary password.
   */
  public async create(actor: RequestUser, body: unknown): Promise<AdminCoadminCreateResult> {
    const input = createCoadminSchema.parse(body);
    const workspaceSlug = await this.allocateWorkspaceSlug(input.username);
    await this.assertUnique(input.username);
    const now = new Date();
    const passwordHash = await bcrypt.hash(input.temporaryPassword, 12);
    const workspaceStatus: WorkspaceStatus = "ACTIVE";

    const user = await this.prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.create({
        data: { name: input.username, slug: workspaceSlug, status: workspaceStatus }
      });
      const coadmin = await tx.user.create({
        data: {
          workspaceId: workspace.id,
          username: input.username,
          email: null,
          name: input.username,
          role: "COADMIN",
          status: "ACTIVE",
          passwordHash,
          temporaryPasswordIssuedAt: now,
          mustChangePassword: true
        }
      });
      await tx.workspace.update({ where: { id: workspace.id }, data: { primaryCoadminId: coadmin.id } });
      await tx.auditLog.create({ data: { workspaceId: workspace.id, actorId: actor.id, action: "coadmin.created", metadata: { coadminUserId: coadmin.id, username: coadmin.username } } });
      await tx.auditLog.create({ data: { workspaceId: workspace.id, actorId: actor.id, action: "temporary_password.issued", metadata: { userId: coadmin.id, role: "COADMIN" } } });
      return coadmin;
    });

    return { ...(await this.get(user.id)), temporaryPassword: input.temporaryPassword };
  }

  /**
   * Loads a single Coadmin detail record for Platform Admins.
   */
  public async get(coadminId: string): Promise<AdminCoadminDetail> {
    const user = await this.prisma.user.findFirst({ where: { id: coadminId, role: "COADMIN" }, include: { workspace: true } });
    if (!user || !user.workspace) throw new AppError(404, "COADMIN_NOT_FOUND", "Coadmin was not found.");
    const workspaceId = user.workspaceId!;
    const [sessions, trustedDevices, staffCount, telegramAccountCount, developerAppCount, recentAuditEvents, session] = await Promise.all([
      this.prisma.session.findMany({ where: { userId: user.id }, orderBy: { lastSeenAt: "desc" }, take: 20 }),
      this.prisma.userTrustedDevice.count({ where: { userId: user.id, revokedAt: null } }),
      this.prisma.user.count({ where: { workspaceId, role: "STAFF" } }),
      this.prisma.telegramAccount.count({ where: { workspaceId } }),
      this.prisma.developerApp.count({ where: { workspaceId, deletedAt: null } }),
      this.prisma.auditLog.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" }, take: 10 }),
      this.prisma.session.findFirst({ where: { userId: user.id, revokedAt: null }, orderBy: { lastSeenAt: "desc" } })
    ]);
    return {
      ...this.toListItem(user),
      lastLoginAt: session?.lastSeenAt.toISOString() ?? null,
      activeSessions: sessions.filter((item) => !item.revokedAt && item.expiresAt > new Date()).length,
      trustedDevices,
      staffCount,
      telegramAccountCount,
      developerAppCount,
      lastTemporaryPasswordIssuedAt: user.temporaryPasswordIssuedAt?.toISOString() ?? null,
      sessions: sessions.map((item) => ({
        id: item.id,
        deviceName: item.deviceName,
        ipAddress: item.ipAddress,
        userAgent: item.userAgent,
        lastSeenAt: item.lastSeenAt.toISOString(),
        expiresAt: item.expiresAt.toISOString(),
        revokedAt: item.revokedAt?.toISOString() ?? null
      })),
      recentAuditEvents: recentAuditEvents.map((event) => ({
        id: event.id,
        action: event.action,
        createdAt: event.createdAt.toISOString(),
        ipAddress: event.ipAddress
      }))
    };
  }

  /**
   * Resets a Coadmin password and revokes sessions and trusted devices.
   */
  public async resetPassword(actor: RequestUser, coadminId: string, body: unknown): Promise<AdminCoadminCreateResult> {
    const password = passwordSchema.parse((body as { temporaryPassword?: unknown }).temporaryPassword);
    const user = await this.loadCoadmin(coadminId);
    await this.resetCredential(actor.id, user.id, user.workspaceId!, password, "COADMIN");
    return { ...(await this.get(user.id)), temporaryPassword: password };
  }

  /**
   * Suspends a Coadmin and revokes workspace sessions.
   */
  public async suspend(actor: RequestUser, coadminId: string): Promise<AdminCoadminDetail> {
    return this.setStatus(actor, coadminId, "SUSPENDED", "SUSPENDED", "coadmin.suspended");
  }

  /**
   * Reactivates a suspended Coadmin workspace.
   */
  public async reactivate(actor: RequestUser, coadminId: string): Promise<AdminCoadminDetail> {
    return this.setStatus(actor, coadminId, "ACTIVE", "ACTIVE", "coadmin.reactivated");
  }

  /**
   * Archives a Coadmin and preserves tenant data.
   */
  public async archive(actor: RequestUser, coadminId: string): Promise<AdminCoadminDetail> {
    return this.setStatus(actor, coadminId, "ARCHIVED", "ARCHIVED", "coadmin.archived");
  }

  /**
   * Revokes one Coadmin session.
   */
  public async revokeSession(actor: RequestUser, coadminId: string, sessionId: string): Promise<AdminCoadminDetail> {
    const user = await this.loadCoadmin(coadminId);
    await this.prisma.$transaction(async (tx) => {
      await tx.session.updateMany({ where: { id: sessionId, userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.auditLog.create({ data: { workspaceId: user.workspaceId, actorId: actor.id, action: "sessions.revoked", metadata: { userId: user.id, sessionId } } });
    });
    return this.get(user.id);
  }

  /**
   * Revokes all Coadmin sessions and trusted devices.
   */
  public async revokeAllSessions(actor: RequestUser, coadminId: string): Promise<AdminCoadminDetail> {
    const user = await this.loadCoadmin(coadminId);
    await this.prisma.$transaction(async (tx) => {
      await tx.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.userTrustedDevice.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.auditLog.create({ data: { workspaceId: user.workspaceId, actorId: actor.id, action: "sessions.revoked", metadata: { userId: user.id, reason: "admin_revoked_all" } } });
    });
    return this.get(user.id);
  }

  private async assertUnique(username: CreateCoadminInput["username"]): Promise<void> {
    const existingUsername = await this.prisma.user.findUnique({ where: { username } });
    if (existingUsername) throw new AppError(409, "USERNAME_ALREADY_EXISTS", "Username is already in use.");
  }

  private async allocateWorkspaceSlug(username: string): Promise<string> {
    const baseSlug = this.workspaceSlugFromUsername(username);
    const preferredSlug = reservedSlugs.has(baseSlug) ? this.truncateSlug(`${baseSlug}-workspace`) : baseSlug;
    for (let index = 0; index < 100; index += 1) {
      const candidate = index === 0 ? preferredSlug : this.slugWithSuffix(preferredSlug, String(index + 1));
      const existingWorkspace = await this.prisma.workspace.findUnique({ where: { slug: candidate } });
      if (!existingWorkspace) {
        return candidate;
      }
    }
    throw new AppError(409, "WORKSPACE_SLUG_UNAVAILABLE", "Unable to allocate a workspace slug for this username.");
  }

  private workspaceSlugFromUsername(username: string): string {
    const slug = username
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-{2,}/g, "-");
    return this.truncateSlug(slug || "workspace");
  }

  private truncateSlug(slug: string): string {
    return slug.slice(0, 64).replace(/-+$/g, "");
  }

  private slugWithSuffix(slug: string, suffix: string): string {
    const maxBaseLength = 63 - suffix.length;
    return `${slug.slice(0, maxBaseLength).replace(/-+$/g, "")}-${suffix}`;
  }

  private async resetCredential(actorId: string, userId: string, workspaceId: string, temporaryPassword: string, role: "COADMIN" | "STAFF"): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { passwordHash: await bcrypt.hash(temporaryPassword, 12), mustChangePassword: true, temporaryPasswordIssuedAt: now } });
      await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
      await tx.userTrustedDevice.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
      await tx.auditLog.create({ data: { workspaceId, actorId, action: "password.reset", metadata: { userId, role } } });
      await tx.auditLog.create({ data: { workspaceId, actorId, action: "sessions.revoked", metadata: { userId, reason: "password_reset" } } });
      await tx.auditLog.create({ data: { workspaceId, actorId, action: "temporary_password.issued", metadata: { userId, role } } });
    });
  }

  private async setStatus(actor: RequestUser, coadminId: string, userStatus: UserStatus, workspaceStatus: WorkspaceStatus, action: string): Promise<AdminCoadminDetail> {
    const user = await this.loadCoadmin(coadminId);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { status: userStatus } });
      await tx.workspace.update({ where: { id: user.workspaceId! }, data: { status: workspaceStatus } });
      if (userStatus !== "ACTIVE") {
        await tx.session.updateMany({ where: { workspaceId: user.workspaceId, revokedAt: null }, data: { revokedAt: new Date() } });
      }
      await tx.auditLog.create({ data: { workspaceId: user.workspaceId, actorId: actor.id, action, metadata: { coadminUserId: user.id } } });
    });
    return this.get(user.id);
  }

  private async loadCoadmin(coadminId: string) {
    const user = await this.prisma.user.findFirst({ where: { id: coadminId, role: "COADMIN" }, include: { workspace: true } });
    if (!user || !user.workspaceId) throw new AppError(404, "COADMIN_NOT_FOUND", "Coadmin was not found.");
    return user;
  }

  private toListItem(user: CoadminWithWorkspace): AdminCoadminListItem {
    if (!user.workspace || !user.username) throw forbidden("Coadmin is missing workspace or username.");
    return {
      id: user.id,
      name: user.name,
      username: user.username,
      contactEmail: user.email,
      status: user.status as AdminCoadminListItem["status"],
      workspaceId: user.workspace.id,
      workspaceName: user.workspace.name,
      workspaceSlug: user.workspace.slug,
      workspaceStatus: user.workspace.status,
      mustChangePassword: user.mustChangePassword,
      createdAt: user.createdAt.toISOString()
    };
  }
}
