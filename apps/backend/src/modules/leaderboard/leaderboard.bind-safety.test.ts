import { describe, expect, it } from "vitest";
import type { RequestUser } from "../auth/auth.types";
import { LeaderboardApiService } from "./leaderboard.api-service";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const coadminA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const coadminB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const player1 = "c1111111-cccc-4ccc-8ccc-cccccccccccc";
const player2 = "c2222222-cccc-4ccc-8ccc-cccccccccccc";
const player3 = "c3333333-cccc-4ccc-8ccc-cccccccccccc";
const sessionId = "55555555-5555-4555-8555-555555555555";

const coadminUser: RequestUser = {
  id: coadminA,
  email: "a@example.com",
  name: "Coadmin A",
  role: "COADMIN",
  workspaceId,
  sessionId
};

function makeBindHarness(options?: {
  readonly existingEnabled?: boolean;
  readonly existingPoolRateBps?: number;
  readonly bSettings?: { enabled: boolean; poolRateBps: number };
}) {
  const settingsStore = new Map<
    string,
    { workspaceId: string; ownerCoadminUserId: string; enabled: boolean; poolRateBps: number }
  >();
  if (options?.existingEnabled !== undefined) {
    settingsStore.set(coadminA, {
      workspaceId,
      ownerCoadminUserId: coadminA,
      enabled: options.existingEnabled,
      poolRateBps: options.existingPoolRateBps ?? 200
    });
  }
  if (options?.bSettings) {
    settingsStore.set(coadminB, {
      workspaceId,
      ownerCoadminUserId: coadminB,
      enabled: options.bSettings.enabled,
      poolRateBps: options.bSettings.poolRateBps
    });
  }

  const participants: Array<{
    workspaceId: string;
    ownerCoadminUserId: string;
    crmContactId: string;
  }> = [];

  const domain = {
    ensureSettings: async (ws: string, owner: string) => {
      const existing = settingsStore.get(owner);
      if (existing) {
        if (existing.workspaceId !== ws) throw new Error("owner mismatch");
        return existing;
      }
      const created = {
        workspaceId: ws,
        ownerCoadminUserId: owner,
        enabled: false,
        poolRateBps: 200
      };
      settingsStore.set(owner, created);
      return created;
    },
    setEnabled: async () => {
      throw new Error("setEnabled must not be called during bind");
    },
    bindParticipant: async (input: {
      workspaceId: string;
      ownerCoadminUserId: string;
      crmContactId: string;
      createdByUserId?: string;
    }) => {
      participants.push({
        workspaceId: input.workspaceId,
        ownerCoadminUserId: input.ownerCoadminUserId,
        crmContactId: input.crmContactId
      });
      return {
        crmContactId: input.crmContactId,
        ownerCoadminUserId: input.ownerCoadminUserId
      };
    }
  };

  const service = new LeaderboardApiService({ prisma: {} } as never);
  (service as unknown as { domain: typeof domain }).domain = domain;

  return { service, settingsStore, participants };
}

describe("Phase 2 safety: bind does not enable leaderboard", () => {
  it("binding a player creates/keeps settings disabled", async () => {
    const { service, settingsStore } = makeBindHarness();
    await service.bindParticipant(coadminUser, player1);
    expect(settingsStore.get(coadminA)?.enabled).toBe(false);
  });

  it("binding second and third players does not enable", async () => {
    const { service, settingsStore } = makeBindHarness();
    await service.bindParticipant(coadminUser, player1);
    await service.bindParticipant(coadminUser, player2);
    await service.bindParticipant(coadminUser, player3);
    expect(settingsStore.get(coadminA)?.enabled).toBe(false);
  });

  it("existing disabled settings stay disabled after bind", async () => {
    const { service, settingsStore } = makeBindHarness({
      existingEnabled: false,
      existingPoolRateBps: 300
    });
    await service.bindParticipant(coadminUser, player1);
    expect(settingsStore.get(coadminA)?.enabled).toBe(false);
    expect(settingsStore.get(coadminA)?.poolRateBps).toBe(300);
  });

  it("does not affect another Coadmin settings", async () => {
    const { service, settingsStore } = makeBindHarness({
      bSettings: { enabled: true, poolRateBps: 500 }
    });
    await service.bindParticipant(coadminUser, player1);
    expect(settingsStore.get(coadminA)?.enabled).toBe(false);
    expect(settingsStore.get(coadminB)?.enabled).toBe(true);
    expect(settingsStore.get(coadminB)?.poolRateBps).toBe(500);
  });
});
