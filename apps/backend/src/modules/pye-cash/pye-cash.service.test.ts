import { readFileSync } from "node:fs";
import { hasPermission, planPyeCashDelivery, pyeCashDeliveryUpdate, rolePermissions } from "@atlas/shared";
import jsQR from "jsqr";
import sharp from "sharp";
import { decryptSecret, encryptSecret } from "@atlas/shared/session-encryption";
import { describe, expect, it } from "vitest";
import { AppError } from "../../utils/errors";
import { PYE_CASH_CREATE_RATE_LIMIT } from "./pye-cash.routes";
import { createInvoiceBodySchema } from "./pye-cash.schema";
import { assertCashAppSender, PyeCashService } from "./pye-cash.service";
import type {
  PyeCashChatLookup,
  PyeCashConfig,
  PyeCashInvoiceStore,
  PyeCashLogEvent,
  PyeCashProvider,
  PyeCashStaff,
  ProviderAttempt,
  StoredPyeCashInvoice
} from "./pye-cash.types";

const KEY = "a".repeat(64);
const BOLT = "lnbc500n1qqqqqqqqqqqqqqqqqqqqqq";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const CHAT = "22222222-2222-4222-8222-222222222222";
const OTHER_CHAT = "33333333-3333-4333-8333-333333333333";
const STAFF_ID = "44444444-4444-4444-8444-444444444444";

const staff: PyeCashStaff = { id: STAFF_ID, role: "STAFF", workspaceId: WORKSPACE };

class MemoryInvoices implements PyeCashInvoiceStore {
  readonly rows: StoredPyeCashInvoice[] = [];
  failUpdates = 0;
  private tail: Promise<unknown> = Promise.resolve();

  public reserve(input: Parameters<PyeCashInvoiceStore["reserve"]>[0]) {
    return this.exclusive(async () => {
      const existing = this.rows.find(
        (row) => row.workspaceId === input.workspaceId && row.idempotencyKey === input.idempotencyKey
      );
      if (existing) return { record: existing, created: false };
      const stamp = input.now.toISOString();
      const record: StoredPyeCashInvoice = {
        id: crypto.randomUUID(),
        workspaceId: input.workspaceId,
        telegramChatDbId: input.telegramChatDbId,
        requestedByUserId: input.requestedByUserId,
        merchant: input.merchant,
        amountCents: input.amountCents,
        idempotencyKey: input.idempotencyKey,
        providerInvoiceId: null,
        lightningInvoiceEncrypted: null,
        creationState: "CREATING",
        deliveryState: "NOT_SENT",
        paymentState: "UNCONFIRMED",
        telegramMessageId: null,
        mediaStorageKey: null,
        expiresAt: null,
        errorCategory: null,
        statusVerifiedAt: null,
        createdAt: stamp,
        updatedAt: stamp
      };
      this.rows.push(record);
      return { record, created: true };
    });
  }

  public update(id: string, patch: Parameters<PyeCashInvoiceStore["update"]>[1], now: Date) {
    return this.exclusive(async () => {
      if (this.failUpdates > 0) {
        this.failUpdates -= 1;
        throw new Error("database unavailable");
      }
      const row = this.rows.find((item) => item.id === id);
      if (!row) throw new Error("invoice missing");
      Object.assign(row, patch, { updatedAt: now.toISOString() });
      return row;
    });
  }

  public compareAndSet(
    id: string,
    expected: { creationState?: StoredPyeCashInvoice["creationState"]; deliveryState?: StoredPyeCashInvoice["deliveryState"]; updatedAt?: string },
    patch: Parameters<PyeCashInvoiceStore["update"]>[1],
    now: Date
  ) {
    return this.exclusive(async () => {
      if (this.failUpdates > 0) {
        this.failUpdates -= 1;
        throw new Error("database unavailable");
      }
      const row = this.rows.find((item) => item.id === id);
      if (!row) return null;
      if (expected.creationState && row.creationState !== expected.creationState) return null;
      if (expected.deliveryState && row.deliveryState !== expected.deliveryState) return null;
      if (expected.updatedAt && row.updatedAt !== expected.updatedAt) return null;
      Object.assign(row, patch, { updatedAt: now.toISOString() });
      return row;
    });
  }

  public async get(id: string) {
    return this.rows.find((row) => row.id === id) ?? null;
  }

  public async listForChat(workspaceId: string, telegramChatDbId: string) {
    return this.rows.filter((row) => row.workspaceId === workspaceId && row.telegramChatDbId === telegramChatDbId);
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

class FakeChats implements PyeCashChatLookup {
  public constructor(private readonly ids: ReadonlySet<string>) {}
  public async findInWorkspace(workspaceId: string, chatId: string) {
    return workspaceId === WORKSPACE && this.ids.has(chatId)
      ? { id: chatId, telegramAccountId: "account-1", telegramChatId: "telegram-1" }
      : null;
  }
}

class FakeProvider implements PyeCashProvider {
  calls = 0;
  gate: Promise<void> = Promise.resolve();
  public constructor(public behavior: () => ProviderAttempt | Promise<ProviderAttempt>) {}
  public async createInvoice() {
    this.calls += 1;
    await this.gate;
    return this.behavior();
  }
}

function config(enabled = true, overrides: Partial<PyeCashConfig> = {}): PyeCashConfig {
  return {
    enabled,
    testMode: false,
    allowedUserIds: [],
    allowedChatIds: [],
    merchant: "sg",
    baseUrl: "https://www.pye-cash.app",
    timeoutMs: 10_000,
    maxAmountCents: 100_000,
    encryptionKey: KEY,
    staleCreatingMs: 30_000,
    ...overrides
  };
}

function success(amountCents: number): ProviderAttempt {
  return {
    kind: "created",
    body: {
      id: "provider01",
      lightning_invoice: BOLT,
      expires_at: "2026-11-18T12:00:00.000Z",
      status: "pending",
      amount: amountCents / 100,
      currency: "USD",
      target_amount: "0.0001"
    }
  };
}

function harness(options?: {
  enabled?: boolean;
  provider?: FakeProvider;
  chats?: FakeChats;
  now?: Date;
  invoices?: MemoryInvoices;
}) {
  const invoices = options?.invoices ?? new MemoryInvoices();
  const provider = options?.provider ?? new FakeProvider(async () => success(500));
  const logs: PyeCashLogEvent[] = [];
  const now = options?.now ?? new Date("2026-11-17T12:00:00.000Z");
  const service = new PyeCashService({
    config: config(options?.enabled ?? true),
    provider,
    invoices,
    chats: options?.chats ?? new FakeChats(new Set([CHAT, OTHER_CHAT])),
    encrypt: (plaintext) => encryptSecret(plaintext, KEY),
    now: () => now,
    log: (event) => logs.push(event)
  });
  return { service, invoices, provider, logs, now };
}

describe("Pye-Cash invoice service", () => {
  it("denies invoice creation when test mode has empty allowlists", async () => {
    const { service, provider } = harness({
      provider: new FakeProvider(async () => success(100)),
      invoices: new MemoryInvoices()
    });
    const restricted = new PyeCashService({
      config: config(true, { testMode: true, allowedUserIds: [], allowedChatIds: [] }),
      provider,
      invoices: new MemoryInvoices(),
      chats: new FakeChats(new Set([CHAT])),
      encrypt: (value) => encryptSecret(value, KEY)
    });
    await expect(restricted.create(staff, CHAT, { amountCents: 100, idempotencyKey: "empty-allow" })).rejects.toMatchObject({
      code: "PYE_CASH_STAFF_NOT_APPROVED"
    });
    expect(provider.calls).toBe(0);
    void service;
  });

  it("allows $1 and $5 for an approved staff member and chat, and rejects everyone else", async () => {
    const approved = config(true, { testMode: true, allowedUserIds: [STAFF_ID], allowedChatIds: [CHAT] });
    const provider = new FakeProvider(async () => success(100));
    const invoices = new MemoryInvoices();
    const service = new PyeCashService({
      config: approved,
      provider,
      invoices,
      chats: new FakeChats(new Set([CHAT, OTHER_CHAT])),
      encrypt: (value) => encryptSecret(value, KEY)
    });
    const one = await service.create(staff, CHAT, { amountCents: 100, idempotencyKey: "test-100" });
    provider.behavior = async () => success(500);
    const fiveProvider = new FakeProvider(async () => success(500));
    const fiveService = new PyeCashService({
      config: approved,
      provider: fiveProvider,
      invoices,
      chats: new FakeChats(new Set([CHAT, OTHER_CHAT])),
      encrypt: (value) => encryptSecret(value, KEY)
    });
    const five = await fiveService.create(staff, CHAT, { amountCents: 500, idempotencyKey: "test-500" });
    expect(one.invoice.amountCents).toBe(100);
    expect(five.invoice.amountCents).toBe(500);
    expect(five.invoice.id).not.toBe(one.invoice.id);
    expect(provider.calls).toBe(1);
    expect(fiveProvider.calls).toBe(1);
    await expect(service.create(staff, CHAT, { amountCents: 501, idempotencyKey: "test-501" })).rejects.toMatchObject({
      code: "PYE_CASH_TEST_LIMIT"
    });
    await expect(service.create({ ...staff, id: "55555555-5555-4555-8555-555555555555" }, CHAT, { amountCents: 100, idempotencyKey: "other-staff" })).rejects.toMatchObject({
      code: "PYE_CASH_STAFF_NOT_APPROVED"
    });
    await expect(service.create(staff, OTHER_CHAT, { amountCents: 100, idempotencyKey: "other-chat" })).rejects.toMatchObject({
      code: "PYE_CASH_CHAT_NOT_APPROVED"
    });
    await expect(service.create({ ...staff, workspaceId: "99999999-9999-4999-8999-999999999999" }, CHAT, { amountCents: 100, idempotencyKey: "other-ws" })).rejects.toMatchObject({
      code: "CHAT_NOT_FOUND"
    });
    const access = await service.capability(staff, CHAT);
    expect(access).toEqual({
      enabled: true,
      testMode: true,
      maxAmountCents: 500,
      userAllowed: true,
      chatAllowed: true,
      canSend: true
    });
    const blocked = await service.capability(staff, OTHER_CHAT);
    expect(blocked.canSend).toBe(false);
    expect(blocked.chatAllowed).toBe(false);
    expect(JSON.stringify(access)).not.toContain(STAFF_ID);
    expect(provider.calls).toBe(1);
    const deniedDelivery = new PyeCashService({
      config: config(true, { testMode: true, allowedUserIds: [STAFF_ID], allowedChatIds: [OTHER_CHAT] }),
      provider,
      invoices,
      chats: new FakeChats(new Set([CHAT])),
      encrypt: (value) => encryptSecret(value, KEY),
      media: { async putPng() { return "key"; } },
      delivery: { async enqueue() { throw new Error("must not enqueue"); } }
    });
    await expect(deniedDelivery.queueQr({ ...staff, sessionId: "session-1", name: "Ada" }, CHAT, five.invoice.id)).rejects.toMatchObject({
      code: "PYE_CASH_CHAT_NOT_APPROVED"
    });
  });

  it("blocks creation while the feature is disabled and does not call the provider", async () => {
    const { service, provider, invoices } = harness({ enabled: false });
    await expect(service.create(staff, CHAT, { amountCents: 500, idempotencyKey: "disabled-1" })).rejects.toMatchObject({
      code: "PYE_CASH_DISABLED"
    });
    expect(provider.calls).toBe(0);
    expect(invoices.rows).toHaveLength(0);
  });

  it.each([
    [500, 5],
    [2500, 25],
    [10000, 100]
  ])("accepts %i cents", async (amountCents) => {
    const provider = new FakeProvider(async () => success(amountCents));
    const { service, invoices } = harness({ provider });
    const result = await service.create(staff, CHAT, { amountCents, idempotencyKey: `amount-${amountCents}` });
    expect(result.statusCode).toBe(201);
    expect(result.invoice.creationState).toBe("READY");
    expect(result.invoice.amountCents).toBe(amountCents);
    expect(result.invoice.deliveryState).toBe("NOT_SENT");
    expect(result.invoice.paymentState).toBe("UNCONFIRMED");
    expect(result.invoice.telegramMessageId).toBeNull();
    expect(invoices.rows[0]?.lightningInvoiceEncrypted).not.toBe(BOLT);
    const secret = invoices.rows[0]?.lightningInvoiceEncrypted as Parameters<typeof decryptSecret>[0];
    expect(decryptSecret(secret, KEY)).toBe(BOLT);
    expect(JSON.stringify(result)).not.toContain("lnbc");
  });

  it("rejects zero, negative, fractional, and excessive amounts", () => {
    expect(() => createInvoiceBodySchema.parse({ amountCents: 0, idempotencyKey: "amount-zero" })).toThrow();
    expect(() => createInvoiceBodySchema.parse({ amountCents: -5, idempotencyKey: "amount-neg" })).toThrow();
    expect(() => createInvoiceBodySchema.parse({ amountCents: 10.5, idempotencyKey: "amount-frac" })).toThrow();
    const { service } = harness();
    return expect(service.create(staff, CHAT, { amountCents: 100_001, idempotencyKey: "amount-high" })).rejects.toMatchObject({
      code: "AMOUNT_EXCEEDS_LIMIT"
    });
  });

  it("rejects unauthenticated callers and roles that cannot send", () => {
    expect(() => assertCashAppSender(undefined)).toThrow(AppError);
    expect(() => assertCashAppSender({ id: STAFF_ID, role: "PLATFORM_ADMIN", workspaceId: WORKSPACE })).toThrow(AppError);
    expect(hasPermission("STAFF", "payments:cash-app:send")).toBe(true);
    expect(hasPermission("COADMIN", "payments:cash-app:send")).toBe(true);
    expect(rolePermissions.STAFF.filter((permission) => permission !== "payments:cash-app:send")).not.toContain(
      "payments:cash-app:send"
    );
  });

  it("hides chats that are missing or outside the workspace", async () => {
    const { service } = harness({ chats: new FakeChats(new Set([CHAT])) });
    await expect(service.create(staff, OTHER_CHAT, { amountCents: 500, idempotencyKey: "other-ws" })).rejects.toMatchObject({
      code: "CHAT_NOT_FOUND"
    });
    await expect(
      service.create(staff, "55555555-5555-4555-8555-555555555555", { amountCents: 500, idempotencyKey: "missing-chat" })
    ).rejects.toMatchObject({ code: "CHAT_NOT_FOUND" });
  });

  it("creates one invoice when the same key is submitted concurrently", async () => {
    let release = () => undefined;
    const provider = new FakeProvider(async () => success(500));
    provider.gate = new Promise((resolve) => {
      release = resolve;
    });
    const { service } = harness({ provider });
    const body = { amountCents: 500, idempotencyKey: "same-key" };
    const first = service.create(staff, CHAT, body);
    const second = service.create(staff, CHAT, body);
    const started = Date.now();
    while (provider.calls < 1 && Date.now() - started < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(provider.calls).toBe(1);
    release();
    const [left, right] = await Promise.all([first, second]);
    expect(left.invoice.id).toBe(right.invoice.id);
    expect([left.statusCode, right.statusCode].sort()).toEqual([201, 202]);
  });

  it("rejects the same key when the amount or chat differs", async () => {
    const { service, provider } = harness();
    await service.create(staff, CHAT, { amountCents: 500, idempotencyKey: "bound-key" });
    await expect(service.create(staff, CHAT, { amountCents: 2500, idempotencyKey: "bound-key" })).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT"
    });
    await expect(service.create(staff, OTHER_CHAT, { amountCents: 500, idempotencyKey: "bound-key" })).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT"
    });
    expect(provider.calls).toBe(1);
  });

  it("stores a definite provider rejection and does not call the provider again", async () => {
    const provider = new FakeProvider(async () => ({ kind: "rejected", category: "HTTP_400" }));
    const { service } = harness({ provider });
    const first = await service.create(staff, CHAT, { amountCents: 500, idempotencyKey: "reject-1" });
    const second = await service.create(staff, CHAT, { amountCents: 500, idempotencyKey: "reject-1" });
    expect(first.statusCode).toBe(422);
    expect(first.invoice.creationState).toBe("FAILED");
    expect(first.invoice.errorCategory).toBe("HTTP_400");
    expect(second.invoice.id).toBe(first.invoice.id);
    expect(provider.calls).toBe(1);
  });

  it("stores timeout and malformed responses as UNKNOWN and never retries them", async () => {
    const timeout = new FakeProvider(async () => ({ kind: "uncertain", category: "TIMEOUT" }));
    const timed = harness({ provider: timeout });
    const pending = await timed.service.create(staff, CHAT, { amountCents: 500, idempotencyKey: "timeout-1" });
    await timed.service.create(staff, CHAT, { amountCents: 500, idempotencyKey: "timeout-1" });
    expect(pending.invoice.creationState).toBe("UNKNOWN");
    expect(pending.invoice.errorCategory).toBe("TIMEOUT");
    expect(timeout.calls).toBe(1);

    const malformed = new FakeProvider(async () => ({ kind: "created", body: { id: "partial01", amount: 5 } }));
    const broken = harness({ provider: malformed });
    const result = await broken.service.create(staff, CHAT, { amountCents: 500, idempotencyKey: "bad-body" });
    expect(result.invoice.creationState).toBe("UNKNOWN");
    expect(result.invoice.errorCategory).toBe("MALFORMED_RESPONSE");
    expect(result.invoice.providerInvoiceId).toBe("partial01");
    expect(result.statusCode).not.toBe(201);
  });

  it("marks a stale CREATING row UNKNOWN without a new provider POST", async () => {
    const { service, invoices, provider } = harness();
    const old = new Date("2026-11-17T11:00:00.000Z").toISOString();
    invoices.rows.push({
      id: "stale-row",
      workspaceId: WORKSPACE,
      telegramChatDbId: CHAT,
      requestedByUserId: STAFF_ID,
      merchant: "sg",
      amountCents: 500,
      idempotencyKey: "stale-key",
      providerInvoiceId: null,
      lightningInvoiceEncrypted: null,
      creationState: "CREATING",
      deliveryState: "NOT_SENT",
      paymentState: "UNCONFIRMED",
      telegramMessageId: null,
      mediaStorageKey: null,
      expiresAt: null,
      errorCategory: null,
      statusVerifiedAt: null,
      createdAt: old,
      updatedAt: old
    });
    const result = await service.create(staff, CHAT, { amountCents: 500, idempotencyKey: "stale-key" });
    expect(result.invoice.creationState).toBe("UNKNOWN");
    expect(result.invoice.errorCategory).toBe("STALE_CREATING");
    expect(provider.calls).toBe(0);
  });

  it("keeps provider evidence when the first database update fails and does not POST again", async () => {
    const invoices = new MemoryInvoices();
    invoices.failUpdates = 1;
    const provider = new FakeProvider(async () => success(500));
    const { service } = harness({ invoices, provider });
    const result = await service.create(staff, CHAT, { amountCents: 500, idempotencyKey: "persist-1" });
    expect(result.statusCode).toBe(202);
    expect(result.invoice.creationState).toBe("UNKNOWN");
    expect(result.invoice.errorCategory).toBe("PERSIST_FAILED");
    expect(result.invoice.providerInvoiceId).toBe("provider01");
    await service.create(staff, CHAT, { amountCents: 500, idempotencyKey: "persist-1" });
    expect(provider.calls).toBe(1);
  });

  it("reports uncertainty when the provider result cannot be stored", async () => {
    const invoices = new MemoryInvoices();
    invoices.failUpdates = 2;
    const provider = new FakeProvider(async () => success(500));
    const { service } = harness({ invoices, provider });
    await expect(service.create(staff, CHAT, { amountCents: 500, idempotencyKey: "persist-lost" })).rejects.toMatchObject({
      code: "PYE_CASH_OUTCOME_UNCERTAIN"
    });
    expect(provider.calls).toBe(1);
    expect(invoices.rows[0]?.creationState).toBe("CREATING");
  });

  it("does not put the Lightning invoice in logs or public results", async () => {
    const { service, logs } = harness();
    const result = await service.create(staff, CHAT, { amountCents: 500, idempotencyKey: "log-check" });
    const listed = await service.list(staff, CHAT, 20);
    const rendered = JSON.stringify({ logs, result, listed });
    expect(rendered).not.toContain(BOLT);
    expect(rendered).not.toContain("lnbc");
    expect(listed[0]?.creationState).toBe("READY");
  });

  it("does not send Telegram messages or record deposits", () => {
    const sources = ["pye-cash.service.ts", "pye-cash.routes.ts", "pye-cash.client.ts", "pye-cash.store.ts"].map((name) =>
      readFileSync(new URL(`./${name}`, import.meta.url), "utf8")
    );
    const combined = sources.join("\n");
    expect(combined).not.toContain("recordDeposit");
    expect(combined).not.toContain("LeaderboardEvent");
    expect(combined).not.toContain("sendMedia");
    expect(combined).not.toContain("command-consumer");
    expect(PYE_CASH_CREATE_RATE_LIMIT.max).toBe(10);
  });

  it("keeps a late provider success after another request marked the row stale", async () => {
    let now = new Date("2026-11-17T12:00:00.000Z");
    let release = () => undefined;
    const provider = new FakeProvider(async () => success(500));
    provider.gate = new Promise((resolve) => {
      release = resolve;
    });
    const invoices = new MemoryInvoices();
    const service = new PyeCashService({
      config: config(),
      provider,
      invoices,
      chats: new FakeChats(new Set([CHAT, OTHER_CHAT])),
      encrypt: (value) => encryptSecret(value, KEY),
      now: () => now
    });
    const pending = service.create(staff, CHAT, { amountCents: 500, idempotencyKey: "late-success" });
    const started = Date.now();
    while (provider.calls < 1 && Date.now() - started < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    now = new Date(now.getTime() + 60_000);
    const stale = await service.create(staff, CHAT, { amountCents: 500, idempotencyKey: "late-success" });
    expect(stale.invoice.creationState).toBe("UNKNOWN");
    release();
    const finished = await pending;
    expect(finished.invoice.creationState).toBe("READY");
    expect(finished.invoice.providerInvoiceId).toBe("provider01");
    expect(provider.calls).toBe(1);
  });

  it("does not let stale recovery erase an invoice that already finished", async () => {
    let now = new Date("2026-11-17T12:00:00.000Z");
    const provider = new FakeProvider(async () => success(500));
    const service = new PyeCashService({
      config: config(),
      provider,
      invoices: new MemoryInvoices(),
      chats: new FakeChats(new Set([CHAT, OTHER_CHAT])),
      encrypt: (value) => encryptSecret(value, KEY),
      now: () => now
    });
    await service.create(staff, CHAT, { amountCents: 500, idempotencyKey: "already-ready" });
    now = new Date(now.getTime() + 60_000);
    const again = await service.create(staff, CHAT, { amountCents: 500, idempotencyKey: "already-ready" });
    expect(again.statusCode).toBe(200);
    expect(again.invoice.creationState).toBe("READY");
    expect(provider.calls).toBe(1);
  });
});

const sender = { ...staff, sessionId: "session-1", name: "Ada" };

class FakeMedia {
  public puts = 0;
  public fail = false;
  public png: Buffer | null = null;
  public async putPng(input: { png: Buffer; telegramChatId: string }) {
    this.puts += 1;
    if (input.telegramChatId !== "telegram-1") throw new Error("wrong chat");
    if (this.fail) throw new Error("storage down");
    this.png = input.png;
    return "workspaces/ws/telegram/account-1/telegram-1/pye/pye-cash-qr.png";
  }
}

class FakeDelivery {
  public calls: Array<{ caption: string; chatId: string; resend: boolean; storageKey: string }> = [];
  public readonly commands = new Map<string, { id: string; status: "QUEUED" | "SENT" | "FAILED_RETRYABLE" | "FAILED_PERMANENT"; ambiguous: boolean }>();
  public jobs: string[] = [];
  public failBeforeWrite = 0;
  public failAfterWrite = 0;
  private tail: Promise<unknown> = Promise.resolve();

  public constructor(private readonly invoices: MemoryInvoices) {}

  public async enqueue(input: {
    caption: string;
    chat: { id: string };
    resend: boolean;
    storageKey: string;
    idempotencyKey: string;
    invoiceId: string;
  }) {
    return this.exclusive(async () => {
      this.calls.push({
        caption: input.caption,
        chatId: input.chat.id,
        resend: input.resend,
        storageKey: input.storageKey
      });
      if (this.failBeforeWrite > 0) {
        this.failBeforeWrite -= 1;
        throw new Error("crash before command");
      }
      const invoice = await this.invoices.get(input.invoiceId);
      if (!invoice) throw new Error("missing invoice");
      const existing = this.commands.get(input.idempotencyKey);
      const plan = planPyeCashDelivery({
        deliveryState: invoice.deliveryState,
        errorCategory: invoice.errorCategory,
        command: existing
          ? { status: existing.status, ambiguous: existing.ambiguous }
          : { status: "MISSING", ambiguous: false },
        explicitResend: input.resend
      });
      if (plan.action === "block_ambiguous") {
        throw new AppError(409, "PYE_CASH_DELIVERY_AMBIGUOUS", "Telegram may already have this QR. It will not be sent again.");
      }
      if (plan.action === "reconcile_sent") {
        await this.invoices.update(invoice.id, { deliveryState: "SENT", errorCategory: null, telegramMessageId: "91" }, new Date());
        return { outcome: "already_sent" as const, telegramMessageId: "91" };
      }
      if (plan.action === "reconcile_failed") {
        await this.invoices.update(invoice.id, { deliveryState: "FAILED", errorCategory: "TELEGRAM_FAILED" }, new Date());
        return { outcome: "reconciled_failed" as const, telegramMessageId: null };
      }
      if (plan.action === "ensure_job") {
        if (this.failAfterWrite > 0) {
          this.failAfterWrite -= 1;
          throw new Error("crash before job");
        }
        if (existing && !this.jobs.includes(existing.id)) this.jobs.push(existing.id);
        return { outcome: "already_queued" as const, telegramMessageId: null };
      }
      if (plan.action === "retry_same_command" && existing) {
        existing.status = "QUEUED";
        existing.ambiguous = false;
        this.jobs.push(`${existing.id}:retry`);
        await this.invoices.update(invoice.id, { deliveryState: "QUEUED", errorCategory: null }, new Date());
        return { outcome: "queued" as const, telegramMessageId: null };
      }
      const command = { id: `cmd-${this.commands.size + 1}`, status: "QUEUED" as const, ambiguous: false };
      this.commands.set(input.idempotencyKey, command);
      await this.invoices.update(invoice.id, { deliveryState: "QUEUED", errorCategory: null }, new Date());
      if (this.failAfterWrite > 0) {
        this.failAfterWrite -= 1;
        throw new Error("crash after command");
      }
      this.jobs.push(command.id);
      return { outcome: "queued" as const, telegramMessageId: null };
    });
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

function deliveryHarness() {
  const invoices = new MemoryInvoices();
  const provider = new FakeProvider(async () => success(500));
  const media = new FakeMedia();
  const delivery = new FakeDelivery(invoices);
  const service = new PyeCashService({
    config: config(),
    provider,
    invoices,
    chats: new FakeChats(new Set([CHAT, OTHER_CHAT])),
    encrypt: (value) => encryptSecret(value, KEY),
    decrypt: (envelope) => decryptSecret(envelope, KEY),
    media,
    delivery,
    now: () => new Date("2026-11-17T12:00:00.000Z")
  });
  return { service, invoices, provider, media, delivery };
}

describe("Pye-Cash QR delivery", () => {
  it("stores one scannable card and queues it for the workspace chat", async () => {
    const { service, provider, media, delivery, invoices } = deliveryHarness();
    const created = await service.create(staff, CHAT, { amountCents: 500, idempotencyKey: "deliver-5" });
    const queued = await service.queueQr(sender, CHAT, created.invoice.id);
    expect(queued.statusCode).toBe(202);
    expect(queued.invoice.deliveryState).toBe("QUEUED");
    expect(queued.invoice.paymentState).toBe("UNCONFIRMED");
    expect(provider.calls).toBe(1);
    expect(media.puts).toBe(1);
    expect(delivery.commands.size).toBe(1);
    expect(delivery.jobs).toHaveLength(1);
    expect(delivery.calls[0]?.chatId).toBe(CHAT);
    expect(delivery.calls[0]?.caption).toContain("https://www.pye-cash.app/invoice/provider01");
    expect(delivery.calls[0]?.caption).toContain("$5.00");
    expect(delivery.calls[0]?.caption).not.toContain(BOLT);
    expect(invoices.rows[0]?.mediaStorageKey).toContain("telegram-1");
    const image = await sharp(media.png ?? Buffer.alloc(0)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(jsQR(new Uint8ClampedArray(image.data), image.info.width, image.info.height)?.data).toBe(BOLT);
  });

  it("does not queue a second copy or call the provider again", async () => {
    const { service, provider, delivery } = deliveryHarness();
    const created = await service.create(staff, CHAT, { amountCents: 500, idempotencyKey: "deliver-once" });
    await service.queueQr(sender, CHAT, created.invoice.id);
    const again = await service.queueQr(sender, CHAT, created.invoice.id);
    expect(again.invoice.deliveryState).toBe("QUEUED");
    expect(delivery.commands.size).toBe(1);
    expect(delivery.jobs).toHaveLength(1);
    expect(provider.calls).toBe(1);
  });

  it("lets only one concurrent queue call enqueue", async () => {
    const { service, delivery, provider } = deliveryHarness();
    const created = await service.create(staff, CHAT, { amountCents: 500, idempotencyKey: "deliver-race" });
    await Promise.all([service.queueQr(sender, CHAT, created.invoice.id), service.queueQr(sender, CHAT, created.invoice.id)]);
    expect(delivery.commands.size).toBe(1);
    expect(delivery.jobs).toHaveLength(1);
    expect(provider.calls).toBe(1);
  });

  it("keeps the invoice when storage fails and does not enqueue Telegram", async () => {
    const { service, media, delivery, provider, invoices } = deliveryHarness();
    media.fail = true;
    const created = await service.create(staff, CHAT, { amountCents: 500, idempotencyKey: "deliver-store" });
    await expect(service.queueQr(sender, CHAT, created.invoice.id)).rejects.toMatchObject({ code: "PYE_CASH_DELIVERY_FAILED" });
    expect(delivery.calls).toHaveLength(0);
    expect(provider.calls).toBe(1);
    expect(invoices.rows[0]?.deliveryState).toBe("FAILED");
    expect(invoices.rows[0]?.creationState).toBe("READY");
  });

  it("resends a failed invoice without a new provider request or a new image", async () => {
    const { service, invoices, provider, media, delivery } = deliveryHarness();
    const created = await service.create(staff, CHAT, { amountCents: 500, idempotencyKey: "deliver-retry" });
    await service.queueQr(sender, CHAT, created.invoice.id);
    const row = invoices.rows[0];
    if (!row) throw new Error("missing");
    row.deliveryState = "FAILED";
    row.errorCategory = "TELEGRAM_FAILED";
    const command = [...delivery.commands.values()][0];
    if (!command) throw new Error("missing command");
    command.status = "FAILED_RETRYABLE";
    const callsBefore = provider.calls;
    const putsBefore = media.puts;
    const jobsBefore = delivery.jobs.length;
    const resent = await service.queueQr(sender, CHAT, created.invoice.id);
    expect(resent.invoice.deliveryState).toBe("QUEUED");
    expect(delivery.calls.at(-1)?.resend).toBe(true);
    expect(delivery.commands.size).toBe(1);
    expect(delivery.jobs.length).toBe(jobsBefore + 1);
    expect(provider.calls).toBe(callsBefore);
    expect(media.puts).toBe(putsBefore);
  });

  it("refuses UNKNOWN, ambiguous, expired, and wrong-chat sends", async () => {
    const { service, invoices, delivery, provider } = deliveryHarness();
    const created = await service.create(staff, CHAT, { amountCents: 500, idempotencyKey: "deliver-guard" });
    const row = invoices.rows[0];
    if (!row) throw new Error("missing");
    row.creationState = "UNKNOWN";
    await expect(service.queueQr(sender, CHAT, row.id)).rejects.toMatchObject({ code: "PYE_CASH_NOT_READY" });
    row.creationState = "READY";
    row.errorCategory = "TELEGRAM_AMBIGUOUS";
    row.deliveryState = "FAILED";
    await expect(service.queueQr(sender, CHAT, row.id)).rejects.toMatchObject({ code: "PYE_CASH_DELIVERY_AMBIGUOUS" });
    row.errorCategory = null;
    row.deliveryState = "NOT_SENT";
    row.expiresAt = "2026-11-17T11:00:00.000Z";
    await expect(service.queueQr(sender, CHAT, row.id)).rejects.toMatchObject({ code: "INVOICE_EXPIRED" });
    expect(row.paymentState).toBe("EXPIRED");
    await expect(service.queueQr(sender, OTHER_CHAT, row.id)).rejects.toMatchObject({ code: "INVOICE_NOT_FOUND" });
    expect(delivery.commands.size).toBe(0);
    expect(provider.calls).toBe(1);
  });

  it("recovers a queued invoice whose command write crashed and does not create another invoice", async () => {
    const { service, invoices, provider, delivery } = deliveryHarness();
    const created = await service.create(staff, CHAT, { amountCents: 500, idempotencyKey: "deliver-crash" });
    delivery.failBeforeWrite = 2;
    await expect(service.queueQr(sender, CHAT, created.invoice.id)).rejects.toMatchObject({ code: "PYE_CASH_DELIVERY_FAILED" });
    expect(delivery.commands.size).toBe(0);
    expect(invoices.rows[0]?.creationState).toBe("READY");
    expect(provider.calls).toBe(1);
    const recovered = await service.queueQr(sender, CHAT, created.invoice.id);
    expect(recovered.invoice.id).toBe(created.invoice.id);
    expect(recovered.invoice.deliveryState).toBe("QUEUED");
    expect(delivery.commands.size).toBe(1);
    expect(delivery.jobs).toHaveLength(1);
    expect(provider.calls).toBe(1);
  });

  it("keeps one command when the job write crashes and reconciles a sent command", async () => {
    const { service, invoices, provider, delivery } = deliveryHarness();
    const created = await service.create(staff, CHAT, { amountCents: 500, idempotencyKey: "deliver-job-crash" });
    delivery.failAfterWrite = 2;
    const pending = await service.queueQr(sender, CHAT, created.invoice.id);
    expect(pending.invoice.deliveryState).toBe("QUEUED");
    expect(delivery.commands.size).toBe(1);
    expect(delivery.jobs).toHaveLength(0);
    const resumed = await service.queueQr(sender, CHAT, created.invoice.id);
    expect(resumed.invoice.deliveryState).toBe("QUEUED");
    expect(delivery.jobs).toHaveLength(1);
    expect(provider.calls).toBe(1);
    const command = [...delivery.commands.values()][0];
    if (!command) throw new Error("missing command");
    command.status = "SENT";
    invoices.rows[0]!.deliveryState = "QUEUED";
    const reconciled = await service.queueQr(sender, CHAT, created.invoice.id);
    expect(reconciled.invoice.deliveryState).toBe("SENT");
    expect(reconciled.invoice.paymentState).toBe("UNCONFIRMED");
    expect(delivery.jobs).toHaveLength(1);
    expect(provider.calls).toBe(1);
  });

  it("does not enqueue when a failed command is ambiguous", async () => {
    const { service, invoices, delivery, provider } = deliveryHarness();
    const created = await service.create(staff, CHAT, { amountCents: 500, idempotencyKey: "deliver-ambiguous-command" });
    await service.queueQr(sender, CHAT, created.invoice.id);
    const command = [...delivery.commands.values()][0];
    if (!command || !invoices.rows[0]) throw new Error("missing");
    command.status = "FAILED_PERMANENT";
    command.ambiguous = true;
    invoices.rows[0].deliveryState = "QUEUED";
    invoices.rows[0].errorCategory = null;
    const jobs = delivery.jobs.length;
    await expect(service.queueQr(sender, CHAT, created.invoice.id)).rejects.toMatchObject({ code: "PYE_CASH_DELIVERY_AMBIGUOUS" });
    expect(delivery.jobs.length).toBe(jobs);
    expect(delivery.commands.size).toBe(1);
    expect(provider.calls).toBe(1);
  });

  it("records worker success, failure, and ambiguous delivery without marking payment", () => {
    expect(pyeCashDeliveryUpdate("QUEUED", "sent", "91")).toEqual({
      deliveryState: "SENT",
      errorCategory: null,
      telegramMessageId: "91"
    });
    expect(pyeCashDeliveryUpdate("QUEUED", "failed", null)?.deliveryState).toBe("FAILED");
    expect(pyeCashDeliveryUpdate("QUEUED", "ambiguous", "91")?.errorCategory).toBe("TELEGRAM_AMBIGUOUS");
    expect(pyeCashDeliveryUpdate("SENT", "failed", null)).toBeNull();
  });
});
