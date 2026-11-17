import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  InvoiceReservation,
  PyeCashChatLookup,
  PyeCashInvoiceStore,
  StoredPyeCashInvoice
} from "./pye-cash.types";

type InvoiceRow = {
  id: string;
  workspaceId: string;
  telegramChatDbId: string;
  requestedByUserId: string;
  merchant: string;
  amountCents: number;
  idempotencyKey: string;
  providerInvoiceId: string | null;
  lightningInvoiceEncrypted: Prisma.JsonValue | null;
  creationState: StoredPyeCashInvoice["creationState"];
  deliveryState: StoredPyeCashInvoice["deliveryState"];
  paymentState: StoredPyeCashInvoice["paymentState"];
  telegramMessageId: string | null;
  mediaStorageKey: string | null;
  expiresAt: Date | null;
  errorCategory: string | null;
  statusVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Postgres reservation. The unique (workspace, idempotency key) constraint is the lock.
 */
export class PrismaPyeCashInvoiceStore implements PyeCashInvoiceStore {
  public constructor(private readonly prisma: PrismaClient) {}

  public async reserve(input: {
    workspaceId: string;
    telegramChatDbId: string;
    requestedByUserId: string;
    merchant: string;
    amountCents: number;
    idempotencyKey: string;
    now: Date;
  }): Promise<InvoiceReservation> {
    try {
      const created = await this.prisma.pyeCashInvoice.create({
        data: {
          workspaceId: input.workspaceId,
          telegramChatDbId: input.telegramChatDbId,
          requestedByUserId: input.requestedByUserId,
          merchant: input.merchant,
          amountCents: input.amountCents,
          idempotencyKey: input.idempotencyKey,
          creationState: "CREATING",
          createdAt: input.now,
          updatedAt: input.now
        }
      });
      return { record: mapRow(created), created: true };
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      const existing = await this.prisma.pyeCashInvoice.findUnique({
        where: {
          workspaceId_idempotencyKey: {
            workspaceId: input.workspaceId,
            idempotencyKey: input.idempotencyKey
          }
        }
      });
      if (!existing) throw error;
      return { record: mapRow(existing), created: false };
    }
  }

  public async update(
    id: string,
    patch: Parameters<PyeCashInvoiceStore["update"]>[1],
    now: Date
  ): Promise<StoredPyeCashInvoice> {
    const updated = await this.prisma.pyeCashInvoice.update({
      where: { id },
      data: this.patchData(patch, now)
    });
    return mapRow(updated);
  }

  public async compareAndSet(
    id: string,
    expected: Parameters<PyeCashInvoiceStore["compareAndSet"]>[1],
    patch: Parameters<PyeCashInvoiceStore["update"]>[1],
    now: Date
  ): Promise<StoredPyeCashInvoice | null> {
    const result = await this.prisma.pyeCashInvoice.updateMany({
      where: {
        id,
        ...(expected.creationState ? { creationState: expected.creationState } : {}),
        ...(expected.deliveryState ? { deliveryState: expected.deliveryState } : {}),
        ...(expected.updatedAt ? { updatedAt: new Date(expected.updatedAt) } : {})
      },
      data: this.patchData(patch, now)
    });
    if (result.count !== 1) return null;
    return this.get(id);
  }

  public async get(id: string): Promise<StoredPyeCashInvoice | null> {
    const row = await this.prisma.pyeCashInvoice.findUnique({ where: { id } });
    return row ? mapRow(row) : null;
  }

  public async listForChat(workspaceId: string, telegramChatDbId: string, limit: number): Promise<readonly StoredPyeCashInvoice[]> {
    const rows = await this.prisma.pyeCashInvoice.findMany({
      where: { workspaceId, telegramChatDbId },
      orderBy: { createdAt: "desc" },
      take: limit
    });
    return rows.map(mapRow);
  }

  private patchData(patch: Parameters<PyeCashInvoiceStore["update"]>[1], now: Date): Prisma.PyeCashInvoiceUpdateInput {
    const { lightningInvoiceEncrypted, expiresAt, statusVerifiedAt, ...rest } = patch;
    return {
      ...rest,
      ...(lightningInvoiceEncrypted === undefined
        ? {}
        : {
            lightningInvoiceEncrypted:
              lightningInvoiceEncrypted === null ? Prisma.DbNull : (lightningInvoiceEncrypted as Prisma.InputJsonValue)
          }),
      ...(expiresAt === undefined ? {} : { expiresAt: expiresAt ? new Date(expiresAt) : null }),
      ...(statusVerifiedAt === undefined ? {} : { statusVerifiedAt: statusVerifiedAt ? new Date(statusVerifiedAt) : null }),
      updatedAt: now
    };
  }
}

export class PrismaPyeCashChatLookup implements PyeCashChatLookup {
  public constructor(private readonly prisma: PrismaClient) {}

  public async findInWorkspace(workspaceId: string, chatId: string) {
    return this.prisma.telegramChat.findFirst({
      where: { id: chatId, workspaceId },
      select: { id: true, telegramAccountId: true, telegramChatId: true }
    });
  }
}

function mapRow(row: InvoiceRow): StoredPyeCashInvoice {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    telegramChatDbId: row.telegramChatDbId,
    requestedByUserId: row.requestedByUserId,
    merchant: row.merchant,
    amountCents: row.amountCents,
    idempotencyKey: row.idempotencyKey,
    providerInvoiceId: row.providerInvoiceId,
    lightningInvoiceEncrypted: row.lightningInvoiceEncrypted,
    creationState: row.creationState,
    deliveryState: row.deliveryState,
    paymentState: row.paymentState,
    telegramMessageId: row.telegramMessageId,
    mediaStorageKey: row.mediaStorageKey,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    errorCategory: row.errorCategory,
    statusVerifiedAt: row.statusVerifiedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function isUniqueConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "P2002";
}
