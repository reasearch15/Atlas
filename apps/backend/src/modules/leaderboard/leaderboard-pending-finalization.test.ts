import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { LeaderboardApiService } from "./leaderboard.api-service";
import type { RequestUser } from "../auth/auth.types";

const workspaceA = "11111111-1111-4111-8111-111111111111";
const workspaceB = "22222222-2222-4222-8222-222222222222";
const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const frozenId = "c1111111-cccc-4ccc-8ccc-ccccccccccc1";

function user(workspaceId: string): RequestUser {
  return {
    id: ownerA,
    email: "owner@example.com",
    name: "Owner",
    role: "COADMIN",
    workspaceId,
    sessionId: "session-1"
  };
}

function serviceFor(store: {
  competitions: Array<Record<string, unknown>>;
  enqueue: ReturnType<typeof vi.fn>;
}) {
  const prisma = {
    leaderboardCompetition: {
      findMany: async ({ where }: { where: { workspaceId: string; ownerCoadminUserId: string } }) =>
        store.competitions.filter(
          (row) => row.workspaceId === where.workspaceId && row.ownerCoadminUserId === where.ownerCoadminUserId
        ),
      findFirst: async ({ where }: { where: { id: string; workspaceId: string; ownerCoadminUserId: string } }) =>
        store.competitions.find(
          (row) =>
            row.id === where.id &&
            row.workspaceId === where.workspaceId &&
            row.ownerCoadminUserId === where.ownerCoadminUserId
        ) ?? null
    },
    giveawayEligibilityCandidate: {
      findMany: async ({ where }: { where: { workspaceId: string; competitionId: string } }) => {
        if (where.workspaceId !== workspaceA || where.competitionId !== frozenId) return [];
        return [
          {
            leaderboardRank: 3,
            verificationErrorCode: "400",
            verificationErrorMessage: "Bad Request: member not found"
          }
        ];
      }
    },
    leaderboardTelegramOutbox: {
      findFirst: async ({ where }: { where: { workspaceId: string; competitionId: string } }) => {
        if (where.workspaceId !== workspaceA || where.competitionId !== frozenId) return null;
        return {
          status: "FAILED",
          attemptCount: 12,
          lastErrorCode: "MEMBERSHIP_UNRESOLVED",
          lastErrorMessage: "Membership is still unresolved"
        };
      }
    }
  };
  const app = {
    prisma,
    leaderboardTelegramOutbox: { enqueueVerifyMembership: store.enqueue }
  };
  return new LeaderboardApiService(app as unknown as FastifyInstance);
}

describe("pending leaderboard finalizations", () => {
  it("shows a frozen round to its owner after another workspace cannot see it", async () => {
    const store = {
      competitions: [
        {
          id: frozenId,
          workspaceId: workspaceA,
          ownerCoadminUserId: ownerA,
          sequence: 74,
          status: "FROZEN",
          endsAt: new Date("2026-11-18T03:00:00.000Z"),
          bonusDrawStatus: "PENDING"
        }
      ],
      enqueue: vi.fn(async () => "job-1")
    };
    const api = serviceFor(store);
    const visible = await api.listPendingFinalizations(user(workspaceA));
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({
      competitionId: frozenId,
      status: "FROZEN",
      verificationStatus: "FAILED",
      attemptCount: 12,
      lastVerificationError: "Membership is still unresolved"
    });
    expect(visible[0]?.unresolvedRanks.map((rank) => rank.rank)).toEqual([3]);
    await expect(api.listPendingFinalizations(user(workspaceB))).resolves.toEqual([]);
  });

  it("retries the frozen competition id and rejects another workspace", async () => {
    const store = {
      competitions: [
        {
          id: frozenId,
          workspaceId: workspaceA,
          ownerCoadminUserId: ownerA,
          sequence: 74,
          status: "FROZEN",
          endsAt: new Date("2026-11-18T03:00:00.000Z"),
          bonusDrawStatus: "PENDING"
        }
      ],
      enqueue: vi.fn(async () => "job-1")
    };
    const api = serviceFor(store);
    await expect(api.enqueueVerifyMembership(user(workspaceA), frozenId)).resolves.toMatchObject({
      competitionId: frozenId,
      jobId: "job-1"
    });
    expect(store.enqueue).toHaveBeenCalledWith(workspaceA, ownerA, frozenId);
    await expect(api.enqueueVerifyMembership(user(workspaceB), frozenId)).rejects.toMatchObject({
      statusCode: 404
    });
  });

  it("allows verification retry for a finalized competition whose freeplay draw is pending", async () => {
    const store = {
      competitions: [
        {
          id: frozenId,
          workspaceId: workspaceA,
          ownerCoadminUserId: ownerA,
          sequence: 74,
          status: "FINALIZED",
          endsAt: new Date("2026-11-18T03:00:00.000Z"),
          bonusDrawStatus: "PENDING"
        }
      ],
      enqueue: vi.fn(async () => "job-2")
    };
    const api = serviceFor(store);
    await expect(api.enqueueVerifyMembership(user(workspaceA), frozenId)).resolves.toMatchObject({ jobId: "job-2" });
    const listed = await api.listPendingFinalizations(user(workspaceA));
    expect(listed.map((row) => row.competitionId)).toEqual([frozenId]);
  });
});
