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
  readonly date: number;
}

export type TelegramParseMode = "HTML" | "Markdown" | "MarkdownV2";

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
    parseMode?: TelegramParseMode
  ): Promise<TelegramMessage>;
  editMessageText(
    token: string,
    chatId: string | number,
    messageId: number,
    text: string,
    parseMode?: TelegramParseMode
  ): Promise<TelegramMessage | true>;
  deleteMessage(token: string, chatId: string | number, messageId: number): Promise<boolean>;
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
    parseMode?: TelegramParseMode
  ): Promise<TelegramMessage> {
    const body: Record<string, unknown> = { chat_id: chatId, text };
    if (parseMode) body.parse_mode = parseMode;
    const raw = await this.callTelegram<Record<string, unknown>>(token, "sendMessage", body);
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

  async deleteMessage(token: string, chatId: string | number, messageId: number): Promise<boolean> {
    return this.callTelegram<boolean>(token, "deleteMessage", {
      chat_id: chatId,
      message_id: messageId
    });
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
  if (raw.text != null) {
    return { ...message, text: String(raw.text) };
  }
  return message;
}

export interface FakeTelegramChatState {
  readonly id: number;
  readonly type: string;
  title?: string;
  username?: string;
  /** userId → ChatMember.status */
  members: Map<number, string>;
  messages: Array<{ messageId: number; text: string; deleted?: boolean }>;
  nextMessageId: number;
}

export interface FakeLeaderboardTelegramState {
  /** token → bot user */
  bots: Map<string, TelegramUser>;
  chats: Map<number, FakeTelegramChatState>;
  /** Forced failures keyed by `${token}:${method}` */
  failures?: Map<string, LeaderboardTelegramApiError>;
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
    async sendMessage(token, chatId, text) {
      fail(token, "sendMessage");
      requireBot(token);
      const chat = requireChat(chatId);
      const messageId = chat.nextMessageId++;
      chat.messages.push({ messageId, text });
      return {
        messageId,
        chat: mapFakeChat(chat),
        text,
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
      if (msg.text === text) return true;
      msg.text = text;
      return {
        messageId,
        chat: mapFakeChat(chat),
        text,
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
    }
  };
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
