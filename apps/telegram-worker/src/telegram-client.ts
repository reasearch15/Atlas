import { decryptSecret, encryptSecret, type EncryptedSecret } from "@atlas/shared/session-encryption";
import {
  buildCrmContactDisplayTitle,
  isUsableHumanDisplayTitle,
  normalizeMarkedTelegramChatId,
  sanitizeTelegramError,
  shouldIgnoreTelegramDialog
} from "@atlas/shared";
import type { WorkerEnv } from "./env";
import { assertPlainSerializable } from "./plain-serialization";
import { normalizeGramJsMedia } from "./media-normalize";
import { resolveGramJsUploadFileName } from "./outgoing-media";
import {
  extractPeerFields,
  extractAccessHashFromPeerCandidate,
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
  /** GramJS User.self — Saved Messages. */
  readonly isSelf: boolean;
  /** GramJS User.support — Telegram support. */
  readonly isSupport: boolean;
  /** Dialog archived / archive folder. */
  readonly isArchived: boolean;
  /** Top message id from the dialog snapshot (for unread sync). */
  readonly topMessageId: string | null;
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

/**
 * Raised when Telegram rejects a delete-for-everyone request (permissions / policy).
 */
export class SafeTelegramDeleteError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "SafeTelegramDeleteError";
    this.code = code;
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
    deleteMessages?: (
      entity: unknown,
      messageIds: number[],
      params?: { revoke?: boolean }
    ) => Promise<unknown>;
    sendCode: (credentials: { apiId: number; apiHash: string }, phoneNumber: string) => Promise<unknown>;
    signInWithPassword: (
      credentials: { apiId: number; apiHash: string },
      authParams: { password: () => Promise<string>; onError: (error: Error) => Promise<boolean> }
    ) => Promise<unknown>;
    addEventHandler: (handler: (event: unknown) => void, eventBuilder?: unknown) => void;
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
   * Official service / Saved Messages / archived dialogs are excluded — they must never enter CRM.
   */
  public async listDialogs(runtime: TelegramRuntime, limit: number): Promise<NormalizedDialog[]> {
    const dialogs = await runtime.client.getDialogs({ limit });
    const { seedDialogEntities } = await import("./entity-resolution");
    seedDialogEntities(runtime, dialogs);
    const selfTelegramUserId = await this.resolveSelfUserId(runtime);
    return dialogs
      .map((dialog) => this.normalizeDialog(dialog))
      .filter((dialog) => !this.isIgnorableDialog(dialog, selfTelegramUserId));
  }

  /**
   * Returns whether a normalized dialog must be excluded from CRM sync.
   */
  public isIgnorableDialog(dialog: NormalizedDialog, selfTelegramUserId?: string | null): boolean {
    return shouldIgnoreTelegramDialog({
      telegramChatId: dialog.telegramChatId,
      chatType: dialog.chatType,
      title: dialog.title,
      username: dialog.username,
      firstName: dialog.firstName,
      lastName: dialog.lastName,
      isSelf: dialog.isSelf,
      isSupport: dialog.isSupport,
      isArchived: dialog.isArchived,
      selfTelegramUserId: selfTelegramUserId ?? null
    });
  }

  /**
   * Resolves the authenticated account's Telegram user id when available.
   */
  public async resolveSelfUserId(runtime: TelegramRuntime): Promise<string | null> {
    if (typeof runtime.client.getMe !== "function") return null;
    try {
      const me = (await runtime.client.getMe()) as Record<string, unknown> | null;
      if (!me?.id) return null;
      return String(me.id);
    } catch {
      return null;
    }
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
   * Acknowledges Telegram read history up to maxId for a peer (messages.ReadHistory).
   */
  public async markChatHistoryRead(
    runtime: TelegramRuntime,
    hints: PeerResolutionHints,
    maxTelegramMessageId: string
  ): Promise<{ readonly ok: true; readonly maxId: number }> {
    const resolved = await this.resolvePeer(runtime, hints);
    const maxId = Number(maxTelegramMessageId);
    if (!Number.isFinite(maxId) || maxId < 0) {
      throw new Error("TELEGRAM_READ_MAX_ID_INVALID");
    }
    const Api = runtime.Api as {
      messages: {
        ReadHistory: new (input: { peer: unknown; maxId: number }) => unknown;
      };
    };
    await runtime.client.invoke(new Api.messages.ReadHistory({ peer: resolved.inputPeer, maxId }));
    return { ok: true, maxId };
  }

  /**
   * Deletes messages for a peer via GramJS.
   * Uses client.deleteMessages with revoke=true for private/basic chats;
   * channels/supergroups use the same client API which maps to channels.DeleteMessages.
   */
  public async deleteMessages(
    runtime: TelegramRuntime,
    hints: PeerResolutionHints,
    telegramMessageIds: readonly string[],
    options?: { readonly revoke?: boolean }
  ): Promise<{ readonly deletedIds: readonly string[] }> {
    const ids = telegramMessageIds
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id) && id > 0);
    if (ids.length === 0) {
      throw new Error("TELEGRAM_DELETE_MESSAGE_ID_INVALID");
    }
    const resolved = await this.resolvePeer(runtime, hints);
    const revoke = options?.revoke !== false;
    if (typeof runtime.client.deleteMessages !== "function") {
      throw new Error("TELEGRAM_DELETE_UNSUPPORTED");
    }
    try {
      await runtime.client.deleteMessages(resolved.entity ?? resolved.inputPeer, ids, { revoke });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/MESSAGE_DELETE_FORBIDDEN|CHAT_ADMIN_REQUIRED|MESSAGE_ID_INVALID/i.test(message)) {
        throw new SafeTelegramDeleteError(
          /CHAT_ADMIN_REQUIRED/i.test(message) ? "TELEGRAM_DELETE_ADMIN_REQUIRED" : "TELEGRAM_DELETE_FORBIDDEN",
          /CHAT_ADMIN_REQUIRED/i.test(message)
            ? "Telegram does not allow this account to delete that message for everyone."
            : "Telegram rejected deleting this message for everyone."
        );
      }
      throw error;
    }
    return { deletedIds: ids.map(String) };
  }

  /**
   * Registers handlers for native Telegram message deletion updates.
   */
  public listenForDeletedMessages(
    runtime: TelegramRuntime,
    handler: (input: {
      readonly telegramMessageIds: readonly string[];
      readonly channelId?: string | null;
    }) => Promise<void>
  ): void {
    runtime.client.addEventHandler((update: unknown) => {
      void (async () => {
        const value = (update ?? {}) as Record<string, unknown>;
        const className = String(value.className ?? value._ ?? "");
        try {
          if (className === "UpdateDeleteMessages" || className.includes("UpdateDeleteMessages")) {
            const messages = Array.isArray(value.messages) ? value.messages.map(String) : [];
            if (messages.length > 0) {
              await handler({ telegramMessageIds: messages, channelId: null });
            }
            return;
          }
          if (className === "UpdateDeleteChannelMessages" || className.includes("UpdateDeleteChannelMessages")) {
            const messages = Array.isArray(value.messages) ? value.messages.map(String) : [];
            const channelId = value.channelId != null ? String(value.channelId) : null;
            if (messages.length > 0) {
              await handler({ telegramMessageIds: messages, channelId });
            }
          }
        } catch (error) {
          const safe = sanitizeTelegramError(error, false);
          console.error(
            JSON.stringify({
              event: "telegram_live.delete_handler_failed",
              code: safe.code ?? safe.name,
              message: safe.message
            })
          );
        }
      })();
    });
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
   * Resolves chat + InputPeer from the live GramJS event before invoking the handler
   * so access_hash / peer_type can be persisted on first inbound.
   */
  public listenForTextMessages(
    runtime: TelegramRuntime,
    handler: (
      message: NormalizedTextMessage,
      liveIdentity: NormalizedDialog | null,
      liveMeta: {
        readonly hadLiveEntity: boolean;
        readonly hadInputPeerHash: boolean;
        readonly entitySource: string | null;
      }
    ) => Promise<void>
  ): void {
    runtime.client.addEventHandler((event: unknown) => {
      void (async () => {
        const value = event as {
          message?: unknown;
          chatId?: unknown;
          chat?: unknown;
          getChat?: () => Promise<unknown>;
          getInputChat?: () => Promise<unknown>;
          getSender?: () => Promise<unknown>;
        };
        if (!value.message) {
          return;
        }
        try {
          const resolved = await this.resolveIdentityFromLiveEvent(runtime, value);
          const chatType = resolved.identity?.chatType ?? (value.chat ? this.chatType(value.chat as Record<string, unknown>) : "UNKNOWN");
          const rawChatId = String(
            value.chatId ?? (value.message as Record<string, unknown>).chatId ?? (value.chat as Record<string, unknown> | undefined)?.id ?? ""
          );
          const chatId = resolved.identity?.telegramChatId || normalizeMarkedTelegramChatId(rawChatId, chatType);
          await handler(this.normalizeMessage(chatId, value.message), resolved.identity, {
            hadLiveEntity: resolved.hadLiveEntity,
            hadInputPeerHash: resolved.hadInputPeerHash,
            entitySource: resolved.entitySource
          });
        } catch (error) {
          const safe = sanitizeTelegramError(error, false);
          console.error(
            JSON.stringify({
              event: "telegram_live.inbound_handler_failed",
              code: safe.code ?? safe.name,
              message: safe.message
            })
          );
        }
      })();
    }, new runtime.NewMessage({}));
  }

  /**
   * Builds durable peer identity from a live NewMessage event.
   * Entity source priority:
   * message.getSender → event.getSender → message.sender → getChat/event.chat →
   * message.senderId / peerId entity cache → getInputChat / getInputSender → resolvePeer.
   */
  public async resolveIdentityFromLiveEvent(
    runtime: TelegramRuntime,
    event: {
      readonly chat?: unknown;
      readonly message?: unknown;
      readonly getChat?: () => Promise<unknown>;
      readonly getInputChat?: () => Promise<unknown>;
      readonly getSender?: () => Promise<unknown>;
    }
  ): Promise<{
    readonly identity: NormalizedDialog | null;
    readonly hadLiveEntity: boolean;
    readonly hadInputPeerHash: boolean;
    readonly entitySource: string | null;
  }> {
    let chatEntity: Record<string, unknown> | null = null;
    let entitySource: string | null = null;
    let inputPeer: unknown = null;
    let inputPeerHash: string | null = null;

    const message = event.message as
      | {
          getSender?: () => Promise<unknown>;
          getInputSender?: () => Promise<unknown>;
          sender?: unknown;
          senderId?: unknown;
          peerId?: unknown;
        }
      | undefined;

    // 1) message.getSender()
    try {
      if (typeof message?.getSender === "function") {
        const sender = await message.getSender();
        if (sender && typeof sender === "object") {
          chatEntity = sender as Record<string, unknown>;
          entitySource = "message.getSender";
        }
      }
    } catch {
      // continue
    }

    // 2) event.getSender()
    try {
      if (!chatEntity && typeof event.getSender === "function") {
        const sender = await event.getSender();
        if (sender && typeof sender === "object") {
          chatEntity = sender as Record<string, unknown>;
          entitySource = "event.getSender";
        }
      }
    } catch {
      // continue
    }

    // 3) message.sender (sync property)
    if (!chatEntity && message?.sender && typeof message.sender === "object") {
      chatEntity = message.sender as Record<string, unknown>;
      entitySource = "message.sender";
    }

    // 4) event.getChat() / event.chat
    try {
      if ((!chatEntity || !extractAccessHashFromPeerCandidate(chatEntity)) && typeof event.getChat === "function") {
        const loaded = await event.getChat();
        if (loaded && typeof loaded === "object") {
          if (!chatEntity) {
            chatEntity = loaded as Record<string, unknown>;
            entitySource = "event.getChat";
          } else if (!extractAccessHashFromPeerCandidate(chatEntity) && extractAccessHashFromPeerCandidate(loaded)) {
            chatEntity = { ...chatEntity, ...(loaded as Record<string, unknown>) };
            entitySource = `${entitySource}+event.getChat`;
          }
        }
      }
    } catch {
      // keep prior entity
    }
    if (!chatEntity && event.chat && typeof event.chat === "object") {
      chatEntity = event.chat as Record<string, unknown>;
      entitySource = "event.chat";
    }

    // 5) message.senderId / peerId via GramJS entity cache
    if (!chatEntity || !extractAccessHashFromPeerCandidate(chatEntity)) {
      const cacheCandidate =
        (await this.tryEntityFromPeerRef(runtime, message?.senderId, "message.senderId")) ??
        (await this.tryEntityFromPeerRef(runtime, message?.peerId, "message.peerId"));
      if (cacheCandidate) {
        if (!chatEntity) {
          chatEntity = cacheCandidate.entity;
          entitySource = cacheCandidate.source;
        } else if (!extractAccessHashFromPeerCandidate(chatEntity) && extractAccessHashFromPeerCandidate(cacheCandidate.entity)) {
          chatEntity = { ...chatEntity, ...cacheCandidate.entity };
          entitySource = `${entitySource}+${cacheCandidate.source}`;
        }
      }
    }

    // 6) getInputChat / getInputSender for durable access_hash
    try {
      if (typeof event.getInputChat === "function") {
        inputPeer = await event.getInputChat();
        inputPeerHash = extractAccessHashFromPeerCandidate(inputPeer);
        if (inputPeerHash && !entitySource) entitySource = "event.getInputChat";
      }
    } catch {
      inputPeer = null;
    }
    try {
      if (!inputPeerHash && typeof message?.getInputSender === "function") {
        const inputSender = await message.getInputSender();
        const hash = extractAccessHashFromPeerCandidate(inputSender);
        if (hash) {
          inputPeer = inputSender;
          inputPeerHash = hash;
          if (!entitySource) entitySource = "message.getInputSender";
        }
      }
    } catch {
      // ignore
    }

    const hadLiveEntity = Boolean(chatEntity && Object.keys(chatEntity).length > 0);
    const hadInputPeerHash = Boolean(inputPeerHash);

    if (!hadLiveEntity && !hadInputPeerHash) {
      return { identity: null, hadLiveEntity: false, hadInputPeerHash: false, entitySource: null };
    }

    const rawId = String(
      chatEntity?.id ??
        (inputPeer && typeof inputPeer === "object"
          ? (inputPeer as Record<string, unknown>).userId ??
            (inputPeer as Record<string, unknown>).channelId ??
            (inputPeer as Record<string, unknown>).chatId
          : "") ??
        ""
    );
    const peerTypeHint =
      normalizePeerType(
        chatEntity ? extractPeerFields(chatEntity, rawId || "0").peerType : null,
        chatEntity ? this.chatType(chatEntity) : null,
        rawId || undefined
      ) ?? "USER";
    const chatType =
      peerTypeHint === "CHANNEL"
        ? chatEntity && (chatEntity as { megagroup?: unknown }).megagroup
          ? "SUPERGROUP"
          : "CHANNEL"
        : peerTypeHint === "CHAT"
          ? "GROUP"
          : "PRIVATE";
    const telegramChatId = normalizeMarkedTelegramChatId(rawId || "0", chatType);

    let identity = chatEntity
      ? this.identityFromChatEntity(telegramChatId, chatEntity)
      : this.identityFromChatEntity(telegramChatId, {
          className: peerTypeHint === "CHANNEL" ? "Channel" : peerTypeHint === "CHAT" ? "Chat" : "User",
          id: telegramChatId
        });

    if (inputPeerHash && !identity.accessHash) {
      identity = {
        ...identity,
        accessHash: inputPeerHash,
        peerType: identity.peerType ?? peerTypeHint
      };
    } else if (inputPeerHash && identity.accessHash !== inputPeerHash) {
      // Prefer InputPeer hash from getInputChat — it is what Telegram accepts for sends.
      identity = { ...identity, accessHash: inputPeerHash };
    }

    if (!identity.peerType) {
      identity = { ...identity, peerType: peerTypeHint };
    }

    // When we have InputPeer hash but thin entity, still try session entity cache for names.
    if (inputPeerHash && !identity.firstName && !identity.lastName && !identity.username) {
      try {
        const resolved = await this.resolvePeer(runtime, {
          telegramChatId: identity.telegramChatId,
          chatType: identity.chatType,
          accessHash: inputPeerHash,
          peerType: identity.peerType ?? peerTypeHint,
          username: identity.username,
          phone: identity.phone,
          firstName: identity.firstName,
          lastName: identity.lastName
        });
        identity = this.normalizeDialog({
          entity: resolved.entity,
          id: resolved.telegramChatId,
          unreadCount: 0,
          pinned: false
        });
        if (!identity.accessHash) {
          identity = { ...identity, accessHash: inputPeerHash };
        }
        entitySource = entitySource ? `${entitySource}+resolvePeer` : "resolvePeer";
      } catch {
        // Keep live identity with hash — enough for durable InputPeer reconstruction.
      }
    }

    return { identity, hadLiveEntity, hadInputPeerHash, entitySource };
  }

  private async tryEntityFromPeerRef(
    runtime: TelegramRuntime,
    peerRef: unknown,
    source: string
  ): Promise<{ readonly entity: Record<string, unknown>; readonly source: string } | null> {
    if (peerRef == null) return null;
    // Avoid bare numeric getEntity — that is the PeerUser failure mode.
    if (typeof peerRef === "number" || typeof peerRef === "bigint") return null;
    if (typeof peerRef === "string" && /^-?\d+$/.test(peerRef.trim())) return null;
    try {
      if (typeof runtime.client.getEntity !== "function") return null;
      const entity = await runtime.client.getEntity(peerRef as never);
      if (entity && typeof entity === "object") {
        return { entity: entity as Record<string, unknown>, source: `entity_cache:${source}` };
      }
    } catch {
      return null;
    }
    return null;
  }

  /**
   * Builds a NormalizedDialog from a GramJS chat/user/channel entity already present on the update.
   */
  public identityFromChatEntity(telegramChatId: string, entity: Record<string, unknown>): NormalizedDialog {
    return this.normalizeDialog({ entity, id: telegramChatId, unreadCount: 0, pinned: false });
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
    const isSelf = Boolean(entity.self);
    const isSupport = Boolean(entity.support);
    const isArchived = Boolean(value.archived) || value.folderId === 1;
    const groupTitle = cleanOptionalString(entity.title);
    const messageObj = value.message as Record<string, unknown> | undefined;
    const topMessageId =
      messageObj?.id != null
        ? String(messageObj.id)
        : value.topMessage != null
          ? String(value.topMessage)
          : null;
    const title = buildCrmContactDisplayTitle({
      firstName,
      lastName,
      username,
      phone,
      telegramChatId: id,
      groupTitle,
      chatType,
      isBot
    });
    return {
      telegramChatId: id,
      title,
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
      isSelf,
      isSupport,
      isArchived,
      topMessageId,
      raw: this.redacted(
        entity,
        isBot,
        firstName,
        lastName,
        username,
        peerFields.accessHash,
        peerFields.peerType,
        phone,
        isSelf,
        isSupport,
        isArchived
      )
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
    phone: string | null = null,
    isSelf = false,
    isSupport = false,
    isArchived = false
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
      self: isSelf,
      support: isSupport,
      archived: isArchived,
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

function cleanOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Returns whether a title is a usable human label (not Unknown / raw id).
 * Phones and Telegram ids alone still trigger identity backfill.
 */
export function isUsableDisplayTitle(title: string | null | undefined, telegramChatId?: string | null): boolean {
  return isUsableHumanDisplayTitle(title, telegramChatId);
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
