import type { Prisma, PrismaClient } from "@prisma/client";

interface AuditInput {
  readonly workspaceId: string | null;
  readonly actorId: string | null;
  readonly action: string;
  readonly metadata?: Prisma.InputJsonObject;
  readonly ipAddress?: string | undefined;
  readonly userAgent?: string | undefined;
}

export class AuditService {
  private readonly prisma: PrismaClient;

  /**
   * Creates an audit service backed by Prisma.
   */
  public constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Persists an immutable audit event.
   */
  public async record(input: AuditInput): Promise<void> {
    const data: Prisma.AuditLogUncheckedCreateInput = {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      action: input.action,
      metadata: input.metadata ?? {}
    };
    if (input.ipAddress) {
      data.ipAddress = input.ipAddress;
    }
    if (input.userAgent) {
      data.userAgent = input.userAgent;
    }

    await this.prisma.auditLog.create({
      data
    });
  }
}
