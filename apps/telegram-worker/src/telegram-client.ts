import { decryptSecret, encryptSecret, type EncryptedSecret } from "@atlas/shared/session-encryption";
import { normalizeMarkedTelegramChatId, sanitizeTelegramError } from "@atlas/shared";
import type { WorkerEnv } from "./env";
import { assertPlainSerializable } from "./plain-serialization";
import { normalizeGramJsMedia } from "./media-normalize";
import { resolveGramJsUploadFileName } from "./outgoing-media";
import {
  extractPeerFields,
  accessHashAsString,
  normalizePeerType,
  resolveInputPeer,
  TelegramPeerUnresolvedError,
  type PeerResolutionHints,
  type ResolvedTelegramPeer
} from "./entity-resolution";

export interface TelegramApiCredentials {
  readonly apiId: number;
  readonly apiHash: string;
}

export interface NormalizedDialog {
  readonly telegramChatId: string;
  readonly title: string;
  readonly username: string | null;
  readonly chatType: "PRIVATE" | "GROUP" | "SUPERGROUP" | "CHANNEL" | "UNKNOWN";
  readonly unreadCount: number;
  readonly isPinned: boolean;
  readonly isBot: boolean;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly accessHash: string | null;
  readonly peerType: "USER" | "CHAT" | "CHANNEL" | null;
  readonly phone: string | null;
  readonly raw: Record<string, unknown>;
}

export interface NormalizedTextMessage {
  readonly telegramChatId: string;
  readonly telegramMessageId: string;
  readonly senderTelegramUserId: string | null;
  readonly text: string;
  readonly caption: string | null;
  readonly contentType: import("@atlas/shared").TelegramContentType;
  readonly mimeType: string | null;
  readonly fileName: string | null;
  readonly fileSizeBytes: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationSeconds: number | null;
  readonly waveform: number[] | null;
  readonly mediaMetadata: Record<string, unknown>;
  readonly needsBinaryDownload: boolean;
  readonly previewText: string;
  readonly sentAt: Date;
  readonly editedAt: Date | null;
  readonly replyToTelegramMessageId: string | null;
  /** True when the authenticated account sent this message (GramJS `out`). */
  readonly isOutgoing: boolean;
  readonly raw: Record<string, unknown>;
  /** Original GramJS message reference for media download (not persisted). */
  readonly gramJsMessage: unknown;
}

export interface TelegramSessionState {
  readonly session: string;
  readonly phoneNumber?: string;
  readonly phoneCodeHash?: string;
}

export interface NormalizedSentCode {
  readonly phoneCodeHash: string;
  readonly timeoutSeconds: number | null;
  readonly type: string | null;
}

export interface NormalizedTelegramIdentity {
  readonly id: string | null;
  readonly username: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
}

export type TelegramClientMode = "authorization" | "live";

export const TELEGRAM_AUTH_RPC_TIMEOUT_MS = 45_000;

export class TelegramAuthNetworkTimeoutError extends Error {
  public readonly code = "TELEGRAM_AUTH_NETWORK_TIMEOUT";

  public constructor(message = "TELEGRAM_AUTH_NETWORK_TIMEOUT") {
    super(message);
    this.name = "TelegramAuthNetworkTimeoutError";
  }
}

export type TelegramRuntime = {
  readonly mode: TelegramClientMode;
  readonly client: {
    connect: () => Promise<void>;
    disconnect: () => Promise<void>;
    destroy?: () => Promise<void>;
    session: { save: () => string; dcId?: number };
    getDialogs: (options: { limit: number }) => Promise<unknown[]>;
    getMessages: (entity: unknown, options: { limit: number }) => Promise<unknown[]>;
    getEntity: (entity: unknown) => Promise<unknown>;
    getMe?: () => Promise<unknown>;
    sendMessage: (entity: unknown, options: { message: string; replyTo?: number }) => Promise<unknown>;
    sendFile?: (
      entity: unknown,
      options: {
        file: Buffer | string | { name: string; size: number; path: string; buffer?: Buffer };
        caption?: string;
        attributes?: unknown[];
        mimeType?: string;
        forceDocument?: boolean;
        voiceNote?: boolean;
        videoNote?: boolean;
        supportsStreaming?: boolean;
        replyTo?: number;
      }
    ) => Promise<unknown>;
    downloadMedia?: (message: unknown, options?: Record<string, unknown>) => Promise<Buffer | string | null>;
    sendCode: (credentials: { apiId: number; apiHash: string }, phoneNumber: string) => Promise<unknown>;
    signInWithPassword: (
      credentials: { apiId: number; apiHash: string },
      authParams: { password: () => Promise<string>; onError: (error: Error) => Promise<boolean> }
    ) => Promise<unknown>;
    addEventHandler: (handler: (event: unknown) => void, eventBuilder: unknown) => void;
    invoke: (request: unknown) => Promise<unknown>;
  };
  readonly Api: Record<string, unknown>;
  readonly NewMessage: new (input: Record<string, unknown>) => unknown;
  readonly credentials: TelegramApiCredentials;
};

/**
 * Encapsulates GramJS so Telegram-specific runtime types do not leak into application code.
 */
export class TelegramClientAdapter {
  private readonly env: WorkerEnv;

  /**
   * Creates a Telegram adapter using application-wide API credentials.
   */
  public constructor(env: WorkerEnv) {
    this.env = env;
  }

  /**
   * Creates a connected GramJS runtime from encrypted session state.
   * Temporary authorization clients must use mode "authorization" so the update loop
   * cannot reconnect or treat TIMEOUT as a fatal auth failure.
   */
  public async connect(
    encryptedSession: EncryptedSecret | null,
    credentials: TelegramApiCredentials,
    options: { readonly mode?: TelegramClientMode } = {}
  ): Promise<TelegramRuntime> {
    const mode = options.mode ?? "live";
    const [{ TelegramClient, Api }, { StringSession }, { NewMessage }] = await Promise.all([
      import("telegram"),
      import("telegram/sessions/index.js"),
      import("telegram/events/index.js")
    ]);
    const sessionText = encryptedSession ? this.decryptSessionState(encryptedSession).session : "";
    const clientParams =
      mode === "authorization"
        ? { connectionRetries: 2, autoReconnect: false as const, reconnectRetries: 0 }
        : { connectionRetries: 5 };
    const client = new TelegramClient(new StringSession(sessionText), credentials.apiId, credentials.apiHash, clientParams) as unknown as TelegramRuntime["client"] &
      Record<string, unknown>;
    await client.connect();
    if (mode === "authorization") {
      prepareTemporaryAuthClient(client);
    }
    return {
      mode,
      client,
      credentials,
      Api: Api as unknown as Record<string, unknown>,
      NewMessage: NewMessage as unknown as new (input: Record<string, unknown>) => unknown
    };
  }

  /**
   * Short-lived auth client for sendCode / SignIn / checkPassword only.
   */
  public connectForAuthorization(
    encryptedSession: EncryptedSecret | null,
    credentials: TelegramApiCredentials
  ): Promise<TelegramRuntime> {
    return this.connect(encryptedSession, credentials, { mode: "authorization" });
  }

  /**
   * Encrypts the current GramJS string session.
   */
  public saveEncryptedSession(runtime: TelegramRuntime): EncryptedSecret {
    return this.encryptSessionState({ session: this.exportSessionString(runtime, "FINAL_SESSION_EXPORT") });
  }

  /**
   * Encrypts a structured Telegram session state envelope.
   */
  public encryptSessionState(state: TelegramSessionState): EncryptedSecret {
    assertSessionString(state.session, "TELEGRAM_SESSION_EXPORT_INVALID");
    assertPlainSerializable(state, "TELEGRAM_SESSION_STATE");
    return encryptSecret(JSON.stringify(state), this.env.TELEGRAM_SESSION_ENCRYPTION_KEY);
  }

  /**
   * Decrypts a structured Telegram session state envelope.
   */
  public decryptSessionState(envelope: EncryptedSecret): TelegramSessionState {
    const plaintext = decryptSecret(envelope, this.env.TELEGRAM_SESSION_ENCRYPTION_KEY);
    try {
      const parsed = JSON.parse(plaintext) as TelegramSessionState;
      return {
        session: parsed.session,
        ...(parsed.phoneNumber ? { phoneNumber: parsed.phoneNumber } : {}),
        ...(parsed.phoneCodeHash ? { phoneCodeHash: parsed.phoneCodeHash } : {})
      };
    } catch {
      return { session: plaintext };
    }
  }

  /**
   * Loads the newest Telegram dialog page.
   */
  public async listDialogs(runtime: TelegramRuntime, limit: number): Promise<NormalizedDialog[]> {
    const dialogs = await runtime.client.getDialogs({ limit });
    const { seedDialogEntities } = await import("./entity-resolution");
    seedDialogEntities(runtime, dialogs);
    return dialogs.map((dialog) => this.normalizeDialog(dialog));
  }

  /**
   * Resolves a single chat/user/channel entity into normalized identity fields.
   * Uses the durable peer-resolution layer (never raw user id alone).
   */
  public async resolveChatIdentity(
    runtime: TelegramRuntime,
    telegramChatId: string,
    hints?: Omit<PeerResolutionHints, "telegramChatId">
  ): Promise<NormalizedDialog> {
    const resolved = await this.resolvePeer(runtime, { telegramChatId, ...hints });
    return this.normalizeDialog({ entity: resolved.entity, id: resolved.telegramChatId, unreadCount: 0, pinned: false });
  }

  /**
   * Resolves a Telegram peer for send/list operations and returns fields to persist.
   */
  public async resolvePeer(runtime: TelegramRuntime, hints: PeerResolutionHints): Promise<ResolvedTelegramPeer> {
    try {
      return await resolveInputPeer(runtime, hints);
    } catch (error) {
      if (error instanceof TelegramPeerUnresolvedError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/Could not find the input entity/i.test(message) || /No user has/i.test(message)) {
        throw new TelegramPeerUnresolvedError();
      }
      throw error;
    }
  }

  /**
   * @deprecated Prefer resolvePeer — kept for call-site clarity during migration.
   */
  private async getEntityFlexible(
    runtime: TelegramRuntime,
    telegramChatId: string,
    hints?: Omit<PeerResolutionHints, "telegramChatId">
  ): Promise<unknown> {
    const resolved = await this.resolvePeer(runtime, { telegramChatId, ...hints });
    return resolved.inputPeer ?? resolved.entity;
  }

  /**
   * Requests a Telegram authorization code for a phone number.
   */
  public async sendLoginCode(runtime: TelegramRuntime, phoneNumber: string): Promise<NormalizedSentCode> {
    const response = await runtime.client.sendCode(runtime.credentials, phoneNumber);
    return this.normalizeSentCode(response);
  }

  /**
   * Returns the current Telegram data-center id when GramJS exposes it.
   */
  public sessionDcId(runtime: TelegramRuntime): number | null {
    return typeof runtime.client.session.dcId === "number" ? runtime.client.session.dcId : null;
  }

  /**
   * Disconnects a short-lived client. Authorization clients call destroy() so GramJS
   * stops `_updateLoop` and cannot disconnect mid-RPC from a background TIMEOUT.
   */
  public async safeDisconnect(runtime: TelegramRuntime): Promise<void> {
    try {
      if (runtime.mode === "authorization" && typeof runtime.client.destroy === "function") {
        await runtime.client.destroy();
        return;
      }
      await runtime.client.disconnect();
    } catch (error) {
      const safe = sanitizeTelegramError(error, false);
      console.warn(JSON.stringify({ event: "telegram_auth.disconnect_ignored", code: safe.code ?? safe.name, message: safe.message }));
    }
  }

  /**
   * Completes Telegram phone-code authorization with a guarded RPC timeout.
   */
  public async signInWithCode(runtime: TelegramRuntime, phoneNumber: string, phoneCodeHash: string, code: string): Promise<void> {
    const api = runtime.Api as {
      auth: { SignIn: new (input: { phoneNumber: string; phoneCodeHash: string; phoneCode: string }) => unknown };
    };
    await withAuthRpcTimeout(
      runtime.client.invoke(new api.auth.SignIn({ phoneNumber, phoneCodeHash, phoneCode: code })),
      TELEGRAM_AUTH_RPC_TIMEOUT_MS
    );
  }

  /**
   * Completes Telegram two-factor authorization with a guarded RPC timeout.
   */
  public async signInWithPassword(runtime: TelegramRuntime, password: string): Promise<unknown> {
    return withAuthRpcTimeout(
      runtime.client.signInWithPassword(runtime.credentials, {
        password: async () => password,
        onError: async () => true
      }),
      TELEGRAM_AUTH_RPC_TIMEOUT_MS
    );
  }

  /**
   * Loads the authorized Telegram user identity when available.
   */
  public async getSelf(runtime: TelegramRuntime): Promise<NormalizedTelegramIdentity> {
    const value = runtime.client.getMe ? ((await runtime.client.getMe()) as Record<string, unknown>) : {};
    const identity = {
      id: value.id ? String(value.id) : null,
      username: typeof value.username === "string" ? value.username : null,
      firstName: typeof value.firstName === "string" ? value.firstName : null,
      lastName: typeof value.lastName === "string" ? value.lastName : null
    };
    assertPlainSerializable(identity, "TELEGRAM_USER_IDENTITY");
    return identity;
  }

  /**
   * Loads recent messages for a chat (text and media).
   */
  public async listRecentTextMessages(
    runtime: TelegramRuntime,
    telegramChatId: string,
    limit: number,
    hints?: Omit<PeerResolutionHints, "telegramChatId">
  ): Promise<NormalizedTextMessage[]> {
    const resolved = await this.resolvePeer(runtime, { telegramChatId, ...hints });
    const messages = await runtime.client.getMessages(resolved.inputPeer, { limit });
    return messages
      .map((message) => this.normalizeMessage(resolved.telegramChatId, message))
      .filter((message) => message.text.length > 0 || message.contentType !== "TEXT");
  }

  /**
   * Sends a text message to Telegram.
   */
  public async sendText(
    runtime: TelegramRuntime,
    telegramChatId: string,
    text: string,
    replyToTelegramMessageId?: string,
    hints?: Omit<PeerResolutionHints, "telegramChatId">
  ): Promise<NormalizedTextMessage & { readonly resolvedPeer: ResolvedTelegramPeer }> {
    const resolved = await this.resolvePeer(runtime, { telegramChatId, ...hints });
    const sent = await runtime.client.sendMessage(resolved.inputPeer, {
      message: text,
      ...(replyToTelegramMessageId ? { replyTo: Number(replyToTelegramMessageId) } : {})
    });
    return { ...this.normalizeMessage(resolved.telegramChatId, sent), resolvedPeer: resolved };
  }

  /**
   * Sends a media file to Telegram using the live client.
   * Buffers are wrapped with a GramJS-recognized filename so photos are not sent as documents.
   */
  public async sendMediaFile(
    runtime: TelegramRuntime,
    telegramChatId: string,
    input: {
      readonly buffer: Buffer;
      readonly fileName: string;
      readonly mimeType?: string;
      readonly caption?: string;
      readonly voiceNote?: boolean;
      readonly videoNote?: boolean;
      readonly forceDocument?: boolean;
      readonly asPhoto?: boolean;
      readonly asAnimation?: boolean;
      readonly supportsStreaming?: boolean;
      readonly replyToTelegramMessageId?: string;
      readonly peerHints?: Omit<PeerResolutionHints, "telegramChatId">;
    }
  ): Promise<NormalizedTextMessage & { readonly resolvedPeer: ResolvedTelegramPeer }> {
    if (!runtime.client.sendFile) {
      throw new Error("Telegram client does not support sendFile");
    }
    const { CustomFile } = await import("telegram/client/uploads.js");
    const uploadName = resolveGramJsUploadFileName({
      fileName: input.fileName,
      mimeType: input.mimeType ?? null,
      ...(input.asPhoto !== undefined ? { asPhoto: input.asPhoto } : {}),
      ...(input.asAnimation !== undefined ? { asAnimation: input.asAnimation } : {}),
      ...(input.forceDocument !== undefined ? { forceDocument: input.forceDocument } : {})
    });
    const file = new CustomFile(uploadName, input.buffer.length, "", input.buffer);
    const resolved = await this.resolvePeer(runtime, { telegramChatId, ...input.peerHints });
    const sent = await runtime.client.sendFile(resolved.inputPeer, {
      file,
      forceDocument: Boolean(input.forceDocument),
      ...(input.caption !== undefined ? { caption: input.caption } : {}),
      ...(input.mimeType !== undefined ? { mimeType: input.mimeType } : {}),
      ...(input.voiceNote !== undefined ? { voiceNote: input.voiceNote } : {}),
      ...(input.videoNote !== undefined ? { videoNote: input.videoNote } : {}),
      ...(input.supportsStreaming ? { supportsStreaming: true } : {}),
      ...(input.replyToTelegramMessageId ? { replyTo: Number(input.replyToTelegramMessageId) } : {})
    });
    return { ...this.normalizeMessage(resolved.telegramChatId, sent), resolvedPeer: resolved };
  }

  /**
   * Downloads binary media for a normalized message when available.
   */
  public async downloadMessageMedia(
    runtime: TelegramRuntime,
    message: NormalizedTextMessage,
    peerHints?: Omit<PeerResolutionHints, "telegramChatId">
  ): Promise<{ buffer: Buffer; mimeType: string | null; thumbnail: Buffer | null } | null> {
    if (!message.needsBinaryDownload) return null;
    if (!runtime.client.downloadMedia) return null;
    const source = message.gramJsMessage;
    if (!source) {
      // Re-fetch the message when the live reference is unavailable (backfill).
      const resolved = await this.resolvePeer(runtime, { telegramChatId: message.telegramChatId, ...peerHints });
      const messages = await runtime.client.getMessages(resolved.inputPeer, { limit: 40 });
      const match = messages.find((row) => String((row as { id?: unknown }).id ?? "") === message.telegramMessageId);
      if (!match) return null;
      const buffer = await runtime.client.downloadMedia(match, {});
      return toDownloadResult(buffer, message.mimeType);
    }
    const buffer = await runtime.client.downloadMedia(source, {});
    return toDownloadResult(buffer, message.mimeType);
  }

  /**
   * Registers a handler for incoming text and media messages.
   */
  public listenForTextMessages(runtime: TelegramRuntime, handler: (message: NormalizedTextMessage) => Promise<void>): void {
    runtime.client.addEventHandler((event: unknown) => {
      const value = event as { message?: unknown; chatId?: unknown; chat?: unknown };
      if (!value.message) {
        return;
      }
      const chatEntity = (value.chat ?? null) as Record<string, unknown> | null;
      const chatType = chatEntity ? this.chatType(chatEntity) : "UNKNOWN";
      const rawChatId = String(value.chatId ?? (value.message as Record<string, unknown>).chatId ?? chatEntity?.id ?? "");
      const chatId = normalizeMarkedTelegramChatId(rawChatId, chatType);
      void handler(this.normalizeMessage(chatId, value.message));
    }, new runtime.NewMessage({}));
  }

  private normalizeDialog(dialog: unknown): NormalizedDialog {
    const value = dialog as Record<string, unknown>;
    const entity = (value.entity ?? value) as Record<string, unknown>;
    const chatType = this.chatType(entity);
    // Prefer marked dialog/peer id when present; fall back to entity id, then canonicalize.
    const rawId = String(value.id ?? entity.id ?? "");
    const id = normalizeMarkedTelegramChatId(rawId, chatType);
    const username = cleanOptionalString(entity.username);
    const firstName = cleanOptionalString(entity.firstName);
    const lastName = cleanOptionalString(entity.lastName);
    const phone = cleanOptionalString(entity.phone);
    const peerFields = extractPeerFields(entity, id);
    const isBot = Boolean(entity.bot) || Boolean(username && username.toLowerCase().endsWith("bot"));
    return {
      telegramChatId: id,
      title: buildEntityTitle(entity, chatType, isBot),
      username,
      chatType,
      unreadCount: Number(value.unreadCount ?? 0),
      isPinned: Boolean(value.pinned),
      isBot,
      firstName,
      lastName,
      accessHash: peerFields.accessHash,
      peerType: peerFields.peerType,
      phone,
      raw: this.redacted(entity, isBot, firstName, lastName, username, peerFields.accessHash, peerFields.peerType, phone)
    };
  }

  public normalizeIncomingMessage(telegramChatId: string, message: unknown): NormalizedTextMessage {
    return this.normalizeMessage(telegramChatId, message);
  }

  private normalizeMessage(telegramChatId: string, message: unknown): NormalizedTextMessage {
    const value = message as Record<string, unknown>;
    const replyTo = value.replyTo as Record<string, unknown> | undefined;
    const editedRaw = value.editDate;
    const media = normalizeGramJsMedia(message);
    return {
      telegramChatId,
      telegramMessageId: String(value.id),
      senderTelegramUserId: value.senderId ? String(value.senderId) : null,
      text: media.text,
      caption: media.caption,
      contentType: media.contentType,
      mimeType: media.mimeType,
      fileName: media.fileName,
      fileSizeBytes: media.fileSizeBytes,
      width: media.width,
      height: media.height,
      durationSeconds: media.durationSeconds,
      waveform: media.waveform,
      mediaMetadata: media.mediaMetadata,
      needsBinaryDownload: media.needsBinaryDownload,
      previewText: media.previewText,
      sentAt: value.date instanceof Date ? value.date : new Date(Number(value.date ?? Date.now()) * 1000),
      editedAt:
        editedRaw instanceof Date
          ? editedRaw
          : typeof editedRaw === "number" && editedRaw > 0
            ? new Date(editedRaw * 1000)
            : null,
      replyToTelegramMessageId: replyTo?.replyToMsgId ? String(replyTo.replyToMsgId) : null,
      isOutgoing: Boolean(value.out),
      raw: this.redacted(value, false, null, null, null),
      gramJsMessage: message
    };
  }

  private chatType(entity: Record<string, unknown>): NormalizedDialog["chatType"] {
    const className = String(entity.className ?? entity._ ?? "");
    if (className.includes("Channel") && Boolean(entity.megagroup)) {
      return "SUPERGROUP";
    }
    if (className.includes("Channel")) {
      return "CHANNEL";
    }
    if (className.includes("Chat")) {
      return "GROUP";
    }
    if (className.includes("User")) {
      return "PRIVATE";
    }
    return "UNKNOWN";
  }

  private redacted(
    value: Record<string, unknown>,
    isBot: boolean,
    firstName: string | null,
    lastName: string | null,
    username: string | null,
    accessHash: string | null = null,
    peerType: string | null = null,
    phone: string | null = null
  ): Record<string, unknown> {
    const resolvedHash = accessHash ?? accessHashAsString(value.accessHash);
    const resolvedPeerType = peerType ?? normalizePeerType(null, this.chatType(value), value.id ? String(value.id) : undefined);
    const dto = {
      className: typeof value.className === "string" ? value.className : typeof value._ === "string" ? value._ : null,
      id: value.id ? String(value.id) : null,
      title: typeof value.title === "string" ? value.title : null,
      username,
      firstName,
      lastName,
      bot: isBot,
      accessHash: resolvedHash,
      peerType: resolvedPeerType,
      phone,
      photo: value.photo ? { hasPhoto: true } : null
    };
    assertPlainSerializable(dto, "TELEGRAM_RAW_METADATA");
    return dto;
  }

  public exportSessionString(runtime: TelegramRuntime, boundaryName: string): string {
    const sessionString = runtime.client.session.save();
    assertSessionString(sessionString, "TELEGRAM_SESSION_EXPORT_INVALID");
    assertPlainSerializable({ session: sessionString }, boundaryName);
    return sessionString;
  }

  private normalizeSentCode(response: unknown): NormalizedSentCode {
    const value = response as Record<string, unknown>;
    const phoneCodeHash = value.phoneCodeHash;
    if (typeof phoneCodeHash !== "string" || phoneCodeHash.length === 0) {
      throw new Error("TELEGRAM_PHONE_CODE_HASH_INVALID");
    }
    const typeObject = value.type as Record<string, unknown> | undefined;
    const dto: NormalizedSentCode = {
      phoneCodeHash,
      timeoutSeconds: typeof value.timeout === "number" ? value.timeout : null,
      type: typeof typeObject?.className === "string" ? typeObject.className : typeof typeObject?._ === "string" ? typeObject._ : null
    };
    assertPlainSerializable(dto, "TELEGRAM_SEND_CODE_RESPONSE");
    return dto;
  }
}

function assertSessionString(value: unknown, code: string): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(code);
  }
}

/**
 * Suppresses GramJS update-loop TIMEOUT reconnects on temporary auth clients.
 * SignIn/sendCode must not be interrupted by updates.GetDifference / ping TIMEOUT.
 */
export function prepareTemporaryAuthClient(client: TelegramRuntime["client"] & Record<string, unknown>): void {
  let timeoutLogged = false;
  client._errorHandler = async (error: unknown) => {
    if (!isGramJsUpdateLoopTimeout(error)) return;
    if (!timeoutLogged) {
      timeoutLogged = true;
      console.warn(
        JSON.stringify({
          event: "telegram_auth.update_loop_timeout_ignored",
          message: "Non-fatal GramJS update-loop TIMEOUT for temporary auth client"
        })
      );
    }
  };

  const sender = client._sender as { reconnect?: () => void } | undefined;
  if (sender && typeof sender.reconnect === "function") {
    sender.reconnect = () => {
      // Update-loop TIMEOUT must not reconnect and tear down in-flight SignIn.
    };
  }
}

export function isGramJsUpdateLoopTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message === "TIMEOUT" || /^TIMEOUT$/i.test(error.message.trim());
}

export async function withAuthRpcTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new TelegramAuthNetworkTimeoutError()), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Builds a human title that never falls back to a raw Telegram id.
 * Private priority: first+last → first → last → username → Unknown User
 * Group/channel priority: title → username → Unknown Group/Channel
 */
function buildEntityTitle(
  entity: Record<string, unknown>,
  chatType: NormalizedDialog["chatType"],
  isBot: boolean
): string {
  const groupTitle = typeof entity.title === "string" ? entity.title.trim() : "";
  if ((chatType === "GROUP" || chatType === "SUPERGROUP" || chatType === "CHANNEL") && groupTitle && !isRawTelegramId(groupTitle)) {
    return groupTitle.slice(0, 255);
  }
  if (groupTitle && !isRawTelegramId(groupTitle) && chatType !== "PRIVATE") {
    return groupTitle.slice(0, 255);
  }

  const firstName = typeof entity.firstName === "string" ? entity.firstName.trim() : "";
  const lastName = typeof entity.lastName === "string" ? entity.lastName.trim() : "";
  if (firstName && lastName) {
    return `${firstName} ${lastName}`.slice(0, 255);
  }
  if (firstName && !isRawTelegramId(firstName)) {
    return firstName.slice(0, 255);
  }
  if (lastName && !isRawTelegramId(lastName)) {
    return lastName.slice(0, 255);
  }
  if (groupTitle && !isRawTelegramId(groupTitle)) {
    return groupTitle.slice(0, 255);
  }

  const username = typeof entity.username === "string" ? entity.username.trim() : "";
  if (username && !isRawTelegramId(username)) {
    return username.slice(0, 255);
  }
  if (isBot) return "Unknown Bot";
  if (chatType === "CHANNEL") return "Unknown Channel";
  if (chatType === "GROUP" || chatType === "SUPERGROUP") return "Unknown Group";
  if (chatType === "PRIVATE") return "Unknown User";
  return "Unknown Chat";
}

function cleanOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRawTelegramId(value: string): boolean {
  return /^-?\d{5,}$/.test(value.trim());
}

export function isUsableDisplayTitle(title: string | null | undefined, telegramChatId?: string | null): boolean {
  if (!title) return false;
  const trimmed = title.trim();
  if (!trimmed) return false;
  if (telegramChatId && trimmed === telegramChatId) return false;
  if (isRawTelegramId(trimmed)) return false;
  if (/^unknown(\s|$)/i.test(trimmed)) return false;
  return true;
}

function toDownloadResult(
  buffer: Buffer | string | null | undefined,
  mimeType: string | null
): { buffer: Buffer; mimeType: string | null; thumbnail: Buffer | null } | null {
  if (!buffer) return null;
  const bytes = typeof buffer === "string" ? Buffer.from(buffer) : buffer;
  if (!bytes.length) return null;
  return { buffer: bytes, mimeType, thumbnail: null };
}
