import { isTemporaryTelegramUserTitle, normalizeMarkedTelegramChatId } from "@atlas/shared";
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
 * Raised when stored peer metadata cannot be parsed into a GramJS InputPeer.
 * Distinct from entity-lookup failure and Telegram RPC peer rejection.
 */
export class TelegramPeerConstructionError extends Error {
  public readonly code = "TELEGRAM_PEER_CONSTRUCTION_FAILED";

  public constructor(message: string) {
    super(message);
    this.name = "TelegramPeerConstructionError";
  }
}

/**
 * Raised when access_hash / telegram_chat_id cannot be parsed as BigInt.
 */
export class TelegramAccessHashParseError extends Error {
  public readonly code = "TELEGRAM_ACCESS_HASH_PARSE_FAILED";

  public constructor(message: string) {
    super(message);
    this.name = "TelegramAccessHashParseError";
  }
}

export interface PeerConstructionDiagnostics {
  readonly peerType: string | null;
  readonly telegramChatIdPresent: boolean;
  readonly accessHashPresent: boolean;
  readonly telegramChatIdParseOk: boolean;
  readonly accessHashParseOk: boolean;
  readonly constructedPeerClass: string | null;
  readonly resolutionPath: string;
}

/**
 * Safe peer-construction diagnostics — never includes access hash values.
 */
export function buildPeerConstructionDiagnostics(
  hints: PeerResolutionHints,
  constructedPeerClass: string | null = null,
  resolutionPath = "stored_direct"
): PeerConstructionDiagnostics {
  const peerType = normalizePeerType(hints.peerType, hints.chatType, hints.telegramChatId);
  const telegramChatIdPresent = Boolean(hints.telegramChatId?.trim());
  const accessHashPresent = Boolean(hints.accessHash != null && String(hints.accessHash).trim());
  let telegramChatIdParseOk = false;
  let accessHashParseOk = false;
  try {
    if (telegramChatIdPresent && peerType) {
      parseTelegramBigInt(barePeerId(hints.telegramChatId, peerType), "telegramChatId");
      telegramChatIdParseOk = true;
    }
  } catch {
    telegramChatIdParseOk = false;
  }
  try {
    if (accessHashPresent) {
      parseTelegramBigInt(hints.accessHash, "accessHash");
      accessHashParseOk = true;
    }
  } catch {
    accessHashParseOk = false;
  }
  return {
    peerType,
    telegramChatIdPresent,
    accessHashPresent,
    telegramChatIdParseOk,
    accessHashParseOk,
    constructedPeerClass,
    resolutionPath
  };
}

/**
 * Read-only compare of stored peer metadata vs live dialog/entity fields.
 * Never prints access hash values — only presence and equality flags.
 */
export function diagnoseStoredPeerAgainstLive(
  stored: {
    readonly peerType?: string | null;
    readonly telegramChatId?: string | null;
    readonly accessHash?: string | null;
  },
  live: {
    readonly peerType?: string | null;
    readonly telegramChatId?: string | null;
    readonly accessHash?: string | null;
  } | null
): {
  readonly storedPeerType: string | null;
  readonly storedTelegramChatIdPresent: boolean;
  readonly storedAccessHashPresent: boolean;
  readonly liveAvailable: boolean;
  readonly livePeerType: string | null;
  readonly liveTelegramChatIdPresent: boolean;
  readonly liveAccessHashPresent: boolean;
  readonly peerTypeMatches: boolean | null;
  readonly telegramChatIdMatches: boolean | null;
  readonly accessHashMatches: boolean | null;
  readonly possibleStaleAccessHash: boolean;
} {
  const storedHash = accessHashAsString(stored.accessHash);
  const liveHash = live ? accessHashAsString(live.accessHash) : null;
  const accessHashMatches =
    storedHash && liveHash ? storedHash === liveHash : storedHash || liveHash ? false : null;
  return {
    storedPeerType: stored.peerType ? String(stored.peerType).toUpperCase() : null,
    storedTelegramChatIdPresent: Boolean(stored.telegramChatId?.trim()),
    storedAccessHashPresent: Boolean(storedHash),
    liveAvailable: Boolean(live),
    livePeerType: live?.peerType ? String(live.peerType).toUpperCase() : null,
    liveTelegramChatIdPresent: Boolean(live?.telegramChatId?.trim()),
    liveAccessHashPresent: Boolean(liveHash),
    peerTypeMatches:
      stored.peerType && live?.peerType
        ? String(stored.peerType).toUpperCase() === String(live.peerType).toUpperCase()
        : null,
    telegramChatIdMatches:
      stored.telegramChatId && live?.telegramChatId
        ? String(stored.telegramChatId) === String(live.telegramChatId)
        : null,
    accessHashMatches,
    possibleStaleAccessHash: accessHashMatches === false
  };
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
 * Order: stored InputPeer (immediate) → username → phone → dialogs/entities → GetUsers/GetChannels → fail cleanly.
 *
 * When stored USER/CHANNEL peer_type + access_hash construct a valid InputPeer, that peer is returned
 * immediately. Enrichment failures must never discard a successfully constructed InputPeer.
 */
export async function resolveTelegramPeer(
  runtime: TelegramRuntime,
  hints: PeerResolutionHints
): Promise<ResolvedTelegramPeer> {
  const errors: string[] = [];
  const peerTypeHint = normalizePeerType(hints.peerType, hints.chatType, hints.telegramChatId);

  if (hints.accessHash && peerTypeHint && peerTypeHint !== "CHAT") {
    const preDiagnostics = buildPeerConstructionDiagnostics(hints, null, "stored_direct");
    logPeerConstructionDiagnostics(preDiagnostics);

    if (!preDiagnostics.telegramChatIdParseOk || !preDiagnostics.accessHashParseOk) {
      errors.push(
        `direct_construction_parse:telegramChatIdParseOk=${preDiagnostics.telegramChatIdParseOk},accessHashParseOk=${preDiagnostics.accessHashParseOk}`
      );
    } else {
      try {
        const inputPeer = await buildInputPeer(
          runtime,
          hints.telegramChatId,
          peerTypeHint,
          hints.accessHash
        );
        const constructedPeerClass = peerClassName(inputPeer);
        logPeerConstructionDiagnostics(
          buildPeerConstructionDiagnostics(hints, constructedPeerClass, "stored_direct")
        );

        // Direct construction succeeded — use immediately. Soft enrichment must not discard it.
        let entity: unknown = inputPeer;
        try {
          const fromCache = await tryGetEntity(runtime, inputPeer);
          if (fromCache) {
            entity = fromCache;
            const liveFields = extractPeerFields(fromCache, hints.telegramChatId);
            logPlainSerializable({
              event: "telegram_peer.stored_vs_live",
              ...diagnoseStoredPeerAgainstLive(
                {
                  peerType: peerTypeHint,
                  telegramChatId: hints.telegramChatId,
                  accessHash: hints.accessHash
                },
                {
                  peerType: liveFields.peerType,
                  telegramChatId: liveFields.telegramChatId,
                  accessHash: liveFields.accessHash
                }
              )
            });
          }
        } catch (enrichError) {
          errors.push(`direct_enrich_cache:${errorMessage(enrichError)}`);
        }

        return await toResolved(runtime, entity, hints.telegramChatId, inputPeer, hints);
      } catch (error) {
        if (
          error instanceof TelegramPeerConstructionError ||
          error instanceof TelegramAccessHashParseError
        ) {
          errors.push(`direct_construction:${errorMessage(error)}`);
        } else {
          errors.push(`direct_construction_unexpected:${errorMessage(error)}`);
        }
      }
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
 * True when an error is a per-peer GramJS entity-lookup failure (not account auth).
 * Used to soft-fail getEntity probes — not to collapse sendMessage RPC errors.
 */
export function isPeerEntityResolutionError(error: unknown): boolean {
  if (error instanceof TelegramPeerUnresolvedError) return true;
  if (error instanceof TelegramPeerConstructionError) return true;
  if (error instanceof TelegramAccessHashParseError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return (
    /Could not find the input entity/i.test(message) ||
    /TELEGRAM_PEER_UNRESOLVED/i.test(message) ||
    /TELEGRAM_PEER_CONSTRUCTION_FAILED/i.test(message) ||
    /TELEGRAM_ACCESS_HASH_PARSE_FAILED/i.test(message) ||
    /INPUT_USER_DEACTIVATED/i.test(message) ||
    /USER_DEACTIVATED|PEER_ID_INVALID|CHAT_ID_INVALID|CHANNEL_INVALID/i.test(message)
  );
}

/**
 * Classifies Telegram RPC peer rejection on send/read — preserves original error codes.
 * Returns null when the error is not a known peer RPC rejection.
 */
export function classifyTelegramPeerRpcError(error: unknown): {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly telegramErrorCode: string | null;
} | null {
  if (error instanceof TelegramPeerUnresolvedError) {
    return {
      code: error.code,
      message: error.message,
      retryable: true,
      telegramErrorCode: null
    };
  }
  if (error instanceof TelegramPeerConstructionError || error instanceof TelegramAccessHashParseError) {
    return {
      code: error.code,
      message: error.message,
      retryable: true,
      telegramErrorCode: null
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const telegramErrorCode = extractTelegramRpcErrorCode(message);
  if (/ACCESS_HASH_INVALID|ACCESS_HASH_EXPIRED/i.test(message)) {
    return {
      code: "TELEGRAM_ACCESS_HASH_INVALID",
      message:
        "Telegram rejected the stored access hash for this peer. Open the chat in Telegram once, then sync again.",
      retryable: true,
      telegramErrorCode: telegramErrorCode ?? "ACCESS_HASH_INVALID"
    };
  }
  if (/PEER_ID_INVALID/i.test(message)) {
    return {
      code: "TELEGRAM_PEER_ID_INVALID",
      message: "Telegram rejected this peer id (PEER_ID_INVALID).",
      retryable: true,
      telegramErrorCode: "PEER_ID_INVALID"
    };
  }
  if (/INPUT_USER_DEACTIVATED|USER_DEACTIVATED/i.test(message)) {
    return {
      code: "TELEGRAM_PEER_DEACTIVATED",
      message: "This Telegram user account is deactivated. Messages cannot be sent to this peer.",
      retryable: false,
      telegramErrorCode: telegramErrorCode ?? "INPUT_USER_DEACTIVATED"
    };
  }
  if (/CHAT_ID_INVALID|CHANNEL_INVALID|CHANNEL_PRIVATE/i.test(message)) {
    return {
      code: "TELEGRAM_PEER_REJECTED",
      message: `Telegram rejected this peer (${telegramErrorCode ?? "PEER_REJECTED"}).`,
      retryable: true,
      telegramErrorCode
    };
  }
  return null;
}

export function extractTelegramRpcErrorCode(message: string): string | null {
  const match = message.match(
    /\b(ACCESS_HASH_INVALID|ACCESS_HASH_EXPIRED|PEER_ID_INVALID|CHAT_ID_INVALID|CHANNEL_INVALID|CHANNEL_PRIVATE|INPUT_USER_DEACTIVATED|USER_DEACTIVATED|USERNAME_NOT_OCCUPIED|FLOOD_WAIT_\d+)\b/i
  );
  return match ? match[1]!.toUpperCase() : null;
}

/**
 * Parses Telegram 64-bit ids/hashes to native BigInt.
 * Accepts string (Prisma VarChar), bigint, safe integer, or Decimal-like toString values.
 * Never uses Number() for large 64-bit values.
 */
export function parseTelegramBigInt(value: unknown, fieldName: string): bigint {
  if (value == null || value === "") {
    throw new TelegramAccessHashParseError(`Missing ${fieldName} for Telegram peer construction`);
  }
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TelegramAccessHashParseError(`Invalid ${fieldName}: non-finite number`);
    }
    // Reject unsafe integers — Number loses precision above 2^53-1 (Telegram hashes exceed this).
    if (!Number.isSafeInteger(value)) {
      throw new TelegramAccessHashParseError(
        `Invalid ${fieldName}: JavaScript Number is not safe for 64-bit Telegram ids/hashes`
      );
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new TelegramAccessHashParseError(`Invalid ${fieldName}: expected integer string`);
    }
    try {
      return BigInt(trimmed);
    } catch {
      throw new TelegramAccessHashParseError(`Invalid ${fieldName}: BigInt parse failed`);
    }
  }
  // Prisma Decimal / big-integer Integer / similar
  if (typeof value === "object" && value !== null && "toString" in value) {
    const text = String(value).trim();
    if (/^-?\d+$/.test(text)) {
      try {
        return BigInt(text);
      } catch {
        throw new TelegramAccessHashParseError(`Invalid ${fieldName}: BigInt parse failed`);
      }
    }
  }
  throw new TelegramAccessHashParseError(`Invalid ${fieldName}: unsupported type ${typeof value}`);
}

async function buildInputPeer(
  runtime: TelegramRuntime,
  telegramChatId: string,
  peerType: TelegramPeerType,
  accessHash: string | null
): Promise<unknown> {
  const api = runtime.Api as {
    InputPeerUser: new (input: { userId: bigint; accessHash: bigint }) => unknown;
    InputPeerChat: new (input: { chatId: bigint }) => unknown;
    InputPeerChannel: new (input: { channelId: bigint; accessHash: bigint }) => unknown;
  };
  const numericId = barePeerId(telegramChatId, peerType);

  if (peerType === "USER") {
    if (accessHash == null || !String(accessHash).trim()) {
      throw new TelegramPeerConstructionError("USER peer requires access_hash");
    }
    // Exact GramJS-supported native BigInt representation — never Number / UUID / DB chat id.
    return new api.InputPeerUser({
      userId: parseTelegramBigInt(numericId, "telegramChatId"),
      accessHash: parseTelegramBigInt(accessHash, "accessHash")
    });
  }
  if (peerType === "CHAT") {
    return new api.InputPeerChat({ chatId: parseTelegramBigInt(numericId, "telegramChatId") });
  }
  if (accessHash == null || !String(accessHash).trim()) {
    throw new TelegramPeerConstructionError("CHANNEL peer requires access_hash");
  }
  return new api.InputPeerChannel({
    channelId: parseTelegramBigInt(numericId, "telegramChatId"),
    accessHash: parseTelegramBigInt(accessHash, "accessHash")
  });
}

function peerClassName(peer: unknown): string | null {
  if (!peer || typeof peer !== "object") return null;
  const value = peer as Record<string, unknown>;
  const name = value.className ?? value._;
  return typeof name === "string" && name.trim() ? name : peer.constructor?.name ?? null;
}

function logPeerConstructionDiagnostics(diagnostics: PeerConstructionDiagnostics): void {
  logPlainSerializable({
    event: "telegram_peer.construction_diagnostics",
    ...diagnostics
  });
}

function logPlainSerializable(value: Record<string, unknown>): void {
  console.info(JSON.stringify(value));
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
  const api = runtime.Api as {
    users: { GetUsers: new (input: { id: unknown[] }) => unknown };
    channels: { GetChannels: new (input: { id: unknown[] }) => unknown };
    InputUser: new (input: { userId: bigint; accessHash: bigint }) => unknown;
    InputChannel: new (input: { channelId: bigint; accessHash: bigint }) => unknown;
  };
  const numericId = barePeerId(hints.telegramChatId, peerType);
  const userId = parseTelegramBigInt(numericId, "telegramChatId");
  const accessHash = parseTelegramBigInt(hints.accessHash, "accessHash");
  if (peerType === "USER") {
    const users = (await runtime.client.invoke(
      new api.users.GetUsers({
        id: [new api.InputUser({ userId, accessHash })]
      })
    )) as unknown[];
    return users?.[0] ?? null;
  }
  if (peerType === "CHANNEL") {
    const result = (await runtime.client.invoke(
      new api.channels.GetChannels({
        id: [new api.InputChannel({ channelId: userId, accessHash })]
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
 * True when a private-USER display title is a placeholder / unusable label.
 * Matches: naked digits, "Telegram user …", "Unknown User".
 */
export function isUnusablePrivatePeerTitle(title: string | null | undefined): boolean {
  if (title == null) return true;
  const trimmed = title.trim();
  if (!trimmed) return true;
  if (/^unknown\s+user$/i.test(trimmed)) return true;
  if (/^telegram\s+user\s+/i.test(trimmed)) return true;
  if (isTemporaryTelegramUserTitle(trimmed)) return true;
  if (/^-?\d+$/.test(trimmed)) return true;
  return false;
}

/**
 * Private USER peer completeness predicate.
 *
 * Incomplete when any of:
 * - peer_type IS NULL
 * - peer_type is not USER
 * - access_hash IS NULL / blank
 * - title is only digits / starts with "Telegram user " / equals "Unknown User"
 * - first_name, last_name, and username are all empty
 *
 * Groups/channels never match (return false) — use peer-type-specific rules elsewhere.
 *
 * Title/name checks apply when those fields are provided (including null).
 * Call sites that omit title/names only evaluate peer_type + access_hash (hash gate).
 */
export function isIncompletePrivatePeer(input: {
  readonly chatType?: string | null;
  readonly peerType?: string | null;
  readonly accessHash?: string | null;
  readonly telegramChatId?: string | null;
  readonly title?: string | null;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly username?: string | null;
}): boolean {
  const chatType = (input.chatType ?? "").toUpperCase();
  // Groups/channels: do not apply private-user incompleteness rules.
  if (chatType === "GROUP" || chatType === "SUPERGROUP" || chatType === "CHANNEL") {
    return false;
  }

  const storedPeerType = input.peerType ? String(input.peerType).toUpperCase().trim() : null;
  const normalized = normalizePeerType(input.peerType, input.chatType, input.telegramChatId ?? undefined);

  // Explicit non-private chat types already handled; other non-PRIVATE contexts that
  // normalize to CHAT/CHANNEL are also excluded (unless chatType is PRIVATE/UNKNOWN).
  if (chatType !== "PRIVATE" && chatType !== "UNKNOWN" && chatType !== "") {
    if (storedPeerType === "CHAT" || storedPeerType === "CHANNEL") return false;
    if (normalized === "CHAT" || normalized === "CHANNEL") return false;
    return false;
  }

  // PRIVATE / UNKNOWN / empty chatType — require durable USER metadata.
  // peer_type must be present and exactly USER (null or mismatched CHANNEL/CHAT is incomplete).
  if (storedPeerType !== "USER") {
    return true;
  }

  if (!input.accessHash || !String(input.accessHash).trim()) {
    return true;
  }

  // Title / name checks when the caller supplies them (DB row / repaired snapshot).
  if ("title" in input) {
    if (isUnusablePrivatePeerTitle(input.title ?? null)) {
      return true;
    }
  }
  if ("firstName" in input || "lastName" in input || "username" in input) {
    const first = typeof input.firstName === "string" ? input.firstName.trim() : "";
    const last = typeof input.lastName === "string" ? input.lastName.trim() : "";
    const username = typeof input.username === "string" ? input.username.trim() : "";
    if (!first && !last && !username) {
      return true;
    }
  }

  return false;
}

/**
 * Inverse of isIncompletePrivatePeer for private USER rows with full field sets.
 */
export function isPrivatePeerMetadataComplete(input: {
  readonly chatType?: string | null;
  readonly peerType?: string | null;
  readonly accessHash?: string | null;
  readonly telegramChatId?: string | null;
  readonly title?: string | null;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly username?: string | null;
}): boolean {
  const chatType = (input.chatType ?? "").toUpperCase();
  if (chatType === "GROUP" || chatType === "SUPERGROUP" || chatType === "CHANNEL") {
    return true;
  }
  return !isIncompletePrivatePeer(input);
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
