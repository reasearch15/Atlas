import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AdminTrustedDeviceDto, AuthResponse, CoadminDashboardResponse, TenantLoginResponse } from "@atlas/shared";
import { coadminLoginSchema, tenantPasswordChangeSchema } from "@atlas/shared";
import type Redis from "ioredis";
import type { Env } from "../../config/env";
import { unauthorized } from "../../utils/errors";
import { AuditService } from "../audit/audit.service";
import { TokenService } from "../auth/token.service";
import type { RequestUser } from "../auth/auth.types";
import {
  assertTenantLoginNotRateLimited,
  clearTenantLoginFailures,
  recordTenantLoginFailure,
  type TenantLoginRole
} from "./login-rate-limit";
import {
  cookieWrittenEvent,
  logTenantAuthDiagnostic,
  passwordChangeRequiredEvent,
  type TenantRefreshFailureReason
} from "./tenant-auth-diagnostics";
import {
  tenantAuthCookieOptions,
  tenantAuthCookiePath,
  tenantAuthLegacyDomainClearOptions,
  tenantRefreshCookieName,
  tenantTrustedDeviceCookieName
} from "./tenant-auth-cookies";

const passwordChangePrefix = "tenant-password-change:";
const genericLoginMessage = "Invalid username or password.";
const REFRESH_GRACE_TTL_SECONDS = 45;
const REFRESH_LOCK_TTL_SECONDS = 10;
const PASSWORD_CHANGE_TTL_SECONDS = 900;

interface PasswordChangeChallenge {
  readonly userId: string;
  readonly workspaceId: string;
  readonly role: "COADMIN" | "STAFF";
  readonly action: "PASSWORD_CHANGE";
}

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
    this.refreshCookieName = tenantRefreshCookieName(role);
    this.trustedDeviceCookieName = tenantTrustedDeviceCookieName(role);
    this.auditPrefix = role === "COADMIN" ? "coadmin_auth" : "staff_auth";
  }

  /**
   * Verifies username and password, then either requires password change or creates a session.
   * Rate limits count only failed credential checks (not refresh/me/page loads/success).
   */
  public async login(request: FastifyRequest, reply: FastifyReply): Promise<TenantLoginResponse> {
    const input = coadminLoginSchema.parse(request.body);
    const roleKey = this.loginRoleKey();
    await assertTenantLoginNotRateLimited(this.redis, roleKey, input.username, request.ip);
    const user = await this.prisma.user.findUnique({ where: { username: input.username }, include: { workspace: true } });
    if (!user || user.role !== this.role) {
      await this.auditLoginFailure(null, null, request);
      await this.recordFailedLogin(input.username, request);
      throw unauthorized(genericLoginMessage);
    }
    if (!this.isLoginAllowed(user)) {
      await this.auditLoginFailure(user.workspaceId, user.id, request);
      await this.recordFailedLogin(input.username, request);
      throw unauthorized("Account is not active.");
    }
    const passwordValid = await bcrypt.compare(input.password, user.passwordHash);
    if (!passwordValid) {
      await this.auditLoginFailure(user.workspaceId, user.id, request);
      await this.recordFailedLogin(input.username, request);
      throw unauthorized(genericLoginMessage);
    }
    await clearTenantLoginFailures(this.redis, roleKey, input.username, request.ip);
    if (user.mustChangePassword) {
      if (!user.workspaceId) throw unauthorized(genericLoginMessage);
      const passwordChangeToken = randomBytes(32).toString("base64url");
      const challenge: PasswordChangeChallenge = {
        userId: user.id,
        workspaceId: user.workspaceId,
        role: this.role,
        action: "PASSWORD_CHANGE"
      };
      await this.redis.set(
        `${passwordChangePrefix}${this.hashToken(passwordChangeToken)}`,
        JSON.stringify(challenge),
        "EX",
        PASSWORD_CHANGE_TTL_SECONDS
      );
      const cookiePath = tenantAuthCookiePath(this.role);
      logTenantAuthDiagnostic(
        passwordChangeRequiredEvent(this.role, this.refreshCookieName, cookiePath, user.id)
      );
      // No refresh cookie by design — client must complete /change-password first.
      reply.header(this.cookieStatusHeaderName(), "password-change-required");
      return {
        requiresPasswordChange: true,
        passwordChangeToken,
        // Temporary alias for older clients still reading changeToken.
        changeToken: passwordChangeToken,
        user: this.toAuthUser(user)
      };
    }
    const device = await this.trustOrTouchDevice(user, request, reply);
    return this.createSession(user, request, reply, device.id);
  }

  /**
   * Changes a temporary password and creates the first normal session.
   */
  public async changePassword(request: FastifyRequest, reply: FastifyReply): Promise<AuthResponse> {
    const body = tenantPasswordChangeSchema.parse(request.body);
    const key = `${passwordChangePrefix}${this.hashToken(body.passwordChangeToken)}`;
    const raw = await this.redis.get(key);
    if (!raw) throw unauthorized("Password change session is invalid or expired.");

    let challenge: PasswordChangeChallenge;
    try {
      challenge = JSON.parse(raw) as PasswordChangeChallenge;
    } catch {
      await this.redis.del(key);
      throw unauthorized("Password change session is invalid or expired.");
    }

    if (
      challenge.action !== "PASSWORD_CHANGE" ||
      challenge.role !== this.role ||
      typeof challenge.userId !== "string" ||
      typeof challenge.workspaceId !== "string"
    ) {
      await this.redis.del(key);
      throw unauthorized("Password change session is invalid or expired.");
    }

    const user = await this.prisma.user.findUnique({ where: { id: challenge.userId }, include: { workspace: true } });
    if (
      !user ||
      !this.isLoginAllowed(user) ||
      !user.mustChangePassword ||
      user.workspaceId !== challenge.workspaceId ||
      user.role !== challenge.role
    ) {
      await this.redis.del(key);
      throw unauthorized("Password change session is invalid or expired.");
    }

    // Single-use: revoke before mutating so concurrent reuse fails.
    await this.redis.del(key);

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash: await bcrypt.hash(body.newPassword, 12), mustChangePassword: false, passwordChangedAt: now }
      });
      await tx.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now } });
      await tx.auditLog.create({
        data: { workspaceId: user.workspaceId, actorId: user.id, action: "first_login.password_changed", metadata: { userId: user.id, role: user.role } }
      });
    });
    const fresh = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id }, include: { workspace: true } });
    const device = await this.trustOrTouchDevice(fresh, request, reply);
    return this.createSession(fresh, request, reply, device.id);
  }

  /**
   * Rotates a tenant refresh token with concurrent-refresh grace.
   * Duplicate near-simultaneous refreshes share one rotation and re-align the cookie.
   */
  public async refresh(request: FastifyRequest, reply: FastifyReply): Promise<AuthResponse> {
    const cookiePath = tenantAuthCookiePath(this.role);
    const refreshToken = request.cookies[this.refreshCookieName];
    logTenantAuthDiagnostic({
      event: this.role === "STAFF" ? "staffCookiePresentOnRefresh" : "coadminCookiePresentOnRefresh",
      role: this.role,
      cookieName: this.refreshCookieName,
      cookiePath,
      cookiePresent: Boolean(refreshToken)
    });
    if (!refreshToken) {
      this.logRefreshFailure("cookie_missing");
      throw unauthorized();
    }

    let verified: { userId: string; sessionId: string };
    try {
      verified = await this.tokens.verifyRefreshToken(refreshToken);
    } catch {
      this.logRefreshFailure("token_invalid");
      throw unauthorized();
    }

    const lockKey = `tenant-refresh:lock:${verified.sessionId}`;
    const graceKey = `tenant-refresh:grace:${verified.sessionId}`;

    const acquired = await this.redis.set(lockKey, "1", "EX", REFRESH_LOCK_TTL_SECONDS, "NX");
    if (acquired !== "OK") {
      await waitMs(75);
      return this.completeRefreshAfterPeer(verified.sessionId, verified.userId, refreshToken, graceKey, reply);
    }

    try {
      const session = await this.prisma.session.findUnique({
        where: { id: verified.sessionId },
        include: { user: { include: { workspace: true } } }
      });
      if (!session) {
        this.logRefreshFailure("session_not_found", verified.sessionId, verified.userId);
        throw unauthorized();
      }
      logTenantAuthDiagnostic({
        event: this.role === "STAFF" ? "staffSessionFound" : "coadminSessionFound",
        role: this.role,
        cookieName: this.refreshCookieName,
        cookiePath,
        sessionId: session.id,
        userId: session.userId,
        sessionRole: session.user.role
      });
      logTenantAuthDiagnostic({
        event: this.role === "STAFF" ? "staffSessionRole" : "coadminSessionRole",
        role: this.role,
        cookieName: this.refreshCookieName,
        cookiePath,
        sessionId: session.id,
        userId: session.userId,
        sessionRole: session.user.role
      });
      if (session.userId !== verified.userId) {
        this.logRefreshFailure("session_user_mismatch", session.id, session.userId, session.user.role);
        throw unauthorized();
      }
      if (session.revokedAt) {
        this.logRefreshFailure("session_revoked", session.id, session.userId, session.user.role);
        throw unauthorized();
      }
      if (session.expiresAt <= new Date()) {
        logTenantAuthDiagnostic({
          event: this.role === "STAFF" ? "staffSessionExpired" : "coadminSessionExpired",
          role: this.role,
          cookieName: this.refreshCookieName,
          cookiePath,
          sessionId: session.id,
          userId: session.userId,
          sessionRole: session.user.role
        });
        this.logRefreshFailure("session_expired", session.id, session.userId, session.user.role);
        throw unauthorized();
      }
      if (session.user.role !== this.role) {
        this.logRefreshFailure("role_mismatch", session.id, session.userId, session.user.role);
        throw unauthorized();
      }
      if (!this.canAccessDashboard(session.user)) {
        this.logRefreshFailure("dashboard_blocked", session.id, session.userId, session.user.role);
        throw unauthorized();
      }

      const tokenMatches = await bcrypt.compare(refreshToken, session.refreshHash);
      if (!tokenMatches) {
        try {
          return await this.completeRefreshFromGrace(session.id, session.user, refreshToken, graceKey, reply);
        } catch {
          this.logRefreshFailure("hash_mismatch", session.id, session.userId, session.user.role);
          throw unauthorized();
        }
      }

      const requestUser = this.toRequestUser(session.user, session.id);
      const nextRefresh = await this.tokens.signRefreshToken(requestUser);
      const nextHash = await bcrypt.hash(nextRefresh, 12);
      await this.redis.set(
        graceKey,
        JSON.stringify({ oldHash: session.refreshHash, currentToken: nextRefresh }),
        "EX",
        REFRESH_GRACE_TTL_SECONDS
      );
      await this.prisma.session.update({
        where: { id: session.id },
        data: { refreshHash: nextHash, lastSeenAt: new Date() }
      });
      this.setRefreshCookie(reply, nextRefresh);
      return { user: this.toAuthUser(session.user), accessToken: await this.tokens.signAccessToken(requestUser) };
    } finally {
      await this.redis.del(lockKey);
    }
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
    const legacyRefresh = tenantAuthLegacyDomainClearOptions(this.env, tenantAuthCookiePath(this.role));
    if (legacyRefresh) reply.clearCookie(this.refreshCookieName, legacyRefresh);
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
    const path = tenantAuthCookiePath(this.role);
    const legacy = tenantAuthLegacyDomainClearOptions(this.env, path);
    if (legacy) {
      reply.clearCookie(this.refreshCookieName, legacy);
      reply.clearCookie(this.trustedDeviceCookieName, legacy);
    }
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
      data: {
        userId: user.id,
        workspaceId: user.workspaceId,
        userTrustedDeviceId: trustedDeviceId,
        refreshHash: "pending",
        deviceName: this.deviceDisplayName(request.headers["user-agent"]),
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] ?? "unknown",
        expiresAt
      }
    });
    const requestUser = this.toRequestUser(user, session.id);
    const refreshToken = await this.tokens.signRefreshToken(requestUser);
    await this.prisma.session.update({ where: { id: session.id }, data: { refreshHash: await bcrypt.hash(refreshToken, 12) } });
    this.setRefreshCookie(reply, refreshToken);
    logTenantAuthDiagnostic({
      event: this.role === "STAFF" ? "staffSessionCreated" : "coadminSessionCreated",
      role: this.role,
      cookieName: this.refreshCookieName,
      cookiePath: tenantAuthCookiePath(this.role),
      sessionId: session.id,
      userId: user.id,
      sessionRole: user.role
    });
    await this.audit.record({
      workspaceId: user.workspaceId,
      actorId: user.id,
      action: "tenant_auth.session.created",
      metadata: { sessionId: session.id, deviceId: trustedDeviceId, role: user.role }
    });
    return { user: this.toAuthUser(user), accessToken: await this.tokens.signAccessToken(requestUser) };
  }

  private logRefreshFailure(
    reason: TenantRefreshFailureReason,
    sessionId?: string,
    userId?: string,
    sessionRole?: string
  ): void {
    logTenantAuthDiagnostic({
      event: "refreshFailureReason",
      role: this.role,
      cookieName: this.refreshCookieName,
      cookiePath: tenantAuthCookiePath(this.role),
      refreshFailureReason: reason,
      ...(sessionId ? { sessionId } : {}),
      ...(userId ? { userId } : {}),
      ...(sessionRole ? { sessionRole } : {})
    });
  }

  private setRefreshCookie(reply: FastifyReply, token: string): void {
    const path = tenantAuthCookiePath(this.role);
    const options = this.refreshCookieOptions();
    const legacy = tenantAuthLegacyDomainClearOptions(this.env, path);
    if (legacy) {
      // Parent-domain clear only (Domain=.tld). Exact-host clears are skipped — they share
      // host-only identity with the new cookie and can cancel Set-Cookie in one response.
      reply.clearCookie(this.refreshCookieName, legacy);
    }
    reply.setCookie(this.refreshCookieName, token, options);
    reply.header(this.cookieStatusHeaderName(), "written");
    logTenantAuthDiagnostic(
      cookieWrittenEvent(this.role, this.refreshCookieName, path, {
        secure: options.secure,
        sameSite: options.sameSite,
        httpOnly: options.httpOnly,
        domainPresent: typeof options.domain === "string" && options.domain.length > 0,
        maxAgePresent: typeof options.maxAge === "number"
      })
    );
  }

  private cookieStatusHeaderName(): "x-atlas-staff-cookie" | "x-atlas-coadmin-cookie" {
    return this.role === "STAFF" ? "x-atlas-staff-cookie" : "x-atlas-coadmin-cookie";
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

  private loginRoleKey(): TenantLoginRole {
    return this.role === "COADMIN" ? "coadmin" : "staff";
  }

  private async recordFailedLogin(username: string, request: FastifyRequest): Promise<void> {
    await recordTenantLoginFailure(this.redis, this.loginRoleKey(), username, request.ip);
  }

  private async auditLoginFailure(workspaceId: string | null, actorId: string | null, request: FastifyRequest): Promise<void> {
    await this.audit.record({ workspaceId, actorId, action: `${this.auditPrefix}.password_login.failed`, metadata: {}, ipAddress: request.ip, userAgent: request.headers["user-agent"] });
  }

  private async completeRefreshAfterPeer(
    sessionId: string,
    userId: string,
    presentedToken: string,
    graceKey: string,
    reply: FastifyReply
  ): Promise<AuthResponse> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      include: { user: { include: { workspace: true } } }
    });
    if (
      !session ||
      session.userId !== userId ||
      session.revokedAt ||
      session.expiresAt <= new Date() ||
      session.user.role !== this.role ||
      !this.canAccessDashboard(session.user)
    ) {
      throw unauthorized();
    }
    if (await bcrypt.compare(presentedToken, session.refreshHash)) {
      const requestUser = this.toRequestUser(session.user, session.id);
      this.setRefreshCookie(reply, presentedToken);
      return { user: this.toAuthUser(session.user), accessToken: await this.tokens.signAccessToken(requestUser) };
    }
    return this.completeRefreshFromGrace(session.id, session.user, presentedToken, graceKey, reply);
  }

  private async completeRefreshFromGrace(
    sessionId: string,
    user: TenantUser,
    presentedToken: string,
    graceKey: string,
    reply: FastifyReply
  ): Promise<AuthResponse> {
    const raw = await this.redis.get(graceKey);
    if (!raw) {
      this.logRefreshFailure("grace_unavailable", sessionId, user.id, user.role);
      throw unauthorized();
    }
    let grace: { oldHash?: string; currentToken?: string };
    try {
      grace = JSON.parse(raw) as { oldHash?: string; currentToken?: string };
    } catch {
      this.logRefreshFailure("grace_unavailable", sessionId, user.id, user.role);
      throw unauthorized();
    }
    if (!grace.oldHash || !grace.currentToken) {
      this.logRefreshFailure("grace_unavailable", sessionId, user.id, user.role);
      throw unauthorized();
    }
    if (!(await bcrypt.compare(presentedToken, grace.oldHash))) {
      this.logRefreshFailure("hash_mismatch", sessionId, user.id, user.role);
      throw unauthorized();
    }
    const requestUser = this.toRequestUser(user, sessionId);
    this.setRefreshCookie(reply, grace.currentToken);
    return { user: this.toAuthUser(user), accessToken: await this.tokens.signAccessToken(requestUser) };
  }

  private refreshCookieOptions() {
    return tenantAuthCookieOptions(this.env, tenantAuthCookiePath(this.role), this.env.REFRESH_TOKEN_TTL_SECONDS);
  }

  private trustedDeviceCookieOptions() {
    return tenantAuthCookieOptions(this.env, tenantAuthCookiePath(this.role), this.env.ADMIN_TRUSTED_DEVICE_TTL_SECONDS);
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

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
