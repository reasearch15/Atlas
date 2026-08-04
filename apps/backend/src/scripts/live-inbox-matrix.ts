/**
 * Live inbox reliability matrix runner (real backend + Redis + WebSocket + REST).
 * Customer ingress is injected through the same DB+Redis publish path the telegram-worker uses
 * after MTProto persistence — not a pure in-memory model.
 *
 * Usage (from repo root, with infra + backend + frontend running):
 *   pnpm --filter @atlas/backend exec dotenv -e ../../.env -- tsx src/scripts/live-inbox-matrix.ts
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import WebSocket from "ws";
import { encryptSecret } from "@atlas/shared/session-encryption";

const API = process.env.LIVE_MATRIX_API_BASE ?? `http://127.0.0.1:${process.env.BACKEND_PORT ?? "4000"}`;
const EVIDENCE_DIR = join(process.cwd(), "..", "..", "evidence", "live-inbox-matrix");
const FIXTURE_PREFIX = "live.inbox.matrix";
const PASSWORD = "LiveMatrixVerify9!";
const STAFF_A = "matrix_staff_a";
const STAFF_B = "matrix_staff_b";

interface EvidenceStep {
  readonly at: string;
  readonly scenario: string;
  readonly action: string;
  readonly ok: boolean;
  readonly detail: Record<string, unknown>;
}

const evidence: EvidenceStep[] = [];
const prisma = new PrismaClient();

function now(): string {
  return new Date().toISOString();
}

function record(scenario: string, action: string, ok: boolean, detail: Record<string, unknown> = {}): void {
  const step = { at: now(), scenario, action, ok, detail };
  evidence.push(step);
  console.log(JSON.stringify({ channel: "atlas.live.matrix", ...step }));
}

async function apiJson<T>(
  path: string,
  options: { method?: string; token?: string; body?: unknown; cookie?: string } = {}
): Promise<{ status: number; body: T; setCookie: string | null }> {
  const headers: Record<string, string> = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const init: RequestInit = {
    method: options.method ?? (options.body !== undefined ? "POST" : "GET"),
    headers
  };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(`${API}${path}`, init);
  const setCookie = response.headers.get("set-cookie");
  const text = await response.text();
  let body: T;
  try {
    body = text ? (JSON.parse(text) as T) : ({} as T);
  } catch {
    body = { raw: text } as T;
  }
  return { status: response.status, body, setCookie };
}

async function staffLogin(username: string): Promise<{ token: string; userId: string }> {
  const result = await apiJson<{
    accessToken?: string;
    user?: { id: string };
    requiresPasswordChange?: boolean;
    message?: string;
  }>("/api/staff-auth/login", {
    body: { username, password: PASSWORD }
  });
  if (result.status >= 400 || !result.body.accessToken || !result.body.user?.id) {
    throw new Error(`login failed for ${username}: ${result.status} ${JSON.stringify(result.body)}`);
  }
  return { token: result.body.accessToken, userId: result.body.user.id };
}

function openWorkspaceSocket(token: string): Promise<{
  ws: WebSocket;
  events: Array<{ at: string; type: string; payload: Record<string, unknown> }>;
  waitFor: (predicate: (payload: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>>;
}> {
  const events: Array<{ at: string; type: string; payload: Record<string, unknown> }> = [];
  const wsUrl = API.replace(/^http/, "ws") + `/ws?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(wsUrl);
  const waiters: Array<{
    predicate: (payload: Record<string, unknown>) => boolean;
    resolve: (payload: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  const settleWaiters = (payload: Record<string, unknown>): void => {
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i]!;
      if (!waiter.predicate(payload)) continue;
      clearTimeout(waiter.timer);
      waiters.splice(i, 1);
      waiter.resolve(payload);
    }
  };

  return new Promise((resolve, reject) => {
    const openTimer = setTimeout(() => reject(new Error("ws open timeout")), 10_000);
    ws.on("open", () => {
      clearTimeout(openTimer);
      resolve({
        ws,
        events,
        waitFor: (predicate, timeoutMs = 12_000) =>
          new Promise((res, rej) => {
            for (const existing of events) {
              if (predicate(existing.payload)) {
                res(existing.payload);
                return;
              }
            }
            const timer = setTimeout(() => {
              const idx = waiters.findIndex((w) => w.timer === timer);
              if (idx >= 0) waiters.splice(idx, 1);
              rej(new Error("ws wait timeout"));
            }, timeoutMs);
            waiters.push({ predicate, resolve: res, reject: rej, timer });
          })
      });
    });
    ws.on("message", (raw) => {
      try {
        const payload = JSON.parse(String(raw)) as Record<string, unknown>;
        const type = String(payload.type ?? "unknown");
        events.push({ at: now(), type, payload });
        settleWaiters(payload);
      } catch {
        // ignore
      }
    });
    ws.on("error", (error) => reject(error));
  });
}

async function ensureFixtures(encryptionKey: string): Promise<{
  workspaceId: string;
  accountId: string;
  existingChatId: string;
  newChatPeerId: string;
}> {
  const passwordHash = await bcrypt.hash(PASSWORD, 12);
  const workspace = await prisma.workspace.upsert({
    where: { slug: "live-matrix" },
    update: { name: "Live Matrix Workspace", isDevelopmentFixture: true, fixtureKey: `${FIXTURE_PREFIX}.workspace` },
    create: {
      name: "Live Matrix Workspace",
      slug: "live-matrix",
      isDevelopmentFixture: true,
      fixtureKey: `${FIXTURE_PREFIX}.workspace`
    }
  });

  const upsertStaff = async (username: string, name: string, fixtureKey: string) => {
    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) {
      return prisma.user.update({
        where: { id: existing.id },
        data: {
          workspaceId: workspace.id,
          name,
          role: "STAFF",
          status: "ACTIVE",
          passwordHash,
          mustChangePassword: false,
          passwordChangedAt: new Date(),
          isDevelopmentFixture: true,
          fixtureKey
        }
      });
    }
    return prisma.user.create({
      data: {
        workspaceId: workspace.id,
        username,
        email: `${username}@live-matrix.local`,
        name,
        role: "STAFF",
        status: "ACTIVE",
        passwordHash,
        mustChangePassword: false,
        passwordChangedAt: new Date(),
        isDevelopmentFixture: true,
        fixtureKey
      }
    });
  };

  const staffA = await upsertStaff(STAFF_A, "Matrix Staff A", `${FIXTURE_PREFIX}.staff.a`);
  await upsertStaff(STAFF_B, "Matrix Staff B", `${FIXTURE_PREFIX}.staff.b`);

  const encryptedHash = encryptSecret("a".repeat(32), encryptionKey);
  const developerApp = await prisma.developerApp.upsert({
    where: { fixtureKey: `${FIXTURE_PREFIX}.devapp` },
    update: {
      workspaceId: workspace.id,
      displayName: "Live Matrix DevApp",
      apiId: 123456,
      encryptedApiHash: encryptedHash as object,
      status: "ACTIVE",
      isDevelopmentFixture: true,
      createdByUserId: staffA.id
    },
    create: {
      workspaceId: workspace.id,
      provider: "TELEGRAM",
      displayName: "Live Matrix DevApp",
      apiId: 123456,
      encryptedApiHash: encryptedHash as object,
      status: "ACTIVE",
      isDevelopmentFixture: true,
      fixtureKey: `${FIXTURE_PREFIX}.devapp`,
      createdByUserId: staffA.id
    }
  });

  const account = await prisma.telegramAccount.upsert({
    where: { fixtureKey: `${FIXTURE_PREFIX}.account` },
    update: {
      workspaceId: workspace.id,
      developerAppId: developerApp.id,
      displayName: "Live Matrix Account",
      status: "CONNECTED",
      authorizationState: "AUTHORIZED",
      syncState: "LIVE",
      isDevelopmentFixture: true,
      createdByUserId: staffA.id,
      lastConnectedAt: new Date()
    },
    create: {
      workspaceId: workspace.id,
      developerAppId: developerApp.id,
      displayName: "Live Matrix Account",
      status: "CONNECTED",
      authorizationState: "AUTHORIZED",
      syncState: "LIVE",
      isDevelopmentFixture: true,
      fixtureKey: `${FIXTURE_PREFIX}.account`,
      createdByUserId: staffA.id,
      lastConnectedAt: new Date()
    }
  });

  const existingChat = await prisma.telegramChat.upsert({
    where: {
      telegramAccountId_telegramChatId: {
        telegramAccountId: account.id,
        telegramChatId: "900001"
      }
    },
    update: {
      workspaceId: workspace.id,
      title: "Existing Customer",
      firstName: "Existing",
      lastName: "Customer",
      chatType: "PRIVATE",
      unreadCount: 0,
      isArchived: false,
      lastMessagePreview: "seed",
      lastMessageAt: new Date(),
      isDevelopmentFixture: true,
      fixtureKey: `${FIXTURE_PREFIX}.chat.existing`
    },
    create: {
      workspaceId: workspace.id,
      telegramAccountId: account.id,
      telegramChatId: "900001",
      chatType: "PRIVATE",
      title: "Existing Customer",
      firstName: "Existing",
      lastName: "Customer",
      unreadCount: 0,
      lastMessagePreview: "seed",
      lastMessageAt: new Date(),
      isDevelopmentFixture: true,
      fixtureKey: `${FIXTURE_PREFIX}.chat.existing`,
      crmStatus: "OPEN",
      needsCrmAttention: false
    }
  });

  return {
    workspaceId: workspace.id,
    accountId: account.id,
    existingChatId: existingChat.id,
    newChatPeerId: "900002"
  };
}

async function injectInbound(options: {
  workspaceId: string;
  accountId: string;
  chatDbId?: string;
  telegramChatId: string;
  text: string;
  title?: string;
  createChat?: boolean;
}): Promise<{ messageId: string; unreadCount: number; chatId: string }> {
  const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
  const sentAt = new Date();
  const telegramMessageId = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

  let chat = options.chatDbId
    ? await prisma.telegramChat.findUnique({ where: { id: options.chatDbId } })
    : await prisma.telegramChat.findUnique({
        where: {
          telegramAccountId_telegramChatId: {
            telegramAccountId: options.accountId,
            telegramChatId: options.telegramChatId
          }
        }
      });
  if (!chat && options.createChat) {
    chat = await prisma.telegramChat.create({
      data: {
        workspaceId: options.workspaceId,
        telegramAccountId: options.accountId,
        telegramChatId: options.telegramChatId,
        chatType: "PRIVATE",
        title: options.title ?? "New Customer",
        firstName: options.title ?? "New",
        unreadCount: 0,
        isDevelopmentFixture: true,
        fixtureKey: `${FIXTURE_PREFIX}.chat.${options.telegramChatId}`,
        crmStatus: "NEW",
        needsCrmAttention: true,
        crmAttentionAt: sentAt
      }
    });
  }
  if (!chat) throw new Error("chat missing for inject");

  const updated = await prisma.telegramChat.update({
    where: { id: chat.id },
    data: {
      unreadCount: { increment: 1 },
      lastMessageId: telegramMessageId,
      lastMessagePreview: options.text.slice(0, 200),
      lastMessageAt: sentAt,
      needsCrmAttention: true,
      crmAttentionAt: sentAt,
      ...(options.title ? { title: options.title } : {})
    }
  });

  const message = await prisma.telegramMessage.create({
    data: {
      workspaceId: options.workspaceId,
      telegramAccountId: options.accountId,
      telegramChatDbId: chat.id,
      telegramChatId: options.telegramChatId,
      telegramMessageId,
      direction: "INBOUND",
      contentType: "TEXT",
      textContent: options.text,
      sendStatus: "RECEIVED",
      telegramCreatedAt: sentAt,
      isDevelopmentFixture: true
    }
  });

  const messageEvent = {
    type: "telegram.message.created",
    eventId: randomUUID(),
    workspaceId: options.workspaceId,
    telegramAccountId: options.accountId,
    chatId: chat.id,
    chatDbId: chat.id,
    message: {
      id: message.id,
      chatId: chat.id,
      telegramAccountId: options.accountId,
      telegramMessageId,
      direction: "INBOUND",
      messageType: "TEXT",
      contentType: "TEXT",
      text: options.text,
      caption: null,
      sentAt: sentAt.toISOString(),
      sendStatus: "RECEIVED",
      media: null
    }
  };

  const chatEvent = {
    type: "telegram.chat.updated",
    eventId: randomUUID(),
    workspaceId: options.workspaceId,
    telegramAccountId: options.accountId,
    chatId: chat.id,
    lastMessagePreview: options.text.slice(0, 200),
    lastMessageAt: sentAt.toISOString(),
    lastMessageDirection: "INBOUND",
    unreadCount: updated.unreadCount,
    title: updated.title,
    firstName: updated.firstName,
    lastName: updated.lastName,
    username: updated.username,
    chatType: updated.chatType,
    isBot: updated.isBot,
    isPinned: updated.isPinned,
    identityResolved: true,
    needsCrmAttention: true,
    telegramChatId: options.telegramChatId
  };

  console.info(
    JSON.stringify({
      channel: "atlas.inbox.reliability",
      event: "worker.unread_increment",
      at: now(),
      chatId: chat.id,
      newUnreadCount: updated.unreadCount,
      telegramMessageId
    })
  );

  await redis.publish("atlas.workspace-events", JSON.stringify(messageEvent));
  console.info(
    JSON.stringify({
      channel: "atlas.inbox.reliability",
      event: "worker.ws_publish",
      at: now(),
      eventType: messageEvent.type,
      eventId: messageEvent.eventId,
      chatId: chat.id,
      ok: true
    })
  );
  await redis.publish("atlas.workspace-events", JSON.stringify(chatEvent));
  console.info(
    JSON.stringify({
      channel: "atlas.inbox.reliability",
      event: "worker.ws_publish",
      at: now(),
      eventType: chatEvent.type,
      eventId: chatEvent.eventId,
      chatId: chat.id,
      ok: true
    })
  );

  await redis.quit();
  return { messageId: message.id, unreadCount: updated.unreadCount, chatId: chat.id };
}

async function listChatUnread(token: string, accountId: string, chatId: string): Promise<number | null> {
  const result = await apiJson<Array<{ id: string; unreadCount: number }>>(
    `/api/telegram/accounts/${accountId}/chats`,
    { token }
  );
  if (result.status >= 400) {
    throw new Error(`list chats failed: ${result.status} ${JSON.stringify(result.body)}`);
  }
  const row = result.body.find((item) => item.id === chatId);
  return row?.unreadCount ?? null;
}

async function markRead(token: string, chatId: string): Promise<void> {
  const result = await apiJson<{ unreadCount?: number }>(`/api/telegram/chats/${chatId}/read`, {
    method: "POST",
    token
  });
  if (result.status >= 400) {
    throw new Error(`mark-read failed: ${result.status} ${JSON.stringify(result.body)}`);
  }
}

async function main(): Promise<void> {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const encryptionKey = process.env.TELEGRAM_SESSION_ENCRYPTION_KEY;
  if (!encryptionKey || encryptionKey.length < 32) {
    throw new Error("TELEGRAM_SESSION_ENCRYPTION_KEY missing/too short");
  }

  const health = await fetch(`${API}/health`).catch(() => null);
  if (!health || !health.ok) {
    throw new Error(`Backend not reachable at ${API}/health — start pnpm dev first`);
  }
  record("bootstrap", "backend_health", true, { api: API });

  const fixtures = await ensureFixtures(encryptionKey);
  record("bootstrap", "fixtures_ready", true, {
    workspaceId: fixtures.workspaceId,
    accountId: fixtures.accountId,
    existingChatId: fixtures.existingChatId
  });

  const staffA = await staffLogin(STAFF_A);
  const staffB = await staffLogin(STAFF_B);
  record("bootstrap", "staff_login", true, { staffA: staffA.userId, staffB: staffB.userId });

  const sockA = await openWorkspaceSocket(staffA.token);
  const sockB = await openWorkspaceSocket(staffB.token);
  record("bootstrap", "ws_connected", true, {
    staffAEvents: sockA.events.map((e) => e.type),
    staffBEvents: sockB.events.map((e) => e.type)
  });

  // -------- Scenario 1: single staff unread appear + clear --------
  {
    const scenario = "1_single_staff";
    const text = `S1 inbound ${Date.now()}`;
    const injected = await injectInbound({
      workspaceId: fixtures.workspaceId,
      accountId: fixtures.accountId,
      chatDbId: fixtures.existingChatId,
      telegramChatId: "900001",
      text
    });
    const evt = await sockA.waitFor(
      (p) => p.type === "telegram.message.created" && (p.chatDbId === fixtures.existingChatId || p.chatId === fixtures.existingChatId)
    );
    record(scenario, "ws_message_received", true, { eventId: evt.eventId, text });
    const unreadBefore = await listChatUnread(staffA.token, fixtures.accountId, fixtures.existingChatId);
    record(scenario, "unread_shown", unreadBefore !== null && unreadBefore > 0, { unreadBefore });
    await markRead(staffA.token, fixtures.existingChatId);
    const unreadAfter = await listChatUnread(staffA.token, fixtures.accountId, fixtures.existingChatId);
    const dbAfter = await prisma.telegramChat.findUnique({
      where: { id: fixtures.existingChatId },
      select: { unreadCount: true }
    });
    record(scenario, "unread_cleared", unreadAfter === 0 && dbAfter?.unreadCount === 0, {
      unreadAfter,
      dbUnread: dbAfter?.unreadCount ?? null,
      injectedUnread: injected.unreadCount
    });
  }

  // -------- Scenario 2: multi-staff --------
  {
    const scenario = "2_multi_staff";
    sockA.events.length = 0;
    sockB.events.length = 0;
    const text = `S2 inbound both ${Date.now()}`;
    await injectInbound({
      workspaceId: fixtures.workspaceId,
      accountId: fixtures.accountId,
      chatDbId: fixtures.existingChatId,
      telegramChatId: "900001",
      text
    });
    await Promise.all([
      sockA.waitFor((p) => p.type === "telegram.message.created"),
      sockB.waitFor((p) => p.type === "telegram.message.created")
    ]);
    const unreadA = await listChatUnread(staffA.token, fixtures.accountId, fixtures.existingChatId);
    const unreadB = await listChatUnread(staffB.token, fixtures.accountId, fixtures.existingChatId);
    record(scenario, "both_receive_unread", (unreadA ?? 0) > 0 && (unreadB ?? 0) > 0, { unreadA, unreadB });

    await markRead(staffA.token, fixtures.existingChatId);
    await Promise.all([
      sockA.waitFor((p) => p.type === "telegram.chat.updated" && p.chatId === fixtures.existingChatId && p.unreadCount === 0),
      sockB.waitFor((p) => p.type === "telegram.chat.updated" && p.chatId === fixtures.existingChatId && p.unreadCount === 0)
    ]);
    const clearedA = await listChatUnread(staffA.token, fixtures.accountId, fixtures.existingChatId);
    const clearedB = await listChatUnread(staffB.token, fixtures.accountId, fixtures.existingChatId);
    record(scenario, "both_cleared_after_a_open", clearedA === 0 && clearedB === 0, { clearedA, clearedB });

    sockA.events.length = 0;
    sockB.events.length = 0;
    await injectInbound({
      workspaceId: fixtures.workspaceId,
      accountId: fixtures.accountId,
      chatDbId: fixtures.existingChatId,
      telegramChatId: "900001",
      text: `S2 second ${Date.now()}`
    });
    await Promise.all([
      sockA.waitFor((p) => p.type === "telegram.message.created"),
      sockB.waitFor((p) => p.type === "telegram.message.created")
    ]);
    const againA = await listChatUnread(staffA.token, fixtures.accountId, fixtures.existingChatId);
    const againB = await listChatUnread(staffB.token, fixtures.accountId, fixtures.existingChatId);
    record(scenario, "unread_returns_both", (againA ?? 0) > 0 && (againB ?? 0) > 0, { againA, againB });
    await markRead(staffA.token, fixtures.existingChatId);
  }

  // -------- Scenario 3: multi-tab same account (two sockets) --------
  {
    const scenario = "3_multi_tab";
    const tab2 = await openWorkspaceSocket(staffA.token);
    sockA.events.length = 0;
    tab2.events.length = 0;
    await injectInbound({
      workspaceId: fixtures.workspaceId,
      accountId: fixtures.accountId,
      chatDbId: fixtures.existingChatId,
      telegramChatId: "900001",
      text: `S3 multitab ${Date.now()}`
    });
    await Promise.all([
      sockA.waitFor((p) => p.type === "telegram.message.created"),
      tab2.waitFor((p) => p.type === "telegram.message.created")
    ]);
    record(scenario, "both_tabs_receive", true, {
      tab1: sockA.events.filter((e) => e.type === "telegram.message.created").length,
      tab2: tab2.events.filter((e) => e.type === "telegram.message.created").length
    });
    await markRead(staffA.token, fixtures.existingChatId);
    await Promise.all([
      sockA.waitFor((p) => p.type === "telegram.chat.updated" && p.unreadCount === 0),
      tab2.waitFor((p) => p.type === "telegram.chat.updated" && p.unreadCount === 0)
    ]);
    record(scenario, "both_tabs_cleared", true, {});
    tab2.ws.close();
  }

  // -------- Scenario 4: background / resume reconcile (socket drop + REST catch-up) --------
  {
    const scenario = "4_browser_background";
    sockA.ws.close();
    record(scenario, "ws_disconnected", true, {});
    await new Promise((r) => setTimeout(r, 1500));
    const text = `S4 while away ${Date.now()}`;
    await injectInbound({
      workspaceId: fixtures.workspaceId,
      accountId: fixtures.accountId,
      chatDbId: fixtures.existingChatId,
      telegramChatId: "900001",
      text
    });
    const reopened = await openWorkspaceSocket(staffA.token);
    record(scenario, "ws_reconnected", true, {});
    const unread = await listChatUnread(staffA.token, fixtures.accountId, fixtures.existingChatId);
    record(scenario, "reconcile_after_resume", (unread ?? 0) > 0, { unread, text });
    await markRead(staffA.token, fixtures.existingChatId);
    // replace sockA for later scenarios
    Object.assign(sockA, reopened);
  }

  // -------- Scenario 5: temporary disconnect --------
  {
    const scenario = "5_network_disconnect";
    sockA.ws.close();
    record(scenario, "disconnect", true, {});
    const missed = `S5 missed ${Date.now()}`;
    await injectInbound({
      workspaceId: fixtures.workspaceId,
      accountId: fixtures.accountId,
      chatDbId: fixtures.existingChatId,
      telegramChatId: "900001",
      text: missed
    });
    const reconnected = await openWorkspaceSocket(staffA.token);
    const unread = await listChatUnread(staffA.token, fixtures.accountId, fixtures.existingChatId);
    const messages = await apiJson<Array<{ text?: string }> | { messages?: Array<{ text?: string }> }>(
      `/api/telegram/chats/${fixtures.existingChatId}/messages`,
      { token: staffA.token }
    );
    const rows = Array.isArray(messages.body) ? messages.body : messages.body.messages ?? [];
    const found = rows.some((m) => m.text === missed);
    record(scenario, "no_lost_messages_after_reconnect", found && (unread ?? 0) > 0, {
      found,
      unread,
      messageCount: rows.length
    });
    await markRead(staffA.token, fixtures.existingChatId);
    Object.assign(sockA, reconnected);
  }

  // -------- Scenario 7: new conversation --------
  {
    const scenario = "7_new_conversation";
    sockA.events.length = 0;
    sockB.events.length = 0;
    const text = `S7 brand new ${Date.now()}`;
    const created = await injectInbound({
      workspaceId: fixtures.workspaceId,
      accountId: fixtures.accountId,
      telegramChatId: fixtures.newChatPeerId,
      text,
      title: "Brand New Customer",
      createChat: true
    });
    await Promise.all([
      sockA.waitFor((p) => p.type === "telegram.chat.updated" && p.chatId === created.chatId),
      sockB.waitFor((p) => p.type === "telegram.chat.updated" && p.chatId === created.chatId)
    ]);
    const unreadA = await listChatUnread(staffA.token, fixtures.accountId, created.chatId);
    record(scenario, "new_row_appears", (unreadA ?? 0) > 0, { chatId: created.chatId, unreadA });
    await markRead(staffA.token, created.chatId);
  }

  // -------- Scenario 8: existing conversation latest message --------
  {
    const scenario = "8_existing_conversation";
    sockA.events.length = 0;
    const text = `S8 latest ${Date.now()}`;
    await injectInbound({
      workspaceId: fixtures.workspaceId,
      accountId: fixtures.accountId,
      chatDbId: fixtures.existingChatId,
      telegramChatId: "900001",
      text
    });
    await sockA.waitFor((p) => p.type === "telegram.message.created");
    const unread = await listChatUnread(staffA.token, fixtures.accountId, fixtures.existingChatId);
    const chat = await prisma.telegramChat.findUnique({
      where: { id: fixtures.existingChatId },
      select: { lastMessagePreview: true, unreadCount: true }
    });
    record(scenario, "latest_message_and_unread", chat?.lastMessagePreview === text && (unread ?? 0) > 0, {
      preview: chat?.lastMessagePreview,
      unread,
      dbUnread: chat?.unreadCount
    });
    await markRead(staffA.token, fixtures.existingChatId);
  }

  // -------- Scenario 6 note: process restart requires external orchestration --------
  record("6_server_restart", "requires_orchestrated_restart", false, {
    note: "Runner verifies reconnect/reconcile paths in scenarios 4-5. Full process restart is executed by the outer shell harness."
  });

  sockA.ws.close();
  sockB.ws.close();

  const failed = evidence.filter((e) => !e.ok && e.scenario !== "6_server_restart");
  const summary = {
    at: now(),
    api: API,
    passed: failed.length === 0,
    failedCount: failed.length,
    steps: evidence,
    fingerprint: createHash("sha256").update(JSON.stringify(evidence)).digest("hex").slice(0, 16)
  };
  writeFileSync(join(EVIDENCE_DIR, "matrix-api-ws.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(EVIDENCE_DIR, "matrix-api-ws.log"), evidence.map((e) => JSON.stringify(e)).join("\n"));
  console.log(JSON.stringify({ channel: "atlas.live.matrix.summary", passed: summary.passed, failedCount: summary.failedCount, evidenceDir: EVIDENCE_DIR }));
  if (!summary.passed) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
