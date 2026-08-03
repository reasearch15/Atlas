import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import type { Env } from "../../config/env";
import { accessTokenExpired, unauthorized } from "../../utils/errors";
import type { RequestUser } from "./auth.types";

interface TokenPayload {
  readonly sub: string;
  readonly sid: string;
  readonly email: string;
  readonly name: string;
  readonly role: RequestUser["role"];
  readonly workspaceId: string | null;
}

function isJwtExpiredError(error: unknown): boolean {
  if (error instanceof joseErrors.JWTExpired) return true;
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ERR_JWT_EXPIRED";
}

export class TokenService {
  private readonly accessSecret: Uint8Array;
  private readonly refreshSecret: Uint8Array;
  private readonly env: Env;

  /**
   * Creates a token service using separate access and refresh signing secrets.
   */
  public constructor(env: Env) {
    this.env = env;
    this.accessSecret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
    this.refreshSecret = new TextEncoder().encode(env.JWT_REFRESH_SECRET);
  }

  /**
   * Signs a short-lived access token for API authorization.
   */
  public async signAccessToken(user: RequestUser): Promise<string> {
    return new SignJWT({
      sid: user.sessionId,
      email: user.email,
      name: user.name,
      role: user.role,
      workspaceId: user.workspaceId
    })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(user.id)
      .setIssuedAt()
      .setExpirationTime(`${this.env.ACCESS_TOKEN_TTL_SECONDS}s`)
      .sign(this.accessSecret);
  }

  /**
   * Signs a long-lived refresh token bound to a persisted session.
   */
  public async signRefreshToken(user: RequestUser): Promise<string> {
    return new SignJWT({ sid: user.sessionId })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(user.id)
      .setIssuedAt()
      .setExpirationTime(`${this.env.REFRESH_TOKEN_TTL_SECONDS}s`)
      .sign(this.refreshSecret);
  }

  /**
   * Verifies an access token and returns the authenticated request user.
   * Expired tokens become 401 ACCESS_TOKEN_EXPIRED (never an unhandled 500).
   */
  public async verifyAccessToken(token: string): Promise<RequestUser> {
    try {
      const { payload } = await jwtVerify(token, this.accessSecret);
      const typed = payload as unknown as TokenPayload;
      return {
        id: String(payload.sub),
        sessionId: typed.sid,
        email: typed.email,
        name: typed.name,
        role: typed.role,
        workspaceId: typed.workspaceId
      };
    } catch (error) {
      if (isJwtExpiredError(error)) {
        throw accessTokenExpired();
      }
      throw unauthorized("Invalid access token");
    }
  }

  /**
   * Verifies a refresh token and returns the persisted session identifier.
   */
  public async verifyRefreshToken(token: string): Promise<{ userId: string; sessionId: string }> {
    try {
      const { payload } = await jwtVerify(token, this.refreshSecret);
      return {
        userId: String(payload.sub),
        sessionId: String(payload.sid)
      };
    } catch {
      throw unauthorized("Invalid refresh token");
    }
  }
}
