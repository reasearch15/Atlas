import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  FreeplayPlayerStatus,
  FreeplayPlayerStatusDto,
  FreeplaySpinResultDto,
  FreeplayStaffClaimDto,
  FreeplayStaffStatusDto
} from "@atlas/shared";
import { randomUUID } from "node:crypto";
import type { RequestUser } from "../auth/auth.types";
import { AppError, forbidden } from "../../utils/errors";
import { toFreeplayPlayerStatusDto } from "./freeplay.messages";

type Db = PrismaClient | Prisma.TransactionClient;

const FREEPLAY_THRESHOLD_CENTS = 5_000;
const FREEPLAY_MAX_SPINS_PER_WINDOW = 2;
const FREEPLAY_ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REWARD_DISTRIBUTION: readonly { readonly amountCents: number; readonly weight: number }[] = [
  { amountCents: 0, weight: 1 },
  { amountCents: 100, weight: 1 },
  { amountCents: 200, weight: 1 },
  { amountCents: 300, weight: 1 }
];

interface BalanceRow {
  id: string;
  workspaceId: string;
  ownerCoadminUserId: string;
  crmContactId: string;
  qualifyingRemainderCents: number;
  earnedSpinCredits: number;
  consumedSpinCredits: number;
}

interface SpinWindowRow {
  spunAt: Date;
}

interface ClaimRow {
  id: string;
  spinId: string;
  crmContactId: string;
  chatId: string | null;
  rewardAmountCents: number;
  status: "UNCLAIMED" | "CLAIMED";
  createdAt: Date;
  claimedAt: Date | null;
  claimedByUserId: string | null;
  claimedByName: string | null;
  fulfillmentNote: string | null;
}

export class FreeplayService {
  public constructor(private readonly app: { readonly prisma: PrismaClient }) {}

  public async applyLeaderboardDepositEvent(input: {
    readonly eventId: string;
    readonly workspaceId: string;
    readonly ownerCoadminUserId: string;
    readonly crmContactId: string;
    readonly amountCents: number;
    readonly occurredAt: Date;
  }): Promise<void> {
    if (input.amountCents === 0) return;
    await this.app.prisma.$transaction(async (tx) => {
      const inserted = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO freeplay_deposit_credits (
          workspace_id,
          owner_coadmin_user_id,
          crm_contact_id,
          leaderboard_event_id,
          amount_cents,
          occurred_at
        )
        VALUES (
          ${input.workspaceId}::uuid,
          ${input.ownerCoadminUserId}::uuid,
          ${input.crmContactId}::uuid,
          ${input.eventId}::uuid,
          ${input.amountCents},
          ${input.occurredAt}
        )
        ON CONFLICT (leaderboard_event_id) DO NOTHING
        RETURNING id
      `;
      if (inserted.length === 0) return;

      const balance = await this.lockBalance(tx, input.workspaceId, input.ownerCoadminUserId, input.crmContactId);
      await this.recomputeBalanceFromDepositCredits(tx, balance);
    });
  }

  public async getPlayerStatus(user: RequestUser, crmContactId: string): Promise<FreeplayPlayerStatusDto> {
    const workspaceId = this.requireWorkspaceId(user);
    const owner = await this.resolveOwner(workspaceId, crmContactId);
    const status = await this.computeStatus(this.app.prisma, workspaceId, owner, crmContactId, new Date());
    return toFreeplayPlayerStatusDto({
      status: status.playerStatus,
      nextAvailableAt: status.nextAvailableAt
    });
  }

  public async getTrustedPlayerStatus(input: {
    readonly workspaceId: string;
    readonly ownerCoadminUserId: string;
    readonly crmContactId: string;
    readonly now?: Date;
  }): Promise<FreeplayPlayerStatusDto> {
    const status = await this.computeStatus(
      this.app.prisma,
      input.workspaceId,
      input.ownerCoadminUserId,
      input.crmContactId,
      input.now ?? new Date()
    );
    return toFreeplayPlayerStatusDto({
      status: status.playerStatus,
      nextAvailableAt: status.nextAvailableAt
    });
  }

  public async getStaffStatusForContact(user: RequestUser, crmContactId: string): Promise<FreeplayStaffStatusDto> {
    const workspaceId = this.requireWorkspaceId(user);
    const owner = await this.resolveOwner(workspaceId, crmContactId);
    await this.assertActorMaySeeOwner(user, owner);
    return this.getStaffStatusByOwner(workspaceId, owner, crmContactId, new Date());
  }

  public async getStaffStatusForPanel(
    user: RequestUser,
    workspaceId: string,
    ownerCoadminUserId: string,
    crmContactId: string
  ): Promise<FreeplayStaffStatusDto> {
    await this.assertActorMaySeeOwner(user, ownerCoadminUserId);
    return this.getStaffStatusByOwner(workspaceId, ownerCoadminUserId, crmContactId, new Date());
  }

  public async spin(user: RequestUser, input: {
    readonly crmContactId: string;
    readonly chatId?: string | null;
    readonly idempotencyKey: string;
  }): Promise<FreeplaySpinResultDto> {
    const workspaceId = this.requireWorkspaceId(user);
    const owner = await this.resolveOwner(workspaceId, input.crmContactId);
    await this.assertActorMaySeeOwner(user, owner);
    return this.spinTrusted({
      workspaceId,
      ownerCoadminUserId: owner,
      crmContactId: input.crmContactId,
      actorUserId: user.id,
      idempotencyKey: input.idempotencyKey,
      ...(input.chatId !== undefined ? { chatId: input.chatId } : {})
    });
  }

  public async spinTrusted(input: {
    readonly workspaceId: string;
    readonly ownerCoadminUserId: string;
    readonly crmContactId: string;
    readonly actorUserId: string;
    readonly chatId?: string | null;
    readonly idempotencyKey: string;
    readonly now?: Date;
  }): Promise<FreeplaySpinResultDto> {
    const now = input.now ?? new Date();
    const result = await this.app.prisma.$transaction(async (tx) => {
      const replay = await tx.$queryRaw<Array<{
        id: string;
        rewardAmountCents: number;
        claimId: string | null;
      }>>`
        SELECT id, reward_amount_cents AS "rewardAmountCents", claim_id AS "claimId"
        FROM freeplay_wheel_spins
        WHERE idempotency_key = ${input.idempotencyKey}
        LIMIT 1
      `;
      if (replay[0]) {
        return { ...replay[0], replay: true };
      }

      const balance = await this.lockBalance(tx, input.workspaceId, input.ownerCoadminUserId, input.crmContactId);
      const windowRows = await this.spinsInWindow(tx, input.ownerCoadminUserId, input.crmContactId, now);
      const availableEconomicCredits = balance.earnedSpinCredits - balance.consumedSpinCredits;
      if (availableEconomicCredits <= 0) {
        throw new AppError(409, "FREEPLAY_NOT_ELIGIBLE", "No freeplay available.");
      }
      if (windowRows.length >= FREEPLAY_MAX_SPINS_PER_WINDOW) {
        throw new AppError(409, "FREEPLAY_ROLLING_LIMIT", "Freeplay Wheel rolling limit reached.");
      }

      const rewardAmountCents = selectRewardAmountCents();
      const spinId = randomUUID();
      const claimId = rewardAmountCents > 0 ? randomUUID() : null;
      await tx.$executeRaw`
        UPDATE freeplay_player_balances
        SET consumed_spin_credits = consumed_spin_credits + 1,
            updated_at = NOW()
        WHERE id = ${balance.id}::uuid
      `;
      await tx.$executeRaw`
        INSERT INTO freeplay_wheel_spins (
          id,
          workspace_id,
          owner_coadmin_user_id,
          crm_contact_id,
          chat_id,
          reward_amount_cents,
          idempotency_key,
          spun_at,
          claim_id,
          rng_meta_json
        )
        VALUES (
          ${spinId}::uuid,
          ${input.workspaceId}::uuid,
          ${input.ownerCoadminUserId}::uuid,
          ${input.crmContactId}::uuid,
          ${input.chatId ?? null}::uuid,
          ${rewardAmountCents},
          ${input.idempotencyKey},
          ${now},
          NULL,
          ${JSON.stringify({ source: "crypto", configured: "default", rewardAmountCents })}::jsonb
        )
      `;
      if (claimId) {
        await tx.$executeRaw`
          INSERT INTO freeplay_claims (
            id,
            workspace_id,
            owner_coadmin_user_id,
            crm_contact_id,
            chat_id,
            spin_id,
            reward_amount_cents,
            status
          )
          VALUES (
            ${claimId}::uuid,
            ${input.workspaceId}::uuid,
            ${input.ownerCoadminUserId}::uuid,
            ${input.crmContactId}::uuid,
            ${input.chatId ?? null}::uuid,
            ${spinId}::uuid,
            ${rewardAmountCents},
            'UNCLAIMED'
          )
        `;
        await tx.$executeRaw`
          UPDATE freeplay_wheel_spins
          SET claim_id = ${claimId}::uuid
          WHERE id = ${spinId}::uuid
        `;
      }
      return { id: spinId, rewardAmountCents, claimId, replay: false };
    });

    const playerStatus = await this.getTrustedPlayerStatus({
      workspaceId: input.workspaceId,
      ownerCoadminUserId: input.ownerCoadminUserId,
      crmContactId: input.crmContactId
    });
    return {
      playerStatus,
      spinId: result.id,
      rewardAmountCents: result.rewardAmountCents,
      claimId: result.claimId,
      replay: result.replay
    };
  }

  public async claim(user: RequestUser, claimId: string, fulfillmentNote?: string): Promise<FreeplayStaffClaimDto> {
    const workspaceId = this.requireWorkspaceId(user);
    const claim = await this.app.prisma.$transaction(async (tx) => {
      const existing = await tx.$queryRaw<Array<{ ownerCoadminUserId: string }>>`
        SELECT owner_coadmin_user_id AS "ownerCoadminUserId"
        FROM freeplay_claims
        WHERE id = ${claimId}::uuid AND workspace_id = ${workspaceId}::uuid
      `;
      if (!existing[0]) throw new AppError(404, "FREEPLAY_CLAIM_NOT_FOUND", "Freeplay claim was not found.");
      await this.assertActorMaySeeOwner(user, existing[0].ownerCoadminUserId);

      const updated = await tx.$queryRaw<ClaimRow[]>`
        UPDATE freeplay_claims
        SET status = 'CLAIMED',
            claimed_at = NOW(),
            claimed_by_user_id = ${user.id}::uuid,
            fulfillment_note = ${fulfillmentNote ?? null},
            updated_at = NOW()
        WHERE id = ${claimId}::uuid
          AND workspace_id = ${workspaceId}::uuid
          AND status = 'UNCLAIMED'
        RETURNING id,
          spin_id AS "spinId",
          crm_contact_id AS "crmContactId",
          chat_id AS "chatId",
          reward_amount_cents AS "rewardAmountCents",
          status,
          created_at AS "createdAt",
          claimed_at AS "claimedAt",
          claimed_by_user_id AS "claimedByUserId",
          NULL::text AS "claimedByName",
          fulfillment_note AS "fulfillmentNote"
      `;
      if (!updated[0]) {
        throw new AppError(409, "FREEPLAY_CLAIM_ALREADY_CLAIMED", "This Freeplay reward has already been claimed.");
      }
      return updated[0];
    });
    return this.toClaimDto({ ...claim, claimedByName: user.name });
  }

  private async getStaffStatusByOwner(
    workspaceId: string,
    ownerCoadminUserId: string,
    crmContactId: string,
    now: Date
  ): Promise<FreeplayStaffStatusDto> {
    const internal = await this.computeStatus(this.app.prisma, workspaceId, ownerCoadminUserId, crmContactId, now);
    const claims = await this.loadClaims(this.app.prisma, workspaceId, ownerCoadminUserId, crmContactId);
    return { ...internal, claims };
  }

  private async computeStatus(
    db: Db,
    workspaceId: string,
    ownerCoadminUserId: string,
    crmContactId: string,
    now: Date
  ): Promise<Omit<FreeplayStaffStatusDto, "claims">> {
    const balance = await this.ensureBalance(db, workspaceId, ownerCoadminUserId, crmContactId);
    const windowRows = await this.spinsInWindow(db, ownerCoadminUserId, crmContactId, now);
    const availableEconomicCredits = Math.max(0, balance.earnedSpinCredits - balance.consumedSpinCredits);
    const nextAvailableAt =
      availableEconomicCredits > 0 && windowRows.length >= FREEPLAY_MAX_SPINS_PER_WINDOW
        ? new Date(windowRows[0]!.spunAt.getTime() + FREEPLAY_ROLLING_WINDOW_MS).toISOString()
        : null;
    const playerStatus: FreeplayPlayerStatus =
      availableEconomicCredits <= 0
        ? "NOT_ELIGIBLE"
        : windowRows.length >= FREEPLAY_MAX_SPINS_PER_WINDOW
          ? "ROLLING_LIMIT"
          : "ELIGIBLE";
    return {
      eligible: playerStatus === "ELIGIBLE",
      playerStatus,
      thresholdCents: FREEPLAY_THRESHOLD_CENTS,
      qualifyingRemainderCents: balance.qualifyingRemainderCents,
      earnedSpinCredits: balance.earnedSpinCredits,
      consumedSpinCredits: balance.consumedSpinCredits,
      availableEconomicCredits,
      spinsInRollingWindow: windowRows.length,
      maxSpinsPerWindow: FREEPLAY_MAX_SPINS_PER_WINDOW,
      nextAvailableAt,
      eligibilityReason:
        playerStatus === "ELIGIBLE"
          ? "ELIGIBLE"
          : playerStatus === "ROLLING_LIMIT"
            ? "ROLLING_LIMIT"
            : "NO_EARNED_CREDIT"
    };
  }

  private async ensureBalance(db: Db, workspaceId: string, ownerCoadminUserId: string, crmContactId: string): Promise<BalanceRow> {
    await db.$executeRaw`
      INSERT INTO freeplay_player_balances (workspace_id, owner_coadmin_user_id, crm_contact_id)
      VALUES (${workspaceId}::uuid, ${ownerCoadminUserId}::uuid, ${crmContactId}::uuid)
      ON CONFLICT (owner_coadmin_user_id, crm_contact_id) DO NOTHING
    `;
    const rows = await db.$queryRaw<BalanceRow[]>`
      SELECT id,
        workspace_id AS "workspaceId",
        owner_coadmin_user_id AS "ownerCoadminUserId",
        crm_contact_id AS "crmContactId",
        qualifying_remainder_cents AS "qualifyingRemainderCents",
        earned_spin_credits AS "earnedSpinCredits",
        consumed_spin_credits AS "consumedSpinCredits"
      FROM freeplay_player_balances
      WHERE owner_coadmin_user_id = ${ownerCoadminUserId}::uuid
        AND crm_contact_id = ${crmContactId}::uuid
        AND workspace_id = ${workspaceId}::uuid
      LIMIT 1
    `;
    return rows[0]!;
  }

  private async lockBalance(db: Db, workspaceId: string, ownerCoadminUserId: string, crmContactId: string): Promise<BalanceRow> {
    await this.ensureBalance(db, workspaceId, ownerCoadminUserId, crmContactId);
    const rows = await db.$queryRaw<BalanceRow[]>`
      SELECT id,
        workspace_id AS "workspaceId",
        owner_coadmin_user_id AS "ownerCoadminUserId",
        crm_contact_id AS "crmContactId",
        qualifying_remainder_cents AS "qualifyingRemainderCents",
        earned_spin_credits AS "earnedSpinCredits",
        consumed_spin_credits AS "consumedSpinCredits"
      FROM freeplay_player_balances
      WHERE owner_coadmin_user_id = ${ownerCoadminUserId}::uuid
        AND crm_contact_id = ${crmContactId}::uuid
        AND workspace_id = ${workspaceId}::uuid
      FOR UPDATE
    `;
    return rows[0]!;
  }

  private async recomputeBalanceFromDepositCredits(db: Db, balance: BalanceRow): Promise<void> {
    const rows = await db.$queryRaw<Array<{ totalCents: bigint | number | null }>>`
      SELECT COALESCE(SUM(amount_cents), 0) AS "totalCents"
      FROM freeplay_deposit_credits
      WHERE owner_coadmin_user_id = ${balance.ownerCoadminUserId}::uuid
        AND crm_contact_id = ${balance.crmContactId}::uuid
    `;
    const netCents = Math.max(0, Number(rows[0]?.totalCents ?? 0));
    const economicEarnedCredits = Math.floor(netCents / FREEPLAY_THRESHOLD_CENTS);
    const nextEarnedCredits = Math.max(economicEarnedCredits, balance.consumedSpinCredits);
    const nextRemainder = netCents % FREEPLAY_THRESHOLD_CENTS;
    await db.$executeRaw`
      UPDATE freeplay_player_balances
      SET qualifying_remainder_cents = ${nextRemainder},
          earned_spin_credits = ${nextEarnedCredits},
          updated_at = NOW()
      WHERE id = ${balance.id}::uuid
    `;
  }

  private async spinsInWindow(db: Db, ownerCoadminUserId: string, crmContactId: string, now: Date): Promise<SpinWindowRow[]> {
    const start = new Date(now.getTime() - FREEPLAY_ROLLING_WINDOW_MS);
    return db.$queryRaw<SpinWindowRow[]>`
      SELECT spun_at AS "spunAt"
      FROM freeplay_wheel_spins
      WHERE owner_coadmin_user_id = ${ownerCoadminUserId}::uuid
        AND crm_contact_id = ${crmContactId}::uuid
        AND spun_at > ${start}
        AND spun_at <= ${now}
      ORDER BY spun_at ASC
    `;
  }

  private async loadClaims(db: Db, workspaceId: string, ownerCoadminUserId: string, crmContactId: string): Promise<FreeplayStaffClaimDto[]> {
    const rows = await db.$queryRaw<ClaimRow[]>`
      SELECT c.id,
        c.spin_id AS "spinId",
        c.crm_contact_id AS "crmContactId",
        c.chat_id AS "chatId",
        c.reward_amount_cents AS "rewardAmountCents",
        c.status,
        c.created_at AS "createdAt",
        c.claimed_at AS "claimedAt",
        c.claimed_by_user_id AS "claimedByUserId",
        u.name AS "claimedByName",
        c.fulfillment_note AS "fulfillmentNote"
      FROM freeplay_claims c
      LEFT JOIN users u ON u.id = c.claimed_by_user_id
      WHERE c.workspace_id = ${workspaceId}::uuid
        AND c.owner_coadmin_user_id = ${ownerCoadminUserId}::uuid
        AND c.crm_contact_id = ${crmContactId}::uuid
      ORDER BY (c.status = 'UNCLAIMED') DESC, c.created_at DESC
      LIMIT 10
    `;
    return rows.map((row) => this.toClaimDto(row));
  }

  private toClaimDto(row: ClaimRow): FreeplayStaffClaimDto {
    return {
      id: row.id,
      spinId: row.spinId,
      crmContactId: row.crmContactId,
      chatId: row.chatId,
      rewardAmountCents: row.rewardAmountCents,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      claimedAt: row.claimedAt?.toISOString() ?? null,
      claimedByUserId: row.claimedByUserId,
      claimedByName: row.claimedByName,
      fulfillmentNote: row.fulfillmentNote
    };
  }

  private requireWorkspaceId(user: RequestUser): string {
    if (!user.workspaceId || (user.role !== "COADMIN" && user.role !== "STAFF")) throw forbidden();
    return user.workspaceId;
  }

  private async resolveOwner(workspaceId: string, crmContactId: string): Promise<string> {
    const participant = await this.app.prisma.leaderboardParticipant.findUnique({
      where: { workspaceId_crmContactId: { workspaceId, crmContactId } }
    });
    if (!participant) throw new AppError(404, "PARTICIPANT_NOT_BOUND", "Player is not bound to a Coadmin.");
    return participant.ownerCoadminUserId;
  }

  private async assertActorMaySeeOwner(user: RequestUser, ownerCoadminUserId: string): Promise<void> {
    if (user.role === "COADMIN" && user.id === ownerCoadminUserId) return;
    if (user.role !== "STAFF" || !user.workspaceId) throw forbidden();
    const owner = await this.app.prisma.user.findFirst({
      where: { id: ownerCoadminUserId, workspaceId: user.workspaceId, role: "COADMIN" },
      select: { id: true }
    });
    if (!owner) throw forbidden();
  }
}

function selectRewardAmountCents(): number {
  const total = DEFAULT_REWARD_DISTRIBUTION.reduce((sum, row) => sum + row.weight, 0);
  let pick = Math.random() * total;
  for (const row of DEFAULT_REWARD_DISTRIBUTION) {
    pick -= row.weight;
    if (pick <= 0) return row.amountCents;
  }
  return DEFAULT_REWARD_DISTRIBUTION.at(-1)!.amountCents;
}
