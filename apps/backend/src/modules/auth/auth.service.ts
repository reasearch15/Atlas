import bcrypt from "bcryptjs";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyRequest, FastifyReply } from "fastify";
import type { AuthResponse, MeResponse, SessionDto } from "@atlas/shared";
import { loginSchema } from "@atlas/shared";
import type { Env } from "../../config/env";
import { AppError, unauthorized } from "../../utils/errors";
import { AuditService } from "../audit/audit.service";
import { TokenService } from "./token.service";
import type { RequestUser } from "./auth.types";

const refreshCookieName = "atlas_refresh";
type UserRecord = Prisma.UserGetPayload<{ include: { platformAdmin: true } }>;

export class AuthService {
  private readonly prisma: PrismaClient;
  private readonly env: Env;
  private readonly tokens: TokenService;
  private readonly audit: AuditService;

  /**
   * Creates the authentication service with database, token, and audit dependencies.
   */
  public constructor(prisma: PrismaClient, env: Env) {
    this.prisma = prisma;
    this.env = env;
    this.tokens = new TokenService(env);
    this.audit = new AuditService(prisma);
  }

  /**
   * Authenticates a user, creates a tracked device session, and returns an access token.
   */
  public async login(request: FastifyRequest, reply: FastifyReply): Promise<AuthResponse> {
    const input = loginSchema.parse(request.body);
    const user = await this.prisma.user.findUnique({ where: { email: input.email }, include: { workspace: true, platformAdmin: true } });

    if (!user || user.status !== "ACTIVE") {
      throw unauthorized("Invalid email or password");
    }

    if (user.role === "PLATFORM_ADMIN") {
      throw unauthorized("Invalid email or password");
    }

    if (!user.workspace || user.workspace.slug !== input.workspaceSlug) {
      throw unauthorized("Invalid workspace, email, or password");
    }

    const passwordValid = await bcrypt.compare(input.password, user.passwordHash);
    if (!passwordValid) {
      throw unauthorized("Invalid email or password");
    }

    const expiresAt = new Date(Date.now() + this.env.REFRESH_TOKEN_TTL_SECONDS * 1000);
    const session = await this.prisma.session.create({
      data: {
        userId: user.id,
        workspaceId: user.workspaceId,
        refreshHash: "pending",
        deviceName: this.deviceName(request.headers["user-agent"]),
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] ?? "unknown",
        expiresAt
      }
    });

    const requestUser = this.toRequestUser(user, session.id);
    const refreshToken = await this.tokens.signRefreshToken(requestUser);
    const refreshHash = await bcrypt.hash(refreshToken, 12);
    await this.prisma.session.update({ where: { id: session.id }, data: { refreshHash } });

    this.setRefreshCookie(reply, refreshToken);
    await this.audit.record({
      workspaceId: user.workspaceId,
      actorId: user.id,
      action: "auth.login",
      metadata: { sessionId: session.id },
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"]
    });

    return {
      user: this.toAuthUser(user),
      accessToken: await this.tokens.signAccessToken(requestUser)
    };
  }

  /**
   * Rotates a refresh token and returns a fresh access token.
   */
  public async refresh(request: FastifyRequest, reply: FastifyReply): Promise<AuthResponse> {
    const refreshToken = request.cookies[refreshCookieName];
    if (!refreshToken) {
      throw unauthorized();
    }

    const verified = await this.tokens.verifyRefreshToken(refreshToken);
    const session = await this.prisma.session.findUnique({
      where: { id: verified.sessionId },
      include: { user: { include: { platformAdmin: true } } }
    });

    if (!session || session.userId !== verified.userId || session.revokedAt || session.expiresAt <= new Date()) {
      throw unauthorized();
    }

    const tokenMatches = await bcrypt.compare(refreshToken, session.refreshHash);
    if (!tokenMatches || session.user.status !== "ACTIVE") {
      throw unauthorized();
    }
    if (session.user.role === "PLATFORM_ADMIN") {
      this.assertCanonicalPlatformAdmin(session.user);
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

    this.setRefreshCookie(reply, nextRefresh);
    return {
      user: this.toAuthUser(session.user),
      accessToken: await this.tokens.signAccessToken(requestUser)
    };
  }

  /**
   * Revokes the current session and clears the refresh cookie.
   */
  public async logout(request: FastifyRequest, reply: FastifyReply): Promise<{ success: true }> {
    if (request.user) {
      await this.prisma.session.updateMany({
        where: { id: request.user.sessionId, userId: request.user.id },
        data: { revokedAt: new Date() }
      });
      await this.audit.record({
        workspaceId: request.user.workspaceId,
        actorId: request.user.id,
        action: "auth.logout",
        metadata: { sessionId: request.user.sessionId },
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"]
      });
    }

    reply.clearCookie(refreshCookieName, this.cookieOptions());
    return { success: true };
  }

  /**
   * Revokes one of the current user's sessions.
   */
  public async revokeSession(request: FastifyRequest, sessionId: string): Promise<{ success: true }> {
    if (!request.user) {
      throw unauthorized();
    }
    await this.prisma.session.updateMany({
      where: { id: sessionId, userId: request.user.id },
      data: { revokedAt: new Date() }
    });
    await this.audit.record({
      workspaceId: request.user.workspaceId,
      actorId: request.user.id,
      action: "auth.session.revoke",
      metadata: { revokedSessionId: sessionId, sessionId: request.user.sessionId },
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"]
    });
    return { success: true };
  }

  /**
   * Revokes every session for the current user, including the current device.
   */
  public async revokeAllSessions(request: FastifyRequest, reply: FastifyReply): Promise<{ success: true }> {
    if (!request.user) {
      throw unauthorized();
    }
    await this.prisma.session.updateMany({
      where: { userId: request.user.id, revokedAt: null },
      data: { revokedAt: new Date() }
    });
    await this.audit.record({
      workspaceId: request.user.workspaceId,
      actorId: request.user.id,
      action: "auth.sessions.revoke_all",
      metadata: { sessionId: request.user.sessionId },
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"]
    });
    reply.clearCookie(refreshCookieName, this.cookieOptions());
    return { success: true };
  }

  /**
   * Loads the authenticated user and their tracked sessions.
   */
  public async me(user: RequestUser): Promise<MeResponse> {
    const sessions = await this.prisma.session.findMany({
      where: { userId: user.id },
      orderBy: { lastSeenAt: "desc" },
      take: 20
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        workspaceId: user.workspaceId
      },
      sessions: sessions.map(this.toSessionDto)
    };
  }

  /**
   * Verifies a bearer access token and ensures the referenced session is active.
   */
  public async authenticate(accessToken: string): Promise<RequestUser> {
    const user = await this.tokens.verifyAccessToken(accessToken);
    const session = await this.prisma.session.findUnique({
      where: { id: user.sessionId },
      include: { user: { include: { platformAdmin: true } } }
    });
    if (!session || session.revokedAt || session.expiresAt <= new Date()) {
      throw unauthorized();
    }
    if (session.userId !== user.id || session.user.status !== "ACTIVE") {
      throw unauthorized();
    }
    if (session.user.role === "PLATFORM_ADMIN") {
      this.assertCanonicalPlatformAdmin(session.user);
    }
    return user;
  }

  private setRefreshCookie(reply: FastifyReply, token: string): void {
    reply.setCookie(refreshCookieName, token, this.cookieOptions());
  }

  private cookieOptions() {
    const options = {
      httpOnly: true,
      secure: this.env.COOKIE_SECURE,
      sameSite: "lax" as const,
      path: "/api/auth",
      maxAge: this.env.REFRESH_TOKEN_TTL_SECONDS
    };

    return this.env.COOKIE_DOMAIN === "localhost" ? options : { ...options, domain: this.env.COOKIE_DOMAIN };
  }

  private toRequestUser(user: UserRecord, sessionId: string): RequestUser {
    return {
      id: user.id,
      email: user.email ?? user.username ?? user.id,
      name: user.name,
      role: user.role,
      workspaceId: user.workspaceId,
      sessionId
    };
  }

  private toAuthUser(user: UserRecord) {
    return {
      id: user.id,
      email: user.email ?? user.username ?? user.id,
      name: user.name,
      role: user.role,
      workspaceId: user.workspaceId
    };
  }

  private assertCanonicalPlatformAdmin(user: UserRecord): void {
    if (!user.platformAdmin) {
      throw new AppError(500, "ORPHAN_PLATFORM_ADMIN", "Orphan Platform Admin identity is not allowed");
    }
  }

  private toSessionDto(session: {
    id: string;
    deviceName: string;
    ipAddress: string;
    userAgent: string;
    lastSeenAt: Date;
    expiresAt: Date;
    revokedAt: Date | null;
  }): SessionDto {
    return {
      id: session.id,
      deviceName: session.deviceName,
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
      lastSeenAt: session.lastSeenAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
      revokedAt: session.revokedAt?.toISOString() ?? null
    };
  }

  private deviceName(userAgent: string | undefined): string {
    if (!userAgent) {
      return "Unknown device";
    }
    return userAgent.slice(0, 160);
  }
}
