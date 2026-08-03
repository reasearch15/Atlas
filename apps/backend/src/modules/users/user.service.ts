import bcrypt from "bcryptjs";
import type { PrismaClient } from "@prisma/client";
import { createStaffSchema, isPlatformRole } from "@atlas/shared";
import { forbidden } from "../../utils/errors";
import type { RequestUser } from "../auth/auth.types";
import { AuditService } from "../audit/audit.service";

export class UserService {
  private readonly prisma: PrismaClient;
  private readonly audit: AuditService;

  /**
   * Creates a user service with database and audit dependencies.
   */
  public constructor(prisma: PrismaClient) {
    this.prisma = prisma;
    this.audit = new AuditService(prisma);
  }

  /**
   * Lists users inside the current tenant unless the actor is a platform administrator.
   */
  public async list(actor: RequestUser) {
    return this.prisma.user.findMany({
      where: isPlatformRole(actor.role) ? {} : { workspaceId: actor.workspaceId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        status: true,
        workspaceId: true,
        createdAt: true
      }
    });
  }

  /**
   * Creates a tenant user in the actor's workspace.
   */
  public async createStaff(actor: RequestUser, body: unknown, ipAddress: string, userAgent?: string) {
    if (!actor.workspaceId || actor.role === "STAFF") {
      throw forbidden();
    }
    const input = createStaffSchema.parse(body);
    const user = await this.prisma.user.create({
      data: {
        email: input.email,
        name: input.name,
        role: input.role,
        workspaceId: actor.workspaceId,
        passwordHash: await bcrypt.hash(input.password, 12)
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        status: true,
        workspaceId: true,
        createdAt: true
      }
    });

    await this.audit.record({
      workspaceId: actor.workspaceId,
      actorId: actor.id,
      action: "staff.create",
      metadata: { userId: user.id, role: user.role },
      ipAddress,
      userAgent
    });

    return user;
  }
}
