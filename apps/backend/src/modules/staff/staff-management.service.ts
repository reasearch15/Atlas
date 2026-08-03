import bcrypt from "bcryptjs";
import type { PrismaClient } from "@prisma/client";
import { createStaffSchemaV2, passwordSchema } from "@atlas/shared";
import { AppError, unauthorized } from "../../utils/errors";
import type { RequestUser } from "../auth/auth.types";

/**
 * Manages Staff accounts inside a Coadmin-owned workspace.
 */
export class StaffManagementService {
  public constructor(private readonly prisma: PrismaClient) {}

  /**
   * Lists Staff in the authenticated Coadmin workspace.
   */
  public async list(actor: RequestUser) {
    const workspaceId = this.requireWorkspace(actor);
    const staff = await this.prisma.user.findMany({ where: { workspaceId, role: "STAFF" }, orderBy: { createdAt: "desc" } });
    const threads = await this.prisma.internalMessageThread.findMany({
      where: { workspaceId, staffUserId: { in: staff.map((row) => row.id) } }
    });
    const threadByStaff = new Map(threads.map((thread) => [thread.staffUserId, thread]));
    const sessions = await this.prisma.session.findMany({
      where: { userId: { in: staff.map((row) => row.id) }, revokedAt: null },
      orderBy: { lastSeenAt: "desc" }
    });
    const lastSeenByUser = new Map<string, Date>();
    for (const session of sessions) {
      if (!lastSeenByUser.has(session.userId)) {
        lastSeenByUser.set(session.userId, session.lastSeenAt);
      }
    }
    return staff.map((user) => {
      const thread = threadByStaff.get(user.id);
      return {
        id: user.id,
        name: user.name,
        username: user.username,
        contactEmail: user.email,
        status: user.status,
        mustChangePassword: user.mustChangePassword,
        createdAt: user.createdAt.toISOString(),
        lastActiveAt: lastSeenByUser.get(user.id)?.toISOString() ?? null,
        internalUnreadCount: thread?.coadminUnreadCount ?? 0,
        lastInternalMessagePreview: thread?.lastMessagePreview ?? null,
        lastInternalMessageAt: thread?.lastMessageAt?.toISOString() ?? null
      };
    });
  }

  /**
   * Loads Staff details including sessions in the authenticated workspace.
   */
  public async get(actor: RequestUser, staffId: string) {
    const workspaceId = this.requireWorkspace(actor);
    const staff = await this.loadStaff(workspaceId, staffId);
    const [sessions, trustedDevices] = await Promise.all([
      this.prisma.session.findMany({ where: { userId: staff.id }, orderBy: { lastSeenAt: "desc" }, take: 20 }),
      this.prisma.userTrustedDevice.count({ where: { userId: staff.id, revokedAt: null } })
    ]);
    return {
      id: staff.id,
      name: staff.name,
      username: staff.username,
      contactEmail: staff.email,
      status: staff.status,
      mustChangePassword: staff.mustChangePassword,
      createdAt: staff.createdAt.toISOString(),
      activeSessions: sessions.filter((session) => !session.revokedAt && session.expiresAt > new Date()).length,
      trustedDevices,
      lastTemporaryPasswordIssuedAt: staff.temporaryPasswordIssuedAt?.toISOString() ?? null,
      sessions: sessions.map((session) => ({
        id: session.id,
        deviceName: session.deviceName,
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
        lastSeenAt: session.lastSeenAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        revokedAt: session.revokedAt?.toISOString() ?? null
      }))
    };
  }

  /**
   * Creates Staff with a one-time temporary password.
   */
  public async create(actor: RequestUser, body: unknown) {
    const workspaceId = this.requireWorkspace(actor);
    const input = createStaffSchemaV2.parse(body);
    const [existingUsername, existingEmail] = await Promise.all([
      this.prisma.user.findUnique({ where: { username: input.username } }),
      input.contactEmail ? this.prisma.user.findUnique({ where: { email: input.contactEmail } }) : null
    ]);
    if (existingUsername) throw new AppError(409, "USERNAME_ALREADY_EXISTS", "Username is already in use.");
    if (existingEmail) throw new AppError(409, "CONTACT_EMAIL_ALREADY_EXISTS", "Contact email is already in use.");
    const now = new Date();
    const user = await this.prisma.$transaction(async (tx) => {
      const staff = await tx.user.create({
        data: {
          workspaceId,
          username: input.username,
          email: input.contactEmail ?? null,
          name: input.fullName,
          role: "STAFF",
          status: input.status,
          passwordHash: await bcrypt.hash(input.temporaryPassword, 12),
          temporaryPasswordIssuedAt: now,
          mustChangePassword: true
        }
      });
      await tx.auditLog.create({ data: { workspaceId, actorId: actor.id, action: "staff.created", metadata: { staffUserId: staff.id, username: staff.username } } });
      await tx.auditLog.create({ data: { workspaceId, actorId: actor.id, action: "temporary_password.issued", metadata: { userId: staff.id, role: "STAFF" } } });
      return staff;
    });
    return { id: user.id, temporaryPassword: input.temporaryPassword };
  }

  /**
   * Resets a Staff password and revokes sessions and trusted devices.
   */
  public async resetPassword(actor: RequestUser, staffId: string, body: unknown) {
    const workspaceId = this.requireWorkspace(actor);
    const temporaryPassword = passwordSchema.parse((body as { temporaryPassword?: unknown }).temporaryPassword);
    const staff = await this.loadStaff(workspaceId, staffId);
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: staff.id }, data: { passwordHash: await bcrypt.hash(temporaryPassword, 12), mustChangePassword: true, temporaryPasswordIssuedAt: now } });
      await tx.session.updateMany({ where: { userId: staff.id, revokedAt: null }, data: { revokedAt: now } });
      await tx.userTrustedDevice.updateMany({ where: { userId: staff.id, revokedAt: null }, data: { revokedAt: now } });
      await tx.auditLog.create({ data: { workspaceId, actorId: actor.id, action: "password.reset", metadata: { userId: staff.id, role: "STAFF" } } });
      await tx.auditLog.create({ data: { workspaceId, actorId: actor.id, action: "sessions.revoked", metadata: { userId: staff.id, reason: "password_reset" } } });
    });
    return { id: staff.id, temporaryPassword };
  }

  /**
   * Suspends Staff and revokes active sessions.
   */
  public async suspend(actor: RequestUser, staffId: string) {
    return this.setStatus(actor, staffId, "SUSPENDED", "staff.suspended");
  }

  /**
   * Reactivates Staff without restoring revoked sessions.
   */
  public async reactivate(actor: RequestUser, staffId: string) {
    return this.setStatus(actor, staffId, "ACTIVE", "staff.reactivated");
  }

  /**
   * Archives Staff and revokes active sessions.
   */
  public async archive(actor: RequestUser, staffId: string) {
    return this.setStatus(actor, staffId, "ARCHIVED", "staff.archived");
  }

  /**
   * Revokes one Staff session.
   */
  public async revokeSession(actor: RequestUser, staffId: string, sessionId: string) {
    const workspaceId = this.requireWorkspace(actor);
    const staff = await this.loadStaff(workspaceId, staffId);
    await this.prisma.$transaction(async (tx) => {
      await tx.session.updateMany({ where: { id: sessionId, userId: staff.id, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.auditLog.create({ data: { workspaceId, actorId: actor.id, action: "sessions.revoked", metadata: { userId: staff.id, sessionId } } });
    });
    return this.get(actor, staffId);
  }

  /**
   * Revokes all Staff sessions and trusted devices.
   */
  public async revokeAllSessions(actor: RequestUser, staffId: string) {
    const workspaceId = this.requireWorkspace(actor);
    const staff = await this.loadStaff(workspaceId, staffId);
    await this.prisma.$transaction(async (tx) => {
      await tx.session.updateMany({ where: { userId: staff.id, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.userTrustedDevice.updateMany({ where: { userId: staff.id, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.auditLog.create({ data: { workspaceId, actorId: actor.id, action: "sessions.revoked", metadata: { userId: staff.id, reason: "coadmin_revoked_all" } } });
    });
    return this.get(actor, staffId);
  }

  private async setStatus(actor: RequestUser, staffId: string, status: "ACTIVE" | "SUSPENDED" | "ARCHIVED", action: string) {
    const workspaceId = this.requireWorkspace(actor);
    const staff = await this.loadStaff(workspaceId, staffId);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: staff.id }, data: { status } });
      if (status !== "ACTIVE") {
        await tx.session.updateMany({ where: { userId: staff.id, revokedAt: null }, data: { revokedAt: new Date() } });
      }
      await tx.auditLog.create({ data: { workspaceId, actorId: actor.id, action, metadata: { staffUserId: staff.id } } });
    });
    return this.get(actor, staffId);
  }

  private async loadStaff(workspaceId: string, staffId: string) {
    const staff = await this.prisma.user.findFirst({ where: { id: staffId, workspaceId, role: "STAFF" } });
    if (!staff) throw new AppError(404, "STAFF_NOT_FOUND", "Staff user was not found.");
    return staff;
  }

  private requireWorkspace(actor: RequestUser): string {
    if (actor.role !== "COADMIN" || !actor.workspaceId) throw unauthorized();
    return actor.workspaceId;
  }
}
