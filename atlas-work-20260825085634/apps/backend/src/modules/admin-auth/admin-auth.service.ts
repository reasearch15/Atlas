import { createHash, randomInt, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyReply, FastifyRequest } from "fastify";
import type Redis from "ioredis";
import type { AdminLoginChallengeResponse, AdminLoginResponse, AdminTrustedDeviceDto, AuthResponse } from "@atlas/shared";
import { adminLoginSchema, adminResendCodeSchema, adminVerifyDeviceSchema } from "@atlas/shared";
import type { Env } from "../../config/env";
import { AppError, unauthorized } from "../../utils/errors";
import { AuditService } from "../audit/audit.service";
import type { EmailService } from "../email/EmailService";
import { TokenService } from "../auth/token.service";
import type { RequestUser } from "../auth/auth.types";

const adminRefreshCookieName = "atlas_admin_refresh";
const trustedDeviceCookieName = "atlas_admin_device";
const genericLoginMessage = "Invalid email or password.";

type AdminWithUser = Prisma.PlatformAdminGetPayload<{ include: { user: true } }>;
type TrustedDeviceRecord = Prisma.AdminTrustedDeviceGetPayload<Record<string, never>>;

export class AdminAuthService {
  private readonly prisma: PrismaClient;
  private readonly env: Env;
  private readonly tokens: TokenService;
  private readonly audit: AuditService;
  private readonly email: EmailService;
  private readonly redis: Redis;

  /**
   * Creates the Platform Admin authentication service.
   */
  public constructor(prisma: PrismaClient, redis: Redis, env: Env, email: EmailService) {
    this.prisma = prisma;
    this.redis = redis;
    this.env = env;
    this.tokens = new TokenService(env);
    this.audit = new AuditService(prisma);
    this.email = email;
  }

  /**
   * Verifies admin email and password, then either creates a session or starts new-device verification.
   */
  public async login(request: FastifyRequest, reply: FastifyReply): Promise<AdminLoginResponse> {
    const input = adminLoginSchema.parse(request.body);
    const email = input.email.toLowerCase();
    await this.enforceRateLimit(`admin-login:ip:${request.ip}`, 10, 900);
    await this.enforceRateLimit(`admin-login:account:${email}`, 8, 900);

    const admin = await this.prisma.platformAdmin.findUnique({ where: { email }, include: { user: true } });
    if (!admin || admin.status !== "ACTIVE" || admin.user.status !== "ACTIVE") {
      await this.auditLoginFailure(null, request);
      throw unauthorized(genericLoginMessage);
    }

    const passwordValid = await bcrypt.compare(input.password, admin.passwordHash);
    if (!passwordValid) {
      await this.auditLoginFailure(admin.userId, request);
      throw unauthorized(genericLoginMessage);
    }

    await this.audit.record({
      workspaceId: null,
      actorId: admin.userId,
      action: "admin_auth.password_login.success",
      metadata: {},
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"]
    });

    const trustedDevice = await this.findTrustedDevice(admin.id, request);
    if (trustedDevice) {
      await this.touchTrustedDevice(trustedDevice.id, request);
      return this.createSession(admin, request, reply, trustedDevice.id);
    }

    return this.createChallenge(admin, request);
  }

  /**
   * Completes new-device verification and trusts the browser when the code is valid.
   */
  public async verifyDevice(request: FastifyRequest, reply: FastifyReply): Promise<AuthResponse> {
    const input = adminVerifyDeviceSchema.parse(request.body);
    await this.enforceRateLimit(`admin-verify:ip:${request.ip}`, 12, 900);
    await this.enforceRateLimit(`admin-verify:challenge:${input.challengeId}`, 6, 900);

    const challenge = await this.prisma.adminLoginChallenge.findUnique({
      where: { id: input.challengeId },
      include: { admin: { include: { user: true } } }
    });

    if (!challenge || challenge.consumedAt || challenge.admin.status !== "ACTIVE" || challenge.admin.user.status !== "ACTIVE") {
      throw unauthorized("Verification code is invalid or expired.");
    }

    if (challenge.expiresAt <= new Date()) {
      await this.audit.record({
        workspaceId: null,
        actorId: challenge.admin.userId,
        action: "admin_auth.verification.expired",
        metadata: { challengeId: challenge.id },
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"]
      });
      throw unauthorized("Verification code is invalid or expired.");
    }

    if (challenge.failedAttempts >= challenge.maxAttempts) {
      throw new AppError(429, "VERIFICATION_ATTEMPTS_EXCEEDED", "Too many incorrect verification attempts. Request a new code.");
    }

    const codeMatches = await bcrypt.compare(input.code, challenge.codeHash);
    if (!codeMatches) {
      await this.prisma.adminLoginChallenge.update({
        where: { id: challenge.id },
        data: { failedAttempts: { increment: 1 } }
      });
      await this.audit.record({
        workspaceId: null,
        actorId: challenge.admin.userId,
        action: "admin_auth.verification.incorrect",
        metadata: { challengeId: challenge.id },
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"]
      });
      throw unauthorized("Verification code is invalid or expired.");
    }

    await this.prisma.adminLoginChallenge.update({ where: { id: challenge.id }, data: { consumedAt: new Date() } });
    const trustedDevice = await this.trustDevice(challenge.admin.id, request, reply);
    return this.createSession(challenge.admin, request, reply, trustedDevice.id);
  }

  /**
   * Invalidates the previous code and sends a fresh code for an active challenge.
   */
  public async resendCode(request: FastifyRequest): Promise<{ maskedEmail: string; expiresAt: string; resendAvailableAt: string }> {
    const input = adminResendCodeSchema.parse(request.body);
    await this.enforceRateLimit(`admin-resend:ip:${request.ip}`, 5, 900);
    const challenge = await this.prisma.adminLoginChallenge.findUnique({ where: { id: input.challengeId }, include: { admin: true } });
    if (!challenge || challenge.consumedAt || challenge.expiresAt <= new Date()) {
      throw unauthorized("Verification code is invalid or expired.");
    }
    const resendAvailableAt = new Date(challenge.lastSentAt.getTime() + this.env.ADMIN_VERIFICATION_RESEND_COOLDOWN_SECONDS * 1000);
    if (resendAvailableAt > new Date()) {
      throw new AppError(429, "RESEND_COOLDOWN_ACTIVE", "Please wait before requesting another code.");
    }

    await this.prisma.adminLoginChallenge.updateMany({
      where: { adminId: challenge.adminId, purpose: "NEW_DEVICE", consumedAt: null },
      data: { consumedAt: new Date() }
    });

    const replacement = await this.createChallenge(challenge.admin, request);
    return {
      maskedEmail: replacement.maskedEmail,
      expiresAt: replacement.expiresAt,
      resendAvailableAt: replacement.resendAvailableAt
    };
  }

  /**
   * Rotates an admin refresh token and returns a fresh access token.
   */
  public async refresh(request: FastifyRequest, reply: FastifyReply): Promise<AuthResponse> {
    const refreshToken = request.cookies[adminRefreshCookieName];
    if (!refreshToken) {
      throw unauthorized();
    }
    const verified = await this.tokens.verifyRefreshToken(refreshToken);
    const session = await this.prisma.session.findUnique({ where: { id: verified.sessionId }, include: { user: true } });
    if (!session || session.userId !== verified.userId || session.revokedAt || session.expiresAt <= new Date()) {
      throw unauthorized();
    }
    if (session.user.role !== "PLATFORM_ADMIN" || session.user.status !== "ACTIVE") {
      throw unauthorized();
    }
    const tokenMatches = await bcrypt.compare(refreshToken, session.refreshHash);
    if (!tokenMatches) {
      throw unauthorized();
    }
    const requestUser = this.toRequestUser(session.user, session.id);
    const nextRefresh = await this.tokens.signRefreshToken(requestUser);
    await this.prisma.session.update({
      where: { id: session.id },
      data: {
        refreshHash: await bcrypt.hash(nextRefresh, 12),
        lastSeenAt: new Date(),
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] ?? session.userAgent
      }
    });
    if (session.adminTrustedDeviceId) {
      await this.touchTrustedDevice(session.adminTrustedDeviceId, request);
    }
    this.setRefreshCookie(reply, nextRefresh);
    await this.audit.record({
      workspaceId: null,
      actorId: session.userId,
      action: "admin_auth.session.refreshed",
      metadata: { sessionId: session.id },
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"]
    });
    return { user: this.toAuthUser(session.user), accessToken: await this.tokens.signAccessToken(requestUser) };
  }

  /**
   * Clears the current admin session.
   */
  public async logout(request: FastifyRequest, reply: FastifyReply): Promise<{ success: true }> {
    if (request.user) {
      await this.prisma.session.updateMany({ where: { id: request.user.sessionId, userId: request.user.id }, data: { revokedAt: new Date() } });
      await this.audit.record({
        workspaceId: null,
        actorId: request.user.id,
        action: "admin_auth.logout",
        metadata: { sessionId: request.user.sessionId },
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"]
      });
    }
    reply.clearCookie(adminRefreshCookieName, this.refreshCookieOptions());
    return { success: true };
  }

  /**
   * Returns the authenticated admin profile.
   */
  public async me(user: RequestUser): Promise<AuthResponse["user"]> {
    return { id: user.id, email: user.email, name: user.name, role: user.role, workspaceId: user.workspaceId };
  }

  /**
   * Lists trusted devices for the authenticated Platform Admin.
   */
  public async devices(user: RequestUser): Promise<AdminTrustedDeviceDto[]> {
    const admin = await this.prisma.platformAdmin.findUnique({ where: { userId: user.id } });
    if (!admin) {
      throw unauthorized();
    }
    const devices = await this.prisma.adminTrustedDevice.findMany({
      where: { adminId: admin.id },
      orderBy: { lastUsedAt: "desc" }
    });
    const currentSession = await this.prisma.session.findUnique({ where: { id: user.sessionId } });
    return devices.map((device) => this.toDeviceDto(device, currentSession?.adminTrustedDeviceId === device.id));
  }

  /**
   * Revokes one trusted device and every session bound to it.
   */
  public async revokeDevice(request: FastifyRequest, deviceId: string): Promise<{ success: true }> {
    const user = request.user;
    if (!user) {
      throw unauthorized();
    }
    const admin = await this.prisma.platformAdmin.findUnique({ where: { userId: user.id } });
    if (!admin) {
      throw unauthorized();
    }
    await this.prisma.adminTrustedDevice.updateMany({
      where: { id: deviceId, adminId: admin.id, revokedAt: null },
      data: { revokedAt: new Date() }
    });
    await this.prisma.session.updateMany({ where: { adminTrustedDeviceId: deviceId, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit.record({
      workspaceId: null,
      actorId: user.id,
      action: "admin_auth.device.revoked",
      metadata: { deviceId, sessionId: user.sessionId },
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"]
    });
    return { success: true };
  }

  /**
   * Revokes all trusted devices and all active admin sessions.
   */
  public async revokeAllDevices(request: FastifyRequest, reply: FastifyReply): Promise<{ success: true }> {
    const user = request.user;
    if (!user) {
      throw unauthorized();
    }
    const admin = await this.prisma.platformAdmin.findUnique({ where: { userId: user.id } });
    if (!admin) {
      throw unauthorized();
    }
    await this.prisma.adminTrustedDevice.updateMany({ where: { adminId: admin.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.prisma.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit.record({
      workspaceId: null,
      actorId: user.id,
      action: "admin_auth.devices.revoked_all",
      metadata: { sessionId: user.sessionId },
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"]
    });
    reply.clearCookie(adminRefreshCookieName, this.refreshCookieOptions());
    reply.clearCookie(trustedDeviceCookieName, this.trustedDeviceCookieOptions());
    return { success: true };
  }

  private async createChallenge(
    admin: AdminWithUser | { id: string; email: string; userId: string },
    request: FastifyRequest
  ): Promise<AdminLoginChallengeResponse> {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const expiresAt = new Date(Date.now() + this.env.ADMIN_VERIFICATION_TTL_SECONDS * 1000);
    const lastSentAt = new Date();

    await this.prisma.adminLoginChallenge.updateMany({
      where: { adminId: admin.id, purpose: "NEW_DEVICE", consumedAt: null },
      data: { consumedAt: new Date() }
    });
    const challenge = await this.prisma.adminLoginChallenge.create({
      data: {
        adminId: admin.id,
        codeHash: await bcrypt.hash(code, 12),
        expiresAt,
        lastSentAt,
        requestingIp: request.ip,
        requestingUserAgent: request.headers["user-agent"] ?? "unknown"
      }
    });

    await this.audit.record({
      workspaceId: null,
      actorId: admin.userId,
      action: "admin_auth.verification.requested",
      metadata: { challengeId: challenge.id },
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"]
    });

    try {
      await this.email.sendVerificationCode(admin.email, code);
      await this.audit.record({
        workspaceId: null,
        actorId: admin.userId,
        action: "admin_auth.verification.email_sent",
        metadata: { challengeId: challenge.id },
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"]
      });
    } catch (error) {
      await this.prisma.adminLoginChallenge.delete({ where: { id: challenge.id } });
      await this.audit.record({
        workspaceId: null,
        actorId: admin.userId,
        action: "admin_auth.verification.email_failed",
        metadata: { challengeId: challenge.id },
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"]
      });
      throw new AppError(
        502,
        "VERIFICATION_EMAIL_DELIVERY_FAILED",
        `Verification email could not be delivered: ${error instanceof Error ? error.message : "unknown email provider error"}`
      );
    }

    return {
      requiresVerification: true,
      challengeId: challenge.id,
      maskedEmail: this.maskEmail(admin.email),
      expiresAt: expiresAt.toISOString(),
      resendAvailableAt: new Date(lastSentAt.getTime() + this.env.ADMIN_VERIFICATION_RESEND_COOLDOWN_SECONDS * 1000).toISOString()
    };
  }

  private async createSession(
    admin: AdminWithUser,
    request: FastifyRequest,
    reply: FastifyReply,
    trustedDeviceId: string
  ): Promise<AuthResponse> {
    const expiresAt = new Date(Date.now() + this.env.REFRESH_TOKEN_TTL_SECONDS * 1000);
    const session = await this.prisma.session.create({
      data: {
        userId: admin.userId,
        workspaceId: null,
        adminTrustedDeviceId: trustedDeviceId,
        refreshHash: "pending",
        deviceName: this.deviceDisplayName(request.headers["user-agent"]),
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] ?? "unknown",
        expiresAt
      }
    });
    const requestUser = this.toRequestUser(admin.user, session.id);
    const refreshToken = await this.tokens.signRefreshToken(requestUser);
    await this.prisma.session.update({ where: { id: session.id }, data: { refreshHash: await bcrypt.hash(refreshToken, 12) } });
    await this.prisma.platformAdmin.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });
    this.setRefreshCookie(reply, refreshToken);
    await this.audit.record({
      workspaceId: null,
      actorId: admin.userId,
      action: "admin_auth.session.created",
      metadata: { sessionId: session.id, deviceId: trustedDeviceId },
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"]
    });
    return { user: this.toAuthUser(admin.user), accessToken: await this.tokens.signAccessToken(requestUser) };
  }

  private async findTrustedDevice(adminId: string, request: FastifyRequest): Promise<TrustedDeviceRecord | null> {
    const rawToken = request.cookies[trustedDeviceCookieName];
    if (!rawToken) {
      return null;
    }
    const tokenHash = this.hashToken(rawToken);
    const device = await this.prisma.adminTrustedDevice.findUnique({ where: { tokenHash } });
    if (!device || device.adminId !== adminId || device.revokedAt || device.expiresAt <= new Date()) {
      return null;
    }
    return device;
  }

  private async trustDevice(adminId: string, request: FastifyRequest, reply: FastifyReply): Promise<TrustedDeviceRecord> {
    const token = randomBytes(32).toString("base64url");
    const device = await this.prisma.adminTrustedDevice.create({
      data: {
        adminId,
        tokenHash: this.hashToken(token),
        displayName: this.deviceDisplayName(request.headers["user-agent"]),
        browser: this.browserName(request.headers["user-agent"]),
        operatingSystem: this.operatingSystem(request.headers["user-agent"]),
        firstIp: request.ip,
        lastIp: request.ip,
        expiresAt: new Date(Date.now() + this.env.ADMIN_TRUSTED_DEVICE_TTL_SECONDS * 1000)
      }
    });
    reply.setCookie(trustedDeviceCookieName, token, this.trustedDeviceCookieOptions());
    await this.audit.record({
      workspaceId: null,
      actorId: (await this.prisma.platformAdmin.findUniqueOrThrow({ where: { id: adminId } })).userId,
      action: "admin_auth.device.trusted",
      metadata: { deviceId: device.id },
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"]
    });
    return device;
  }

  private async touchTrustedDevice(deviceId: string, request: FastifyRequest): Promise<void> {
    await this.prisma.adminTrustedDevice.update({
      where: { id: deviceId },
      data: { lastUsedAt: new Date(), lastIp: request.ip }
    });
  }

  private async enforceRateLimit(key: string, max: number, ttlSeconds: number): Promise<void> {
    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, ttlSeconds);
    }
    if (count > max) {
      throw new AppError(429, "RATE_LIMITED", "Too many attempts. Please wait and try again.");
    }
  }

  private async auditLoginFailure(actorId: string | null, request: FastifyRequest): Promise<void> {
    await this.audit.record({
      workspaceId: null,
      actorId,
      action: "admin_auth.password_login.failed",
      metadata: {},
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"]
    });
  }

  private setRefreshCookie(reply: FastifyReply, token: string): void {
    reply.setCookie(adminRefreshCookieName, token, this.refreshCookieOptions());
  }

  private refreshCookieOptions() {
    const options = {
      httpOnly: true,
      secure: this.env.COOKIE_SECURE,
      sameSite: "lax" as const,
      path: "/api/admin-auth",
      maxAge: this.env.REFRESH_TOKEN_TTL_SECONDS
    };
    return this.env.COOKIE_DOMAIN === "localhost" ? options : { ...options, domain: this.env.COOKIE_DOMAIN };
  }

  private trustedDeviceCookieOptions() {
    const options = {
      httpOnly: true,
      secure: this.env.COOKIE_SECURE,
      sameSite: "lax" as const,
      path: "/api/admin-auth",
      maxAge: this.env.ADMIN_TRUSTED_DEVICE_TTL_SECONDS
    };
    return this.env.COOKIE_DOMAIN === "localhost" ? options : { ...options, domain: this.env.COOKIE_DOMAIN };
  }

  private hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  private maskEmail(email: string): string {
    const [local = "", domain = ""] = email.split("@");
    return `${local.slice(0, 1)}***@${domain}`;
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

  private toRequestUser(user: { id: string; email: string | null; name: string; role: RequestUser["role"]; workspaceId: string | null }, sessionId: string): RequestUser {
    return { id: user.id, email: user.email ?? user.id, name: user.name, role: user.role, workspaceId: user.workspaceId, sessionId };
  }

  private toAuthUser(user: { id: string; email: string | null; name: string; role: RequestUser["role"]; workspaceId: string | null }) {
    return { id: user.id, email: user.email ?? user.id, name: user.name, role: user.role, workspaceId: user.workspaceId };
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
