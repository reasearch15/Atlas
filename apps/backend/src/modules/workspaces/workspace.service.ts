import type { PrismaClient } from "@prisma/client";
import { createWorkspaceSchema, isPlatformRole } from "@atlas/shared";
import { forbidden } from "../../utils/errors";
import type { RequestUser } from "../auth/auth.types";

export class WorkspaceService {
  private readonly prisma: PrismaClient;

  /**
   * Creates a workspace service with a database dependency.
   */
  public constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Lists all workspaces for platform administrators and the current workspace for tenant users.
   */
  public async list(user: RequestUser) {
    const where = isPlatformRole(user.role) ? {} : { id: user.workspaceId ?? "" };
    return this.prisma.workspace.findMany({
      where,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        slug: true,
        createdAt: true,
        _count: { select: { users: true, sessions: true } }
      }
    });
  }

  /**
   * Creates a workspace; only platform administrators may cross tenant boundaries.
   */
  public async create(user: RequestUser, body: unknown) {
    if (!isPlatformRole(user.role)) {
      throw forbidden();
    }
    const input = createWorkspaceSchema.parse(body);
    return this.prisma.workspace.create({ data: input });
  }
}
