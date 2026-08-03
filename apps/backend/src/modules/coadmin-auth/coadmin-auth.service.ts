import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AdminTrustedDeviceDto, AuthResponse, CoadminDashboardResponse, TenantLoginResponse } from "@atlas/shared";
import { coadminLoginSchema, tenantPasswordChangeSchema } from "@atlas/shared";
import { z } from "zod";
import type Redis from "ioredis";
import type { Env } from "../../config/env";
import { AppError, unauthorized } from "../../utils/errors";
import { AuditService } from "../audit/audit.service";
import { TokenService } from "../auth/token.service";
import type { RequestUser } from "../auth/auth.types";

const passwordChangePrefix = "tenant-password-change:";
const genericLoginMessage = "Invalid username or password.";
const passwordChangeBodySchema = z
  .object({ changeToken: z.string().trim().min(32).max(512) })
  .and(tenantPasswordChangeSchema);

type TenantUser = Prisma.UserGetPayload<{ include: { workspace: true } }>;
type TrustedDeviceRecord = Prisma.UserTrustedDeviceGetPayload<Record<string, never>>;

/**
 * Authenticates Coadmins with username/password and first-login password change.
 */
export class CoadminAuthService {
  private readonly tokens: TokenService;
  private readonly audit: AuditService;
  private readonly refreshCookieName: string;
  private readonly trustedDeviceCookieName: string;
  private readonly auditPrefix: string;

  public constructor(
    private readonly prisma: PrismaClient,
    private readonly redis: Redis,
    private readonly env: Env,
    private readonly role: "COADMIN" | "STAFF" = "COADMIN"
  ) {
    this.tokens = new TokenService(env);
    this.audit = new AuditService(prisma);
    this.refreshCookieName = role === "COADMIN" ? "atlas_coadmin_refresh" : "atlas_staff_refresh";
    this.trustedDeviceCookieName = role === "COADMIN" ? "atlas_coadmin_device" : "atlas_staff_device";
    this.auditPrefix = role === "COADMIN" ? "coadmin_auth" : "staff_auth";
  }

  /**
   * Verifies username and password, then either requires password change or creates a session.
   */
  public async login(request: FastifyRequest, reply: FastifyReply): Promise<TenantLoginResponse> {
    const input = coadminLoginSchema.parse(request.body);
    await this.enforceRateLimit(`${this.role.toLowerCase()}-login:ip:${request.ip}`, 10, 900);
    await this.enforceRateLimit(`${this.role.toLowerCase()}-login:account:${input.username}`, 8, 900);
    const user = await this.prisma.user.findUnique({ where: { username: input.username }, include: { workspace: true } });
    if (!user || user.role !== this.role) {
      await this.auditLoginFailure(null, null, request);
      throw unauthorized(genericLoginMessage);
    }
    if (!this.isLoginAllowed(user)) {
      await this.auditLoginFailure(user.workspaceId, user.id, request);
      throw unauthorized("Account is not active.");
    }
    const passwordValid = await bcrypt.compare(input.password, user.passwordHash);
    if (!passwordValid) {
      await this.auditLoginFailure(user.workspaceId, user.id, request);
      throw unauthorized(genericLoginMessage);
    }
    if (user.mustChangePassword) {
      const changeToken = randomBytes(32).toString("base64url");
      await this.redis.set(`${passwordChangePrefix}${this.hashToken(changeToken)}`, user.id, "EX", 900);
      return { requiresPasswordChange: true, changeToken, user: this.toAuthUser(user) };
    }
    const device = await this.trustOrTouchDevice(user, request, reply);
    return this.createSession(user, request, reply, device.id);
  }

  /**
   * Changes a temporary password and creates the first normal session.
   */
  public async changePassword(request: FastifyRequest, reply: FastifyReply): Promise<AuthResponse> {
    const body = passwordChangeBodySchema.parse(request.body);
    const key = `${passwordChangePrefix}${this.hashToken(body.changeToken)}`;
    const userId = await this.redis.get(key);
    if (!userId) throw unauthorized("Password change session is invalid or expired.");
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: { workspace: true } });
    if (!user || !this.isLoginAllowed(user) || !user.mustChangePassword) throw unauthorized("Password change session is invalid or expired.");
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash: await bcrypt.hash(body.password, 12), mustChangePassword: false, passwordChangedAt: now }
      });
      await tx.auditLog.create({
        data: { workspaceId: user.workspaceId, actorId: user.id, action: "first_login.password_changed", metadata: { userId: user.id, role: user.role } }
      });
    });
    await this.redis.del(key);
    const fresh = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id }, include: { workspace: true } });
    const device = await this.trustOrTouchDevice(fresh, request, reply);
    return this.createSession(fresh, request, reply, device.id);
  }

  /**
   * Rotates a Coadmin refresh token.
   */
  public async refresh(request: FastifyRequest, reply: FastifyReply): Promise<AuthResponse> {
    const refreshToken = request.cookies[this.refreshCookieName];
    if (!refreshToken) throw unauthorized();
    const verified = await this.tokens.verifyRefreshToken(refreshToken);
    const session = await this.prisma.session.findUnique({ where: { id: verified.sessionId }, include: { user: { include: { workspace: true } } } });
    if (!session || session.userId !== verified.userId || session.revokedAt || session.expiresAt <= new Date() || !this.canAccessDashboard(session.user)) throw unauthorized();
    const tokenMatches = await bcrypt.compare(refreshToken, session.refreshHash);
    if (!tokenMatches) throw unauthorized();
    const requestUser = this.toRequestUser(session.user, session.id);
    const nextRefresh = await this.tokens.signRefreshToken(requestUser);
    await this.prisma.session.update({ where: { id: session.id }, data: { refreshHash: await bcrypt.hash(nextRefresh, 12), lastSeenAt: new Date() } });
    this.setRefreshCookie(reply, nextRefresh);
    return { user: this.toAuthUser(session.user), accessToken: await this.tokens.signAccessToken(requestUser) };
  }

  /**
   * Clears the current Coadmin session.
   */
  public async logout(request: FastifyRequest, reply: FastifyReply): Promise<{ success: true }> {
    if (request.user) {
      await this.prisma.session.updateMany({ where: { id: request.user.sessionId, userId: request.user.id }, data: { revokedAt: new Date() } });
      await this.audit.record({ workspaceId: request.user.workspaceId, actorId: request.user.id, action: `${this.auditPrefix}.logout`, metadata: { sessionId: request.user.sessionId } });
    }
    reply.clearCookie(this.refreshCookieName, this.refreshCookieOptions());
    return { success: true };
  }

  /**
   * Returns the authenticated Coadmin profile.
   */
  public async me(user: RequestUser): Promise<AuthResponse["user"]> {
    await this.assertDashboardAccess(user);
    return { id: user.id, email: user.email, name: user.name, role: user.role, workspaceId: user.workspaceId };
  }

  /**
   * Returns workspace-scoped dashboard metrics.
   */
  public async dashboard(user: RequestUser): Promise<CoadminDashboardResponse> {
    const record = await this.assertDashboardAccess(user);
    const workspaceId = record.workspaceId!;
    const [staff, telegramAccounts, developerApps, activeSessions, trustedDevices] = await Promise.all([
      this.prisma.user.count({ where: { workspaceId, role: "STAFF" } }),
      this.prisma.telegramAccount.count({ where: { workspaceId } }),
      this.prisma.developerApp.count({ where: { workspaceId, deletedAt: null } }),
      this.prisma.session.count({ where: { userId: user.id, revokedAt: null } }),
      this.prisma.userTrustedDevice.count({ where: { userId: user.id, revokedAt: null } })
    ]);
    return {
      workspace: { id: record.workspace!.id, name: record.workspace!.name, slug: record.workspace!.slug, status: record.workspace!.status },
      coadmin: { id: record.id, name: record.name, username: record.username!, contactEmail: record.email },
      counts: { staff, telegramAccounts, developerApps, unclaimedConversations: null, activeSessions, trustedDevices }
    };
  }

  /**
   * Lists trusted devices for the authenticated Coadmin.
   */
  public async devices(user: RequestUser): Promise<AdminTrustedDeviceDto[]> {
    await this.assertDashboardAccess(user);
    const devices = await this.prisma.userTrustedDevice.findMany({ where: { userId: user.id }, orderBy: { lastUsedAt: "desc" } });
    const currentSession = await this.prisma.session.findUnique({ where: { id: user.sessionId } });
    return devices.map((device) => this.toDeviceDto(device, currentSession?.userTrustedDeviceId === device.id));
  }

  /**
   * Revokes one trusted device and its sessions.
   */
  public async revokeDevice(request: FastifyRequest, deviceId: string): Promise<{ success: true }> {
    const user = request.user;
    if (!user) throw unauthorized();
    await this.assertDashboardAccess(user);
    await this.prisma.userTrustedDevice.updateMany({ where: { id: deviceId, userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.prisma.session.updateMany({ where: { userTrustedDeviceId: deviceId, userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit.record({ workspaceId: user.workspaceId, actorId: user.id, action: `${this.auditPrefix}.device.revoked`, metadata: { deviceId, sessionId: user.sessionId } });
    return { success: true };
  }

  /**
   * Revokes all trusted devices and sessions for the authenticated Coadmin.
   */
  public async revokeAllDevices(request: FastifyRequest, reply: FastifyReply): Promise<{ success: true }> {
    const user = request.user;
    if (!user) throw unauthorized();
    await this.assertDashboardAccess(user);
    await this.prisma.userTrustedDevice.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.prisma.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit.record({ workspaceId: user.workspaceId, actorId: user.id, action: `${this.auditPrefix}.devices.revoked_all`, metadata: { sessionId: user.sessionId } });
    reply.clearCookie(this.refreshCookieName, this.refreshCookieOptions());
    reply.clearCookie(this.trustedDeviceCookieName, this.trustedDeviceCookieOptions());
    return { success: true };
  }

  private async trustOrTouchDevice(user: TenantUser, request: FastifyRequest, reply: FastifyReply): Promise<TrustedDeviceRecord> {
    const rawToken = request.cookies[this.trustedDeviceCookieName];
    if (rawToken) {
      const existing = await this.prisma.userTrustedDevice.findUnique({ where: { tokenHash: this.hashToken(rawToken) } });
      if (existing && existing.userId === user.id && !existing.revokedAt && existing.expiresAt > new Date()) {
        return this.prisma.userTrustedDevice.update({ where: { id: existing.id }, data: { lastUsedAt: new Date(), lastIp: request.ip } });
      }
    }
    const token = randomBytes(32).toString("base64url");
    const device = await this.prisma.userTrustedDevice.create({
      data: {
        userId: user.id,
        tokenHash: this.hashToken(token),
        displayName: this.deviceDisplayName(request.headers["user-agent"]),
        browser: this.browserName(request.headers["user-agent"]),
        operatingSystem: this.operatingSystem(request.headers["user-agent"]),
        firstIp: request.ip,
        lastIp: request.ip,
        expiresAt: new Date(Date.now() + this.env.ADMIN_TRUSTED_DEVICE_TTL_SECONDS * 1000)
      }
    });
    reply.setCookie(this.trustedDeviceCookieName, token, this.trustedDeviceCookieOptions());
    await this.audit.record({ workspaceId: user.workspaceId, actorId: user.id, action: "tenant_auth.device.trusted", metadata: { deviceId: device.id, role: user.role } });
    return device;
  }

  private async createSession(user: TenantUser, request: FastifyRequest, reply: FastifyReply, trustedDeviceId: string): Promise<AuthResponse> {
    const expiresAt = new Date(Date.now() + this.env.REFRESH_TOKEN_TTL_SECONDS * 1000);
    const session = await this.prisma.session.create({
      data: { userId: user.id, workspaceId: user.workspaceId, userTrustedDeviceId: trustedDeviceId, refreshHash: "pending", deviceName: this.deviceDisplayName(request.headers["user-agent"]), ipAddress: request.ip, userAgent: request.headers["user-agent"] ?? "unknown", expiresAt }
    });
    const requestUser = this.toRequestUser(user, session.id);
    const refreshToken = await this.tokens.signRefreshToken(requestUser);
    await this.prisma.session.update({ where: { id: session.id }, data: { refreshHash: await bcrypt.hash(refreshToken, 12) } });
    this.setRefreshCookie(reply, refreshToken);
    await this.audit.record({ workspaceId: user.workspaceId, actorId: user.id, action: "tenant_auth.session.created", metadata: { sessionId: session.id, deviceId: trustedDeviceId, role: user.role } });
    return { user: this.toAuthUser(user), accessToken: await this.tokens.signAccessToken(requestUser) };
  }

  private async assertDashboardAccess(user: RequestUser): Promise<TenantUser> {
    if (user.role !== this.role || !user.workspaceId) throw unauthorized();
    const record = await this.prisma.user.findUnique({ where: { id: user.id }, include: { workspace: true } });
    if (!record || !this.canAccessDashboard(record)) throw unauthorized("Password change is required before accessing this area.");
    return record;
  }

  private isLoginAllowed(user: TenantUser): boolean {
    return user.role === this.role && ["ACTIVE", "PENDING_PASSWORD_CHANGE"].includes(user.status) && user.workspace?.status === "ACTIVE";
  }

  private canAccessDashboard(user: TenantUser): boolean {
    return user.role === this.role && user.status === "ACTIVE" && !user.mustChangePassword && user.workspace?.status === "ACTIVE";
  }

  private async enforceRateLimit(key: string, max: number, ttlSeconds: number): Promise<void> {
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, ttlSeconds);
    if (count > max) throw new AppError(429, "RATE_LIMITED", "Too many attempts. Please wait and try again.");
  }

  private async auditLoginFailure(workspaceId: string | null, actorId: string | null, request: FastifyRequest): Promise<void> {
    await this.audit.record({ workspaceId, actorId, action: `${this.auditPrefix}.password_login.failed`, metadata: {}, ipAddress: request.ip, userAgent: request.headers["user-agent"] });
  }

  private setRefreshCookie(reply: FastifyReply, token: string): void {
    reply.setCookie(this.refreshCookieName, token, this.refreshCookieOptions());
  }

  private refreshCookieOptions() {
    const options = {
      httpOnly: true,
      secure: this.env.COOKIE_SECURE,
      sameSite: "lax" as const,
      path: this.role === "COADMIN" ? "/api/coadmin-auth" : "/api/staff-auth",
      maxAge: this.env.REFRESH_TOKEN_TTL_SECONDS
    };
    return this.env.COOKIE_DOMAIN === "localhost" ? options : { ...options, domain: this.env.COOKIE_DOMAIN };
  }

  private trustedDeviceCookieOptions() {
    const options = {
      httpOnly: true,
      secure: this.env.COOKIE_SECURE,
      sameSite: "lax" as const,
      path: this.role === "COADMIN" ? "/api/coadmin-auth" : "/api/staff-auth",
      maxAge: this.env.ADMIN_TRUSTED_DEVICE_TTL_SECONDS
    };
    return this.env.COOKIE_DOMAIN === "localhost" ? options : { ...options, domain: this.env.COOKIE_DOMAIN };
  }

  private hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  private deviceDisplayName(userAgent: string | undefined): string {
    return `${this.browserName(userAgent)} on ${this.operatingSystem(userAgent)}`.slice(0, 160);
  }

  private browserName(userAgent: string | undefined): string {
    const value = userAgent ?? "";
    if (value.includes("Edg/")) return "Microsoft Edge";
    if (value.includes("Chrome/")) return "Chrome";
    if (value.includes("Firefox/")) return "Firefox";
    if (value.includes("Safari/")) return "Safari";
    return "Unknown browser";
  }

  private operatingSystem(userAgent: string | undefined): string {
    const value = userAgent ?? "";
    if (value.includes("Windows")) return "Windows";
    if (value.includes("Mac OS X")) return "macOS";
    if (value.includes("Android")) return "Android";
    if (value.includes("iPhone") || value.includes("iPad")) return "iOS";
    if (value.includes("Linux")) return "Linux";
    return "Unknown OS";
  }

  private toRequestUser(user: TenantUser, sessionId: string): RequestUser {
    return { id: user.id, email: user.email ?? user.username!, name: user.name, role: user.role, workspaceId: user.workspaceId, sessionId };
  }

  private toAuthUser(user: TenantUser) {
    return { id: user.id, email: user.email ?? user.username!, name: user.name, role: user.role, workspaceId: user.workspaceId };
  }

  private toDeviceDto(device: TrustedDeviceRecord, isCurrent: boolean): AdminTrustedDeviceDto {
    return {
      id: device.id,
      displayName: device.displayName,
      browser: device.browser,
      operatingSystem: device.operatingSystem,
      firstIp: device.firstIp,
      lastIp: device.lastIp,
      firstTrustedAt: device.firstTrustedAt.toISOString(),
      lastUsedAt: device.lastUsedAt.toISOString(),
      expiresAt: device.expiresAt.toISOString(),
      revokedAt: device.revokedAt?.toISOString() ?? null,
      isCurrent
    };
  }
}
