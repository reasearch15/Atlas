import { normalizeMarkedTelegramChatId } from "@atlas/shared";
import type { TelegramRuntime } from "./telegram-client";

export type TelegramPeerType = "USER" | "CHAT" | "CHANNEL";

export interface PeerResolutionHints {
  readonly telegramChatId: string;
  readonly chatType?: string | null;
  readonly username?: string | null;
  readonly accessHash?: string | null;
  readonly peerType?: TelegramPeerType | string | null;
  readonly phone?: string | null;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
}

export interface ResolvedTelegramPeer {
  readonly entity: unknown;
  readonly inputPeer: unknown;
  readonly accessHash: string | null;
  readonly peerType: TelegramPeerType;
  readonly username: string | null;
  readonly phone: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly telegramChatId: string;
}

/**
 * Raised after every peer-resolution strategy fails. Safe for user-facing messages.
 */
export class TelegramPeerUnresolvedError extends Error {
  public readonly code = "TELEGRAM_PEER_UNRESOLVED";

  public constructor(
    message = "This Telegram chat cannot be reached right now. Atlas has no access hash for this peer yet — open or message the chat from Telegram once, then sync again."
  ) {
    super(message);
    this.name = "TelegramPeerUnresolvedError";
  }
}

/**
 * Central GramJS input-peer resolver.
 * Never constructs InputPeerUser/Channel without accessHash, and never passes bare numeric user ids.
 */
export async function resolveInputPeer(
  runtime: TelegramRuntime,
  chat: PeerResolutionHints
): Promise<ResolvedTelegramPeer> {
  return resolveTelegramPeer(runtime, chat);
}

/**
 * Resolves a GramJS entity/input peer without relying on a raw user id alone.
 * Order: stored InputPeer → username → phone → dialogs/entities → GetUsers/GetChannels → fail cleanly.
 */
export async function resolveTelegramPeer(
  runtime: TelegramRuntime,
  hints: PeerResolutionHints
): Promise<ResolvedTelegramPeer> {
  const errors: string[] = [];
  const peerTypeHint = normalizePeerType(hints.peerType, hints.chatType, hints.telegramChatId);

  if (hints.accessHash && peerTypeHint && peerTypeHint !== "CHAT") {
    try {
      const inputPeer = await buildInputPeer(runtime, hints.telegramChatId, peerTypeHint, hints.accessHash);
      const enriched =
        (await tryGetEntity(runtime, inputPeer)) ??
        (await fetchViaGetUsersOrChannels(runtime, hints)) ??
        inputPeer;
      return await toResolved(runtime, enriched, hints.telegramChatId, inputPeer, hints);
    } catch (error) {
      errors.push(`input_peer:${errorMessage(error)}`);
    }
  }

  if (peerTypeHint === "CHAT") {
    try {
      const inputPeer = await buildInputPeer(runtime, hints.telegramChatId, "CHAT", null);
      const entity = (await tryGetEntity(runtime, inputPeer)) ?? inputPeer;
      return await toResolved(runtime, entity, hints.telegramChatId, inputPeer, hints);
    } catch (error) {
      errors.push(`chat_peer:${errorMessage(error)}`);
    }
  }

  const username = cleanUsername(hints.username);
  if (username) {
    try {
      const entity = (await tryGetEntity(runtime, username)) ?? (await resolveUsernameInvoke(runtime, username));
      if (entity) return await toResolved(runtime, entity, hints.telegramChatId, undefined, hints);
    } catch (error) {
      errors.push(`username:${errorMessage(error)}`);
    }
  }

  if (hints.phone) {
    try {
      const entity = await tryGetEntity(runtime, hints.phone);
      if (entity) return await toResolved(runtime, entity, hints.telegramChatId, undefined, hints);
    } catch (error) {
      errors.push(`phone:${errorMessage(error)}`);
    }
  }

  // Prefer local session entity cache before any dialogs network fetch.
  try {
    const fromCache = await findInEntityCache(runtime, hints.telegramChatId);
    if (fromCache) return await toResolved(runtime, fromCache, hints.telegramChatId, undefined, hints);
  } catch (error) {
    errors.push(`entity_cache:${errorMessage(error)}`);
  }

  // Scan cached dialogs (at most one GetDialogs per runtime until invalidated).
  try {
    const fromDialogs = await findInDialogs(runtime, hints.telegramChatId);
    if (fromDialogs) return await toResolved(runtime, fromDialogs, hints.telegramChatId, undefined, hints);
  } catch (error) {
    errors.push(`dialogs:${errorMessage(error)}`);
  }

  try {
    const fromApi = await fetchViaGetUsersOrChannels(runtime, hints);
    if (fromApi) return await toResolved(runtime, fromApi, hints.telegramChatId, undefined, hints);
  } catch (error) {
    errors.push(`get_users_channels:${errorMessage(error)}`);
  }

  throw new TelegramPeerUnresolvedError(
    `Could not resolve Telegram peer ${hints.telegramChatId}. Tried stored access hash, username, dialogs, entity cache, and API lookup.`
  );
}

/**
 * Extracts durable peer fields from a GramJS user/chat/channel entity.
 */
export function extractPeerFields(
  entity: unknown,
  telegramChatId: string
): {
  readonly accessHash: string | null;
  readonly peerType: TelegramPeerType;
  readonly username: string | null;
  readonly phone: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly telegramChatId: string;
} {
  const value = (entity ?? {}) as Record<string, unknown>;
  const className = String(value.className ?? value._ ?? "");
  let peerType: TelegramPeerType = "USER";
  if (className.includes("Channel") || className.includes("InputPeerChannel") || className.includes("InputChannel")) {
    peerType = "CHANNEL";
  } else if (className.includes("Chat") && !className.includes("Channel")) {
    peerType = "CHAT";
  } else if (className.includes("User") || className.includes("InputPeerUser") || className.includes("InputUser")) {
    peerType = "USER";
  } else {
    peerType = normalizePeerType(null, null, telegramChatId) ?? "USER";
  }

  const accessHash =
    accessHashAsString(value.accessHash) ??
    extractAccessHashFromPeerCandidate(value);
  const username = typeof value.username === "string" && value.username.trim() ? value.username.trim() : null;
  const phone = typeof value.phone === "string" && value.phone.trim() ? value.phone.trim() : null;
  const firstName = typeof value.firstName === "string" && value.firstName.trim() ? value.firstName.trim() : null;
  const lastName = typeof value.lastName === "string" && value.lastName.trim() ? value.lastName.trim() : null;
  const chatType =
    peerType === "CHANNEL" ? (value.megagroup ? "SUPERGROUP" : "CHANNEL") : peerType === "CHAT" ? "GROUP" : "PRIVATE";

  return {
    accessHash,
    peerType,
    username,
    phone,
    firstName,
    lastName,
    telegramChatId: normalizeMarkedTelegramChatId(String(value.id ?? telegramChatId), chatType)
  };
}

export function normalizePeerType(
  peerType: string | null | undefined,
  chatType: string | null | undefined,
  telegramChatId?: string
): TelegramPeerType | null {
  const peer = (peerType ?? "").toUpperCase();
  if (peer === "USER" || peer === "CHAT" || peer === "CHANNEL") return peer;
  const chat = (chatType ?? "").toUpperCase();
  if (chat === "PRIVATE") return "USER";
  if (chat === "GROUP") return "CHAT";
  if (chat === "SUPERGROUP" || chat === "CHANNEL") return "CHANNEL";
  if (telegramChatId?.startsWith("-100")) return "CHANNEL";
  if (telegramChatId?.startsWith("-") && !telegramChatId.startsWith("-100")) return "CHAT";
  if (telegramChatId && /^-?\d+$/.test(telegramChatId) && !telegramChatId.startsWith("-")) return "USER";
  return null;
}

/**
 * True when an error is a per-peer GramJS failure (not account auth).
 */
export function isPeerEntityResolutionError(error: unknown): boolean {
  if (error instanceof TelegramPeerUnresolvedError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return (
    /Could not find the input entity/i.test(message) ||
    /TELEGRAM_PEER_UNRESOLVED/i.test(message) ||
    /INPUT_USER_DEACTIVATED/i.test(message) ||
    /USER_DEACTIVATED|PEER_ID_INVALID|CHAT_ID_INVALID|CHANNEL_INVALID/i.test(message)
  );
}

async function buildInputPeer(
  runtime: TelegramRuntime,
  telegramChatId: string,
  peerType: TelegramPeerType,
  accessHash: string | null
): Promise<unknown> {
  const api = runtime.Api as {
    InputPeerUser: new (input: { userId: unknown; accessHash: unknown }) => unknown;
    InputPeerChat: new (input: { chatId: unknown }) => unknown;
    InputPeerChannel: new (input: { channelId: unknown; accessHash: unknown }) => unknown;
  };
  const { returnBigInt } = await import("telegram/Helpers");
  const numericId = barePeerId(telegramChatId, peerType);

  if (peerType === "USER") {
    if (!accessHash) throw new Error("USER peer requires access_hash");
    return new api.InputPeerUser({ userId: returnBigInt(numericId), accessHash: returnBigInt(accessHash) });
  }
  if (peerType === "CHAT") {
    return new api.InputPeerChat({ chatId: returnBigInt(numericId) });
  }
  if (!accessHash) throw new Error("CHANNEL peer requires access_hash");
  return new api.InputPeerChannel({ channelId: returnBigInt(numericId), accessHash: returnBigInt(accessHash) });
}

async function tryGetEntity(runtime: TelegramRuntime, candidate: unknown): Promise<unknown | null> {
  // Never feed bare numeric / PeerUser ids into getEntity — that is the PeerUser failure mode.
  if (isBareNumericPeerCandidate(candidate)) {
    return null;
  }
  try {
    return await runtime.client.getEntity(candidate as string | number);
  } catch (error) {
    if (isPeerEntityResolutionError(error)) return null;
    return null;
  }
}

function isBareNumericPeerCandidate(candidate: unknown): boolean {
  if (typeof candidate === "number" && Number.isFinite(candidate)) return true;
  if (typeof candidate === "bigint") return true;
  if (typeof candidate === "string" && /^-?\d+$/.test(candidate.trim())) return true;
  if (candidate && typeof candidate === "object") {
    const value = candidate as Record<string, unknown>;
    const className = String(value.className ?? value._ ?? "");
    if (className === "PeerUser" || className === "PeerChannel" || className === "PeerChat") return true;
    // InputPeer* with accessHash is allowed; PeerUser-shaped { userId } without accessHash is not.
    if ("userId" in value && !("accessHash" in value)) return true;
  }
  return false;
}

async function resolveUsernameInvoke(runtime: TelegramRuntime, username: string): Promise<unknown | null> {
  const api = runtime.Api as {
    contacts: { ResolveUsername: new (input: { username: string }) => unknown };
  };
  const resolved = (await runtime.client.invoke(
    new api.contacts.ResolveUsername({ username: username.replace(/^@/, "") })
  )) as {
    users?: unknown[];
    chats?: unknown[];
    peer?: unknown;
  };
  if (resolved.users?.[0]) return resolved.users[0];
  if (resolved.chats?.[0]) return resolved.chats[0];
  return null;
}

async function findInDialogs(runtime: TelegramRuntime, telegramChatId: string): Promise<unknown | null> {
  const cache = await ensureDialogEntityCache(runtime, false);
  return lookupDialogEntity(cache, telegramChatId);
}

/**
 * Loads dialog entities once per live runtime and caches them for peer resolution.
 * Subsequent peer lookups reuse this cache — never polls GetDialogs continuously.
 */
export async function prefetchDialogEntities(runtime: TelegramRuntime, force = false): Promise<number> {
  const cache = await ensureDialogEntityCache(runtime, force);
  return cache.byId.size;
}

/**
 * Drops the dialog metadata cache so the next resolve can refresh explicitly.
 */
export function invalidateDialogEntities(runtime: TelegramRuntime): void {
  dialogEntityCache.delete(runtime.client);
}

/**
 * Seeds the dialog entity cache from an already-fetched GetDialogs result.
 * Avoids a second network round-trip after listDialogs / initial sync.
 */
export function seedDialogEntities(runtime: TelegramRuntime, dialogs: readonly unknown[]): void {
  const byId = new Map<string, unknown>();
  for (const dialog of dialogs) {
    indexDialogEntity(byId, dialog);
  }
  dialogEntityCache.set(runtime.client, { byId, fetchedAt: Date.now(), inflight: null });
}

interface DialogEntityCache {
  readonly byId: Map<string, unknown>;
  readonly fetchedAt: number;
  inflight: Promise<DialogEntityCache> | null;
}

/** One GetDialogs snapshot per Telegram client instance. */
const dialogEntityCache = new WeakMap<object, DialogEntityCache>();
const DIALOG_CACHE_TTL_MS = 30 * 60 * 1000;

async function ensureDialogEntityCache(runtime: TelegramRuntime, force: boolean): Promise<DialogEntityCache> {
  const existing = dialogEntityCache.get(runtime.client);
  if (!force && existing && Date.now() - existing.fetchedAt < DIALOG_CACHE_TTL_MS) {
    return existing;
  }
  if (!force && existing?.inflight) {
    return existing.inflight;
  }

  const inflight = (async (): Promise<DialogEntityCache> => {
    const dialogs = await runtime.client.getDialogs({ limit: 500 });
    const byId = new Map<string, unknown>();
    for (const dialog of dialogs) {
      indexDialogEntity(byId, dialog);
    }
    const next: DialogEntityCache = { byId, fetchedAt: Date.now(), inflight: null };
    dialogEntityCache.set(runtime.client, next);
    return next;
  })();

  dialogEntityCache.set(runtime.client, {
    byId: existing?.byId ?? new Map(),
    fetchedAt: existing?.fetchedAt ?? 0,
    inflight
  });

  try {
    return await inflight;
  } catch (error) {
    dialogEntityCache.delete(runtime.client);
    throw error;
  }
}

function indexDialogEntity(byId: Map<string, unknown>, dialog: unknown): void {
  const value = dialog as Record<string, unknown>;
  const entity = (value.entity ?? value) as Record<string, unknown>;
  const peer = (value.peer ?? null) as Record<string, unknown> | null;
  const ids = [value.id, entity.id, peer?.userId, peer?.channelId, peer?.chatId].filter((id) => id != null).map(String);
  for (const id of ids) {
    byId.set(id, entity);
    if (id.startsWith("-100") && id.length > 4) byId.set(id.slice(4), entity);
    else if (!id.startsWith("-")) byId.set(`-100${id}`, entity);
  }
}

function lookupDialogEntity(cache: DialogEntityCache, telegramChatId: string): unknown | null {
  for (const target of idMatchTargets(telegramChatId)) {
    const hit = cache.byId.get(target);
    if (hit) return hit;
  }
  return null;
}

async function findInEntityCache(runtime: TelegramRuntime, telegramChatId: string): Promise<unknown | null> {
  const session = runtime.client.session as {
    getEntityRowsById?: (id: unknown) => unknown;
    _entities?: Map<string, unknown> | Record<string, unknown>;
  };
  const targets = idMatchTargets(telegramChatId);
  for (const target of targets) {
    try {
      if (typeof session.getEntityRowsById === "function") {
        const row = session.getEntityRowsById(target);
        if (row) return row;
      }
    } catch {
      // ignore cache miss
    }
  }
  const entities = session._entities;
  if (entities instanceof Map) {
    for (const [key, value] of entities.entries()) {
      if (targets.includes(String(key)) || targets.includes(String((value as { id?: unknown })?.id ?? ""))) {
        return value;
      }
    }
  } else if (entities && typeof entities === "object") {
    for (const [key, value] of Object.entries(entities)) {
      if (targets.includes(String(key)) || targets.includes(String((value as { id?: unknown })?.id ?? ""))) {
        return value;
      }
    }
  }
  return null;
}

async function fetchViaGetUsersOrChannels(runtime: TelegramRuntime, hints: PeerResolutionHints): Promise<unknown | null> {
  const peerType = normalizePeerType(hints.peerType, hints.chatType, hints.telegramChatId);
  if (!peerType || !hints.accessHash) return null;
  const { returnBigInt } = await import("telegram/Helpers");
  const api = runtime.Api as {
    users: { GetUsers: new (input: { id: unknown[] }) => unknown };
    channels: { GetChannels: new (input: { id: unknown[] }) => unknown };
    InputUser: new (input: { userId: unknown; accessHash: unknown }) => unknown;
    InputChannel: new (input: { channelId: unknown; accessHash: unknown }) => unknown;
  };
  const numericId = barePeerId(hints.telegramChatId, peerType);
  if (peerType === "USER") {
    const users = (await runtime.client.invoke(
      new api.users.GetUsers({
        id: [new api.InputUser({ userId: returnBigInt(numericId), accessHash: returnBigInt(hints.accessHash) })]
      })
    )) as unknown[];
    return users?.[0] ?? null;
  }
  if (peerType === "CHANNEL") {
    const result = (await runtime.client.invoke(
      new api.channels.GetChannels({
        id: [new api.InputChannel({ channelId: returnBigInt(numericId), accessHash: returnBigInt(hints.accessHash) })]
      })
    )) as { chats?: unknown[] };
    return result.chats?.[0] ?? null;
  }
  return null;
}

async function toResolved(
  runtime: TelegramRuntime,
  entity: unknown,
  telegramChatId: string,
  inputPeer?: unknown,
  hints?: PeerResolutionHints
): Promise<ResolvedTelegramPeer> {
  const fields = extractPeerFields(entity, telegramChatId);
  const peerType = fields.peerType;
  const accessHash = fields.accessHash ?? hints?.accessHash ?? null;
  let resolvedInput = inputPeer;
  if (!resolvedInput) {
    if (peerType === "CHAT") {
      resolvedInput = await buildInputPeer(runtime, fields.telegramChatId || telegramChatId, "CHAT", null);
    } else if (accessHash) {
      resolvedInput = await buildInputPeer(runtime, fields.telegramChatId || telegramChatId, peerType, accessHash);
    } else {
      throw new TelegramPeerUnresolvedError(
        `Resolved entity for ${telegramChatId} but no access hash is available to build InputPeer${peerType === "USER" ? "User" : "Channel"}.`
      );
    }
  }
  return {
    entity,
    inputPeer: resolvedInput,
    accessHash,
    peerType,
    username: fields.username ?? hints?.username ?? null,
    phone: fields.phone ?? hints?.phone ?? null,
    firstName: fields.firstName ?? hints?.firstName ?? null,
    lastName: fields.lastName ?? hints?.lastName ?? null,
    telegramChatId: fields.telegramChatId
  };
}

function barePeerId(telegramChatId: string, peerType: TelegramPeerType): string {
  if (peerType === "CHANNEL" && telegramChatId.startsWith("-100")) {
    return telegramChatId.slice(4);
  }
  if (peerType === "CHAT" && telegramChatId.startsWith("-") && !telegramChatId.startsWith("-100")) {
    return telegramChatId.slice(1);
  }
  return telegramChatId.replace(/^-/, "");
}

function idMatchTargets(telegramChatId: string): string[] {
  const targets = new Set<string>([telegramChatId]);
  if (!/^-?\d+$/.test(telegramChatId)) return [...targets];
  if (telegramChatId.startsWith("-100") && telegramChatId.length > 4) {
    targets.add(telegramChatId.slice(4));
  } else if (telegramChatId.startsWith("-") && !telegramChatId.startsWith("-100")) {
    targets.add(telegramChatId.slice(1));
  } else if (!telegramChatId.startsWith("-")) {
    targets.add(`-100${telegramChatId}`);
  }
  return [...targets];
}

/**
 * Persist access hashes as strings only — never Number(), which corrupts large Telegram hashes.
 */
export function accessHashAsString(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" && value.trim()) return value.trim();
  // Prefer toString on objects (e.g. big-integer) over Number()
  if (typeof value === "object" && value !== null && "toString" in value) {
    const text = String(value);
    if (/^-?\d+$/.test(text)) return text;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // Already-lossy Number values — keep as integer string only when safe.
    if (Number.isSafeInteger(value)) return String(value);
    return BigInt(Math.trunc(value)).toString();
  }
  const text = String(value);
  return /^-?\d+$/.test(text) ? text : null;
}

/**
 * Extracts accessHash from InputPeerUser / InputPeerChannel / User / Channel shapes.
 */
export function extractAccessHashFromPeerCandidate(candidate: unknown): string | null {
  if (!candidate || typeof candidate !== "object") return null;
  const value = candidate as Record<string, unknown>;
  const direct = accessHashAsString(value.accessHash);
  if (direct) return direct;
  // Some GramJS wrappers nest the peer.
  if (value.peer && typeof value.peer === "object") {
    return accessHashAsString((value.peer as Record<string, unknown>).accessHash);
  }
  return null;
}

/**
 * Returns true when a private USER peer is missing durable InputPeer fields.
 */
export function isIncompletePrivatePeer(input: {
  readonly chatType?: string | null;
  readonly peerType?: string | null;
  readonly accessHash?: string | null;
  readonly telegramChatId?: string | null;
}): boolean {
  const peerType = normalizePeerType(input.peerType, input.chatType, input.telegramChatId ?? undefined);
  if (peerType !== "USER") return false;
  return !input.accessHash || !String(input.accessHash).trim();
}

/**
 * Merges identity fields preferring non-null incoming values without clobbering
 * an existing non-null accessHash/peerType with null.
 */
export function coalescePeerPersistenceFields(
  existing: {
    readonly accessHash?: string | null;
    readonly peerType?: string | null;
    readonly firstName?: string | null;
    readonly lastName?: string | null;
    readonly username?: string | null;
    readonly peerPhone?: string | null;
    readonly chatType?: string | null;
  },
  incoming: {
    readonly accessHash?: string | null;
    readonly peerType?: string | null;
    readonly firstName?: string | null;
    readonly lastName?: string | null;
    readonly username?: string | null;
    readonly phone?: string | null;
    readonly chatType?: string | null;
  }
): {
  readonly accessHash: string | null;
  readonly peerType: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly username: string | null;
  readonly peerPhone: string | null;
  readonly chatType: string;
} {
  return {
    accessHash: incoming.accessHash?.trim() || existing.accessHash || null,
    peerType: incoming.peerType || existing.peerType || null,
    firstName: incoming.firstName || existing.firstName || null,
    lastName: incoming.lastName || existing.lastName || null,
    username: incoming.username || existing.username || null,
    peerPhone: incoming.phone || existing.peerPhone || null,
    chatType:
      incoming.chatType && incoming.chatType !== "UNKNOWN"
        ? incoming.chatType
        : existing.chatType && existing.chatType !== "UNKNOWN"
          ? existing.chatType
          : incoming.chatType || existing.chatType || "PRIVATE"
  };
}

function cleanUsername(username: string | null | undefined): string | null {
  if (!username) return null;
  const cleaned = username.trim().replace(/^@/, "");
  return cleaned.length > 0 ? cleaned : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
