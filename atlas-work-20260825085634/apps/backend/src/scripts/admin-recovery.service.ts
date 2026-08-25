import bcrypt from "bcryptjs";
import type { PlatformAdminStatus, PrismaClient } from "@prisma/client";
import { emailSchema, passwordSchema } from "@atlas/shared";

export interface AdminSummary {
  readonly id: string;
  readonly email: string;
  readonly status: PlatformAdminStatus;
  readonly createdAt: Date;
  readonly lastLoginAt: Date | null;
}

export interface ResetAdminCredentialsInput {
  readonly email?: string;
  readonly password: string;
}

export interface ResetAdminCredentialsResult {
  readonly adminId: string;
  readonly email: string;
  readonly revokedSessionCount: number;
  readonly revokedTrustedDeviceCount: number;
  readonly consumedChallengeCount: number;
}

type RecoveryPrismaClient = Pick<
  PrismaClient,
  "platformAdmin" | "user" | "session" | "adminTrustedDevice" | "adminLoginChallenge" | "auditLog" | "$transaction"
>;

/**
 * Loads the single existing Platform Admin without exposing any secret-bearing fields.
 */
export async function loadPlatformAdminSummary(prisma: RecoveryPrismaClient): Promise<AdminSummary> {
  const admins = await prisma.platformAdmin.findMany({
    select: {
      id: true,
      email: true,
      status: true,
      createdAt: true,
      lastLoginAt: true
    },
    orderBy: { createdAt: "asc" },
    take: 2
  });

  if (admins.length === 0) {
    throw new Error("No Platform Admin exists. Run pnpm admin:create first.");
  }
  if (admins.length > 1) {
    throw new Error("More than one Platform Admin exists. Manual database review is required.");
  }

  return admins[0]!;
}

/**
 * Resets the existing Platform Admin credentials and invalidates every admin credential-dependent artifact.
 */
export async function resetPlatformAdminCredentials(
  prisma: RecoveryPrismaClient,
  input: ResetAdminCredentialsInput
): Promise<ResetAdminCredentialsResult> {
  const normalizedEmail = input.email ? emailSchema.parse(input.email) : undefined;
  const password = passwordSchema.parse(input.password);
  const admins = await prisma.platformAdmin.findMany({
    include: { user: true },
    orderBy: { createdAt: "asc" },
    take: 2
  });

  if (admins.length === 0) {
    throw new Error("No Platform Admin exists. Run pnpm admin:create first.");
  }
  if (admins.length > 1) {
    throw new Error("More than one Platform Admin exists. Reset aborted.");
  }

  const admin = admins[0]!;
  const email = normalizedEmail ?? admin.email;
  const passwordHash = await bcrypt.hash(password, 12);
  const now = new Date();

  const result = await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: admin.userId },
      data: {
        email,
        passwordHash,
        updatedAt: now
      }
    });
    await tx.platformAdmin.update({
      where: { id: admin.id },
      data: {
        email,
        passwordHash,
        passwordChangedAt: now,
        updatedAt: now
      }
    });
    const sessions = await tx.session.updateMany({
      where: { userId: admin.userId, revokedAt: null },
      data: { revokedAt: now }
    });
    const devices = await tx.adminTrustedDevice.updateMany({
      where: { adminId: admin.id, revokedAt: null },
      data: { revokedAt: now }
    });
    const challenges = await tx.adminLoginChallenge.updateMany({
      where: { adminId: admin.id, consumedAt: null },
      data: { consumedAt: now }
    });
    await tx.auditLog.create({
      data: {
        workspaceId: null,
        actorId: admin.userId,
        action: "ADMIN_CREDENTIALS_RESET",
        metadata: {
          emailChanged: email !== admin.email,
          revokedSessionCount: sessions.count,
          revokedTrustedDeviceCount: devices.count,
          consumedChallengeCount: challenges.count
        }
      }
    });

    return {
      adminId: admin.id,
      email,
      revokedSessionCount: sessions.count,
      revokedTrustedDeviceCount: devices.count,
      consumedChallengeCount: challenges.count
    };
  });

  return result;
}
