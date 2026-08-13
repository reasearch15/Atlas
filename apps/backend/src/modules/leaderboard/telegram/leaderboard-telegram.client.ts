/**
 * Isolated Telegram Bot API client for leaderboard public posts + membership checks.
 * Never logs bot tokens. Domain services must not call api.telegram.org directly.
 */

export interface TelegramUser {
  readonly id: number;
  readonly isBot: boolean;
  readonly firstName: string;
  readonly lastName?: string;
  readonly username?: string;
}

export interface TelegramChat {
  readonly id: number;
  readonly type: string;
  readonly title?: string;
  readonly username?: string;
}

export interface TelegramChatMember {
  readonly status: string;
  readonly user: TelegramUser;
}

export interface TelegramMessage {
  readonly messageId: number;
  readonly chat: TelegramChat;
  readonly text?: string;
  readonly caption?: string;
  readonly date: number;
}

export type TelegramParseMode = "HTML" | "Markdown" | "MarkdownV2";

export type TelegramInlineKeyboardButton =
  | {
      readonly text: string;
      readonly callback_data: string;
    }
  | {
      readonly text: string;
      readonly url: string;
    };

export interface TelegramInlineKeyboardMarkup {
  readonly inline_keyboard: ReadonlyArray<ReadonlyArray<TelegramInlineKeyboardButton>>;
}

export type SendMessageOptions = {
  readonly parseMode?: TelegramParseMode;
  readonly replyMarkup?: TelegramInlineKeyboardMarkup;
};

export type SendPhotoOptions = {
  readonly caption?: string;
  readonly parseMode?: TelegramParseMode;
  readonly replyMarkup?: TelegramInlineKeyboardMarkup;
  /** Multipart filename hint (never logged as a path). */
  readonly filename?: string;
};

export type EditMessageMediaOptions = {
  readonly caption?: string;
  readonly parseMode?: TelegramParseMode;
  readonly replyMarkup?: TelegramInlineKeyboardMarkup;
  readonly filename?: string;
};

export type TelegramInputMediaPhoto = {
  readonly type: "photo";
  readonly media: "attach://leaderboard.png" | string;
  readonly caption?: string;
  readonly parse_mode?: TelegramParseMode;
};

export interface TelegramWebhookInfo {
  readonly url: string;
  readonly hasCustomCertificate: boolean;
  readonly pendingUpdateCount: number;
}

export interface TelegramCallbackQuery {
  readonly id: string;
  readonly from: TelegramUser;
  readonly data?: string;
  readonly message?: {
    readonly messageId: number;
    readonly chat: TelegramChat;
  };
}

export interface TelegramUpdate {
  readonly updateId: number;
  readonly message?: {
    readonly messageId: number;
    readonly text?: string;
    readonly date: number;
    readonly chat: TelegramChat;
    readonly from?: TelegramUser;
  };
  readonly callbackQuery?: TelegramCallbackQuery;
}

export interface LeaderboardTelegramClient {
  getMe(token: string): Promise<TelegramUser>;
  getChat(token: string, chatId: string | number): Promise<TelegramChat>;
  getChatMember(
    token: string,
    chatId: string | number,
    userId: string | number
  ): Promise<TelegramChatMember>;
  getChatAdministrators?(token: string, chatId: string | number): Promise<readonly TelegramChatMember[]>;
  sendMessage(
    token: string,
    chatId: string | number,
    text: string,
    parseModeOrOptions?: TelegramParseMode | SendMessageOptions
  ): Promise<TelegramMessage>;
  sendPhoto(
    token: string,
    chatId: string | number,
    photo: Buffer,
    options?: SendPhotoOptions
  ): Promise<TelegramMessage>;
  editMessageText(
    token: string,
    chatId: string | number,
    messageId: number,
    text: string,
    parseMode?: TelegramParseMode
  ): Promise<TelegramMessage | true>;
  editMessageMedia(
    token: string,
    chatId: string | number,
    messageId: number,
    photo: Buffer,
    options?: EditMessageMediaOptions
  ): Promise<TelegramMessage | true>;
  editMessageCaption?(
    token: string,
    chatId: string | number,
    messageId: number,
    caption: string,
    options?: { readonly parseMode?: TelegramParseMode; readonly replyMarkup?: TelegramInlineKeyboardMarkup }
  ): Promise<TelegramMessage | true>;
  editMessageReplyMarkup?(
    token: string,
    chatId: string | number,
    messageId: number,
    replyMarkup: TelegramInlineKeyboardMarkup
  ): Promise<TelegramMessage | true>;
  deleteMessage(token: string, chatId: string | number, messageId: number): Promise<boolean>;
  setWebhook?(
    token: string,
    url: string,
    secretToken?: string
  ): Promise<boolean>;
  deleteWebhook?(token: string, dropPendingUpdates?: boolean): Promise<boolean>;
  getUpdates?(
    token: string,
    options?: { readonly offset?: number; readonly timeout?: number; readonly limit?: number }
  ): Promise<readonly TelegramUpdate[]>;
  answerCallbackQuery?(token: string, callbackQueryId: string, text?: string): Promise<boolean>;
}

export class LeaderboardTelegramApiError extends Error {
  readonly httpStatus: number;
  readonly telegramErrorCode: number | null;
  readonly description: string;
  readonly retryAfterSeconds?: number;
  readonly permanent: boolean;

  constructor(input: {
    readonly httpStatus: number;
    readonly telegramErrorCode?: number | null;
    readonly description: string;
    readonly retryAfterSeconds?: number;
    readonly permanent: boolean;
  }) {
    super(input.description);
    this.name = "LeaderboardTelegramApiError";
    this.httpStatus = input.httpStatus;
    this.telegramErrorCode = input.telegramErrorCode ?? null;
    this.description = input.description;
    this.permanent = input.permanent;
    if (input.retryAfterSeconds != null) {
      this.retryAfterSeconds = input.retryAfterSeconds;
    }
  }
}

const PERMANENT_DESCRIPTION_PATTERNS = [
  /unauthorized/i,
  /bot was kicked/i,
  /bot is not a member/i,
  /chat not found/i,
  /chat_not_found/i,
  /user not found/i,
  /PEER_ID_INVALID/i,
  /bot is not an administrator/i,
  /not enough rights/i,
  /have no rights/i,
  /need administrator rights/i,
  /CHAT_ADMIN_REQUIRED/i,
  /forbidden/i
];

export function isPermanentTelegramFailure(
  httpStatus: number,
  description: string,
  telegramErrorCode?: number | null
): boolean {
  if (httpStatus === 401 || httpStatus === 403) return true;
  if (telegramErrorCode === 401 || telegramErrorCode === 403) return true;
  return PERMANENT_DESCRIPTION_PATTERNS.some((re) => re.test(description));
}

type TelegramApiResponse<T> = {
  readonly ok: boolean;
  readonly result?: T;
  readonly description?: string;
  readonly error_code?: number;
  readonly parameters?: { readonly retry_after?: number };
};

export class HttpLeaderboardTelegramClient implements LeaderboardTelegramClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async getMe(token: string): Promise<TelegramUser> {
    const raw = await this.callTelegram<Record<string, unknown>>(token, "getMe");
    return mapUser(raw);
  }

  async getChat(token: string, chatId: string | number): Promise<TelegramChat> {
    const raw = await this.callTelegram<Record<string, unknown>>(token, "getChat", { chat_id: chatId });
    return mapChat(raw);
  }

  async getChatMember(
    token: string,
    chatId: string | number,
    userId: string | number
  ): Promise<TelegramChatMember> {
    const raw = await this.callTelegram<Record<string, unknown>>(token, "getChatMember", {
      chat_id: chatId,
      user_id: userId
    });
    return mapChatMember(raw);
  }

  async getChatAdministrators(token: string, chatId: string | number): Promise<readonly TelegramChatMember[]> {
    const raw = await this.callTelegram<readonly Record<string, unknown>[]>(token, "getChatAdministrators", {
      chat_id: chatId
    });
    return raw.map(mapChatMember);
  }

  async sendMessage(
    token: string,
    chatId: string | number,
    text: string,
    parseModeOrOptions?: TelegramParseMode | SendMessageOptions
  ): Promise<TelegramMessage> {
    const options = normalizeSendMessageOptions(parseModeOrOptions);
    const body: Record<string, unknown> = { chat_id: chatId, text };
    if (options.parseMode) body.parse_mode = options.parseMode;
    if (options.replyMarkup) body.reply_markup = options.replyMarkup;
    const raw = await this.callTelegram<Record<string, unknown>>(token, "sendMessage", body);
    return mapMessage(raw);
  }

  async sendPhoto(
    token: string,
    chatId: string | number,
    photo: Buffer,
    options?: SendPhotoOptions
  ): Promise<TelegramMessage> {
    const filename = sanitizeUploadFilename(options?.filename ?? "leaderboard.png");
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("photo", new Blob([new Uint8Array(photo)], { type: "image/png" }), filename);
    if (options?.caption != null) form.append("caption", options.caption);
    if (options?.parseMode) form.append("parse_mode", options.parseMode);
    if (options?.replyMarkup) {
      form.append("reply_markup", JSON.stringify(options.replyMarkup));
    }
    const raw = await this.callTelegramMultipart<Record<string, unknown>>(token, "sendPhoto", form);
    return mapMessage(raw);
  }

  async editMessageText(
    token: string,
    chatId: string | number,
    messageId: number,
    text: string,
    parseMode?: TelegramParseMode
  ): Promise<TelegramMessage | true> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text
    };
    if (parseMode) body.parse_mode = parseMode;
    const raw = await this.callTelegram<Record<string, unknown> | true>(token, "editMessageText", body);
    if (raw === true) return true;
    return mapMessage(raw);
  }

  async editMessageMedia(
    token: string,
    chatId: string | number,
    messageId: number,
    photo: Buffer,
    options?: EditMessageMediaOptions
  ): Promise<TelegramMessage | true> {
    const filename = sanitizeUploadFilename(options?.filename ?? "leaderboard.png");
    const attachName = "leaderboard.png";
    const media: TelegramInputMediaPhoto = {
      type: "photo",
      media: `attach://${attachName}`,
      ...(options?.caption != null ? { caption: options.caption } : {}),
      ...(options?.parseMode ? { parse_mode: options.parseMode } : {})
    };
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("message_id", String(messageId));
    form.append("media", JSON.stringify(media));
    form.append(attachName, new Blob([new Uint8Array(photo)], { type: "image/png" }), filename);
    if (options?.replyMarkup) {
      form.append("reply_markup", JSON.stringify(options.replyMarkup));
    }
    const raw = await this.callTelegramMultipart<Record<string, unknown> | true>(
      token,
      "editMessageMedia",
      form
    );
    if (raw === true) return true;
    return mapMessage(raw);
  }

  async editMessageCaption(
    token: string,
    chatId: string | number,
    messageId: number,
    caption: string,
    options?: { readonly parseMode?: TelegramParseMode; readonly replyMarkup?: TelegramInlineKeyboardMarkup }
  ): Promise<TelegramMessage | true> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      caption
    };
    if (options?.parseMode) body.parse_mode = options.parseMode;
    if (options?.replyMarkup) body.reply_markup = options.replyMarkup;
    const raw = await this.callTelegram<Record<string, unknown> | true>(
      token,
      "editMessageCaption",
      body
    );
    if (raw === true) return true;
    return mapMessage(raw);
  }

  async editMessageReplyMarkup(
    token: string,
    chatId: string | number,
    messageId: number,
    replyMarkup: TelegramInlineKeyboardMarkup
  ): Promise<TelegramMessage | true> {
    const raw = await this.callTelegram<Record<string, unknown> | true>(token, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup
    });
    if (raw === true) return true;
    return mapMessage(raw);
  }

  async deleteMessage(token: string, chatId: string | number, messageId: number): Promise<boolean> {
    return this.callTelegram<boolean>(token, "deleteMessage", {
      chat_id: chatId,
      message_id: messageId
    });
  }

  async setWebhook(token: string, url: string, secretToken?: string): Promise<boolean> {
    const body: Record<string, unknown> = {
      url,
      allowed_updates: ["message", "callback_query"]
    };
    if (secretToken) body.secret_token = secretToken;
    return this.callTelegram<boolean>(token, "setWebhook", body);
  }

  async deleteWebhook(token: string, dropPendingUpdates = false): Promise<boolean> {
    return this.callTelegram<boolean>(token, "deleteWebhook", {
      drop_pending_updates: dropPendingUpdates
    });
  }

  async getUpdates(
    token: string,
    options?: { readonly offset?: number; readonly timeout?: number; readonly limit?: number }
  ): Promise<readonly TelegramUpdate[]> {
    const body: Record<string, unknown> = {};
    if (options?.offset != null) body.offset = options.offset;
    if (options?.timeout != null) body.timeout = options.timeout;
    if (options?.limit != null) body.limit = options.limit;
    const raw = await this.callTelegram<readonly Record<string, unknown>[]>(token, "getUpdates", body);
    return raw.map(mapUpdate);
  }

  async answerCallbackQuery(token: string, callbackQueryId: string, text?: string): Promise<boolean> {
    const body: Record<string, unknown> = { callback_query_id: callbackQueryId };
    if (text) body.text = text;
    return this.callTelegram<boolean>(token, "answerCallbackQuery", body);
  }

  private async callTelegram<T>(
    token: string,
    method: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    // Intentionally omit token from any thrown messages / logs.
    const url = `https://api.telegram.org/bot${token}/${method}`;
    let response: Response;
    try {
      const init: RequestInit = {
        method: "POST",
        headers: { "content-type": "application/json" }
      };
      if (body) {
        init.body = JSON.stringify(body);
      }
      response = await this.fetchImpl(url, init);
    } catch (err) {
      const description = err instanceof Error ? err.message : "network error";
      throw new LeaderboardTelegramApiError({
        httpStatus: 0,
        telegramErrorCode: null,
        description: `Telegram ${method} network failure: ${description}`,
        permanent: false
      });
    }

    return this.parseTelegramResponse<T>(method, response);
  }

  private async callTelegramMultipart<T>(
    token: string,
    method: string,
    form: FormData
  ): Promise<T> {
    const url = `https://api.telegram.org/bot${token}/${method}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        body: form
      });
    } catch (err) {
      const description = err instanceof Error ? err.message : "network error";
      throw new LeaderboardTelegramApiError({
        httpStatus: 0,
        telegramErrorCode: null,
        description: `Telegram ${method} network failure: ${description}`,
        permanent: false
      });
    }
    return this.parseTelegramResponse<T>(method, response);
  }

  private async parseTelegramResponse<T>(method: string, response: Response): Promise<T> {
    let payload: TelegramApiResponse<T> | null = null;
    try {
      payload = (await response.json()) as TelegramApiResponse<T>;
    } catch {
      throw new LeaderboardTelegramApiError({
        httpStatus: response.status,
        telegramErrorCode: null,
        description: `Telegram ${method} returned non-JSON response`,
        permanent: isPermanentTelegramFailure(response.status, "non-JSON response")
      });
    }

    if (!response.ok || !payload.ok || payload.result === undefined) {
      const description = payload.description ?? `Telegram ${method} failed`;
      const telegramErrorCode = payload.error_code ?? null;
      const retryAfter =
        response.status === 429 || telegramErrorCode === 429
          ? normalizeRetryAfter(payload.parameters?.retry_after)
          : undefined;
      const errorInput: {
        httpStatus: number;
        telegramErrorCode: number | null;
        description: string;
        permanent: boolean;
        retryAfterSeconds?: number;
      } = {
        httpStatus: response.status,
        telegramErrorCode,
        description,
        permanent: isPermanentTelegramFailure(response.status, description, telegramErrorCode)
      };
      if (retryAfter != null) {
        errorInput.retryAfterSeconds = retryAfter;
      }
      throw new LeaderboardTelegramApiError(errorInput);
    }

    return payload.result;
  }
}

function normalizeRetryAfter(value: number | undefined): number | undefined {
  if (value == null || !Number.isFinite(value) || value < 0) return undefined;
  return Math.ceil(value);
}

function mapUser(raw: Record<string, unknown>): TelegramUser {
  const user: TelegramUser = {
    id: Number(raw.id),
    isBot: Boolean(raw.is_bot),
    firstName: String(raw.first_name ?? "")
  };
  if (raw.last_name != null) {
    return { ...user, lastName: String(raw.last_name), ...(raw.username != null ? { username: String(raw.username) } : {}) };
  }
  if (raw.username != null) {
    return { ...user, username: String(raw.username) };
  }
  return user;
}

function mapChat(raw: Record<string, unknown>): TelegramChat {
  const chat: TelegramChat = {
    id: Number(raw.id),
    type: String(raw.type ?? "")
  };
  if (raw.title != null) {
    return {
      ...chat,
      title: String(raw.title),
      ...(raw.username != null ? { username: String(raw.username) } : {})
    };
  }
  if (raw.username != null) {
    return { ...chat, username: String(raw.username) };
  }
  return chat;
}

function mapChatMember(raw: Record<string, unknown>): TelegramChatMember {
  const userRaw = (raw.user ?? {}) as Record<string, unknown>;
  return {
    status: String(raw.status ?? ""),
    user: mapUser(userRaw)
  };
}

function mapMessage(raw: Record<string, unknown>): TelegramMessage {
  const chatRaw = (raw.chat ?? {}) as Record<string, unknown>;
  const message: TelegramMessage = {
    messageId: Number(raw.message_id),
    chat: mapChat(chatRaw),
    date: Number(raw.date ?? 0)
  };
  if (raw.text != null && raw.caption != null) {
    return { ...message, text: String(raw.text), caption: String(raw.caption) };
  }
  if (raw.text != null) {
    return { ...message, text: String(raw.text) };
  }
  if (raw.caption != null) {
    return { ...message, caption: String(raw.caption) };
  }
  return message;
}

function sanitizeUploadFilename(name: string): string {
  const base = name.trim().replace(/[^A-Za-z0-9._-]/g, "_") || "leaderboard.png";
  return base.toLowerCase().endsWith(".png") ? base : `${base}.png`;
}

export interface FakeTelegramChatState {
  readonly id: number;
  readonly type: string;
  title?: string;
  username?: string;
  /** userId → ChatMember.status */
  members: Map<number, string>;
  messages: Array<{
    messageId: number;
    text?: string;
    caption?: string;
    /** Present when message is a photo board. */
    photo?: boolean;
    photoBytes?: number;
    deleted?: boolean;
    replyMarkup?: TelegramInlineKeyboardMarkup;
  }>;
  nextMessageId: number;
}

export interface FakeLeaderboardTelegramState {
  /** token → bot user */
  bots: Map<string, TelegramUser>;
  chats: Map<number, FakeTelegramChatState>;
  /** Forced failures keyed by `${token}:${method}` */
  failures?: Map<string, LeaderboardTelegramApiError>;
  webhooks?: Map<string, { url: string; secretToken?: string }>;
  pendingUpdates?: Map<string, TelegramUpdate[]>;
  callbackAnswers?: Array<{ callbackQueryId: string; text?: string }>;
}

export function createFakeLeaderboardTelegramClient(
  state: FakeLeaderboardTelegramState
): LeaderboardTelegramClient {
  const fail = (token: string, method: string): void => {
    const err = state.failures?.get(`${token}:${method}`);
    if (err) throw err;
  };

  const requireBot = (token: string): TelegramUser => {
    const bot = state.bots.get(token);
    if (!bot) {
      throw new LeaderboardTelegramApiError({
        httpStatus: 401,
        telegramErrorCode: 401,
        description: "Unauthorized",
        permanent: true
      });
    }
    return bot;
  };

  const requireChat = (chatId: string | number): FakeTelegramChatState => {
    const id = Number(chatId);
    const chat = state.chats.get(id);
    if (!chat) {
      throw new LeaderboardTelegramApiError({
        httpStatus: 400,
        telegramErrorCode: 400,
        description: "Bad Request: chat not found",
        permanent: true
      });
    }
    return chat;
  };

  return {
    async getMe(token) {
      fail(token, "getMe");
      return requireBot(token);
    },
    async getChat(token, chatId) {
      fail(token, "getChat");
      requireBot(token);
      const chat = requireChat(chatId);
      return mapFakeChat(chat);
    },
    async getChatMember(token, chatId, userId) {
      fail(token, "getChatMember");
      requireBot(token);
      const chat = requireChat(chatId);
      const uid = Number(userId);
      const status = chat.members.get(uid);
      if (!status) {
        throw new LeaderboardTelegramApiError({
          httpStatus: 400,
          telegramErrorCode: 400,
          description: "Bad Request: user not found",
          permanent: true
        });
      }
      return {
        status,
        user: { id: uid, isBot: false, firstName: `User${uid}` }
      };
    },
    async getChatAdministrators(token, chatId) {
      fail(token, "getChatAdministrators");
      requireBot(token);
      const chat = requireChat(chatId);
      return [...chat.members.entries()]
        .filter(([, status]) => status === "creator" || status === "administrator")
        .map(([id, status]) => ({
          status,
          user: { id, isBot: false, firstName: `User${id}` }
        }));
    },
    async sendMessage(token, chatId, text, parseModeOrOptions) {
      fail(token, "sendMessage");
      requireBot(token);
      const options = normalizeSendMessageOptions(parseModeOrOptions);
      const id = Number(chatId);
      let chat = state.chats.get(id);
      if (!chat) {
        // Auto-create private DM chats for personal bot messages in tests.
        chat = {
          id,
          type: "private",
          members: new Map([[id, "member"]]),
          messages: [],
          nextMessageId: 1
        };
        state.chats.set(id, chat);
      }
      const messageId = chat.nextMessageId++;
      chat.messages.push({
        messageId,
        text,
        ...(options.replyMarkup ? { replyMarkup: options.replyMarkup } : {})
      });
      return {
        messageId,
        chat: mapFakeChat(chat),
        text,
        date: Math.floor(Date.now() / 1000)
      };
    },
    async sendPhoto(token, chatId, photo, options) {
      fail(token, "sendPhoto");
      requireBot(token);
      if (!Buffer.isBuffer(photo) || photo.length === 0) {
        throw new LeaderboardTelegramApiError({
          httpStatus: 400,
          telegramErrorCode: 400,
          description: "Bad Request: photo must be non-empty",
          permanent: true
        });
      }
      const id = Number(chatId);
      let chat = state.chats.get(id);
      if (!chat) {
        chat = {
          id,
          type: "channel",
          members: new Map(),
          messages: [],
          nextMessageId: 1
        };
        state.chats.set(id, chat);
      }
      const messageId = chat.nextMessageId++;
      chat.messages.push({
        messageId,
        photo: true,
        photoBytes: photo.byteLength,
        ...(options?.caption != null ? { caption: options.caption } : {}),
        ...(options?.replyMarkup ? { replyMarkup: options.replyMarkup } : {})
      });
      return {
        messageId,
        chat: mapFakeChat(chat),
        ...(options?.caption != null ? { caption: options.caption } : {}),
        date: Math.floor(Date.now() / 1000)
      };
    },
    async editMessageText(token, chatId, messageId, text) {
      fail(token, "editMessageText");
      requireBot(token);
      const chat = requireChat(chatId);
      const msg = chat.messages.find((m) => m.messageId === messageId && !m.deleted);
      if (!msg) {
        throw new LeaderboardTelegramApiError({
          httpStatus: 400,
          telegramErrorCode: 400,
          description: "Bad Request: message to edit not found",
          permanent: true
        });
      }
      if (msg.photo) {
        throw new LeaderboardTelegramApiError({
          httpStatus: 400,
          telegramErrorCode: 400,
          description: "Bad Request: there is no text in the message to edit",
          permanent: true
        });
      }
      if (msg.text === text) return true;
      msg.text = text;
      return {
        messageId,
        chat: mapFakeChat(chat),
        text,
        date: Math.floor(Date.now() / 1000)
      };
    },
    async editMessageMedia(token, chatId, messageId, photo, options) {
      fail(token, "editMessageMedia");
      requireBot(token);
      const chat = requireChat(chatId);
      const msg = chat.messages.find((m) => m.messageId === messageId && !m.deleted);
      if (!msg) {
        throw new LeaderboardTelegramApiError({
          httpStatus: 400,
          telegramErrorCode: 400,
          description: "Bad Request: message to edit not found",
          permanent: true
        });
      }
      if (!msg.photo) {
        throw new LeaderboardTelegramApiError({
          httpStatus: 400,
          telegramErrorCode: 400,
          description: "Bad Request: there is no media in the message to edit",
          permanent: true
        });
      }
      if (!Buffer.isBuffer(photo) || photo.length === 0) {
        throw new LeaderboardTelegramApiError({
          httpStatus: 400,
          telegramErrorCode: 400,
          description: "Bad Request: photo must be non-empty",
          permanent: true
        });
      }
      msg.photo = true;
      msg.photoBytes = photo.byteLength;
      if (options?.caption != null) msg.caption = options.caption;
      if (options?.replyMarkup) msg.replyMarkup = options.replyMarkup;
      delete msg.text;
      return {
        messageId,
        chat: mapFakeChat(chat),
        ...(msg.caption != null ? { caption: msg.caption } : {}),
        date: Math.floor(Date.now() / 1000)
      };
    },
    async editMessageCaption(token, chatId, messageId, caption, options) {
      fail(token, "editMessageCaption");
      requireBot(token);
      const chat = requireChat(chatId);
      const msg = chat.messages.find((m) => m.messageId === messageId && !m.deleted);
      if (!msg || !msg.photo) {
        throw new LeaderboardTelegramApiError({
          httpStatus: 400,
          telegramErrorCode: 400,
          description: "Bad Request: message to edit not found",
          permanent: true
        });
      }
      msg.caption = caption;
      if (options?.replyMarkup) msg.replyMarkup = options.replyMarkup;
      return {
        messageId,
        chat: mapFakeChat(chat),
        caption,
        date: Math.floor(Date.now() / 1000)
      };
    },
    async editMessageReplyMarkup(token, chatId, messageId, replyMarkup) {
      fail(token, "editMessageReplyMarkup");
      requireBot(token);
      const chat = requireChat(chatId);
      const msg = chat.messages.find((m) => m.messageId === messageId && !m.deleted);
      if (!msg) {
        throw new LeaderboardTelegramApiError({
          httpStatus: 400,
          telegramErrorCode: 400,
          description: "Bad Request: message to edit not found",
          permanent: true
        });
      }
      msg.replyMarkup = replyMarkup;
      return {
        messageId,
        chat: mapFakeChat(chat),
        ...(msg.text != null ? { text: msg.text } : {}),
        ...(msg.caption != null ? { caption: msg.caption } : {}),
        date: Math.floor(Date.now() / 1000)
      };
    },
    async deleteMessage(token, chatId, messageId) {
      fail(token, "deleteMessage");
      requireBot(token);
      const chat = requireChat(chatId);
      const msg = chat.messages.find((m) => m.messageId === messageId && !m.deleted);
      if (!msg) {
        throw new LeaderboardTelegramApiError({
          httpStatus: 400,
          telegramErrorCode: 400,
          description: "Bad Request: message to delete not found",
          permanent: true
        });
      }
      msg.deleted = true;
      return true;
    },
    async setWebhook(token, url, secretToken) {
      fail(token, "setWebhook");
      requireBot(token);
      if (!state.webhooks) state.webhooks = new Map();
      state.webhooks.set(token, secretToken ? { url, secretToken } : { url });
      return true;
    },
    async deleteWebhook(token) {
      fail(token, "deleteWebhook");
      requireBot(token);
      state.webhooks?.delete(token);
      return true;
    },
    async getUpdates(token, options) {
      fail(token, "getUpdates");
      requireBot(token);
      const pending = state.pendingUpdates?.get(token) ?? [];
      const offset = options?.offset ?? 0;
      const filtered = pending.filter((u) => u.updateId >= offset);
      const limit = options?.limit ?? filtered.length;
      return filtered.slice(0, limit);
    },
    async answerCallbackQuery(token, callbackQueryId, text) {
      fail(token, "answerCallbackQuery");
      requireBot(token);
      if (!state.callbackAnswers) state.callbackAnswers = [];
      state.callbackAnswers.push({
        callbackQueryId,
        ...(text !== undefined ? { text } : {})
      });
      return true;
    }
  };
}

function normalizeSendMessageOptions(
  parseModeOrOptions?: TelegramParseMode | SendMessageOptions
): SendMessageOptions {
  if (parseModeOrOptions == null) return {};
  if (typeof parseModeOrOptions === "string") {
    return { parseMode: parseModeOrOptions };
  }
  return parseModeOrOptions;
}

function mapUpdate(raw: Record<string, unknown>): TelegramUpdate {
  const messageRaw = raw.message as Record<string, unknown> | undefined;
  const callbackRaw = raw.callback_query as Record<string, unknown> | undefined;
  const update: TelegramUpdate = { updateId: Number(raw.update_id) };

  if (messageRaw) {
    const fromRaw = messageRaw.from as Record<string, unknown> | undefined;
    const chatRaw = (messageRaw.chat ?? {}) as Record<string, unknown>;
    return {
      ...update,
      message: {
        messageId: Number(messageRaw.message_id),
        date: Number(messageRaw.date ?? 0),
        chat: mapChat(chatRaw),
        ...(messageRaw.text != null ? { text: String(messageRaw.text) } : {}),
        ...(fromRaw ? { from: mapUser(fromRaw) } : {})
      },
      ...(callbackRaw ? { callbackQuery: mapCallbackQuery(callbackRaw) } : {})
    };
  }

  if (callbackRaw) {
    return { ...update, callbackQuery: mapCallbackQuery(callbackRaw) };
  }

  return update;
}

function mapCallbackQuery(raw: Record<string, unknown>): TelegramCallbackQuery {
  const fromRaw = (raw.from ?? {}) as Record<string, unknown>;
  const messageRaw = raw.message as Record<string, unknown> | undefined;
  const mapped: TelegramCallbackQuery = {
    id: String(raw.id ?? ""),
    from: mapUser(fromRaw)
  };
  if (raw.data != null) {
    return messageRaw
      ? {
          ...mapped,
          data: String(raw.data),
          message: {
            messageId: Number(messageRaw.message_id),
            chat: mapChat((messageRaw.chat ?? {}) as Record<string, unknown>)
          }
        }
      : { ...mapped, data: String(raw.data) };
  }
  if (messageRaw) {
    return {
      ...mapped,
      message: {
        messageId: Number(messageRaw.message_id),
        chat: mapChat((messageRaw.chat ?? {}) as Record<string, unknown>)
      }
    };
  }
  return mapped;
}

function mapFakeChat(chat: FakeTelegramChatState): TelegramChat {
  const mapped: TelegramChat = { id: chat.id, type: chat.type };
  if (chat.title != null) {
    return chat.username != null
      ? { ...mapped, title: chat.title, username: chat.username }
      : { ...mapped, title: chat.title };
  }
  if (chat.username != null) {
    return { ...mapped, username: chat.username };
  }
  return mapped;
}
