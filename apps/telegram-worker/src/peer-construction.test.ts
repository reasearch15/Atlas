import { describe, expect, it, vi } from "vitest";
import {
  buildPeerConstructionDiagnostics,
  classifyTelegramPeerRpcError,
  diagnoseStoredPeerAgainstLive,
  parseTelegramBigInt,
  resolveInputPeer,
  TelegramAccessHashParseError,
  TelegramPeerConstructionError
} from "./entity-resolution";

const PICASSO_CHAT_ID = "5476500286";
const PICASSO_ACCESS_HASH = "8949449174917549431";

function makeApi() {
  class InputPeerUser {
    userId: bigint;
    accessHash: bigint;
    className = "InputPeerUser";
    constructor(input: { userId: bigint; accessHash: bigint }) {
      this.userId = input.userId;
      this.accessHash = input.accessHash;
    }
  }
  class InputPeerChannel {
    channelId: bigint;
    accessHash: bigint;
    className = "InputPeerChannel";
    constructor(input: { channelId: bigint; accessHash: bigint }) {
      this.channelId = input.channelId;
      this.accessHash = input.accessHash;
    }
  }
  class InputPeerChat {
    chatId: bigint;
    className = "InputPeerChat";
    constructor(input: { chatId: bigint }) {
      this.chatId = input.chatId;
    }
  }
  return {
    InputPeerUser,
    InputPeerChannel,
    InputPeerChat,
    InputUser: InputPeerUser,
    InputChannel: InputPeerChannel,
    users: { GetUsers: class {} },
    channels: { GetChannels: class {} }
  };
}

describe("direct InputPeerUser construction", () => {
  it("USER with large 64-bit telegramChatId and accessHash constructs InputPeerUser via BigInt", async () => {
    const Api = makeApi();
    const getDialogs = vi.fn(async () => {
      throw new Error("fallback dialogs must not run");
    });
    const invoke = vi.fn(async () => {
      throw new Error("ACCESS_HASH_INVALID: enrichment must not discard direct peer");
    });
    const runtime = {
      accountId: "acc",
      client: {
        getEntity: async () => {
          throw new Error("Could not find the input entity");
        },
        getDialogs,
        invoke
      },
      Api
    } as never;

    const resolved = await resolveInputPeer(runtime, {
      telegramChatId: PICASSO_CHAT_ID,
      chatType: "PRIVATE",
      peerType: "USER",
      accessHash: PICASSO_ACCESS_HASH
    });

    expect(resolved.peerType).toBe("USER");
    expect(resolved.accessHash).toBe(PICASSO_ACCESS_HASH);
    expect(resolved.inputPeer).toBeInstanceOf(Api.InputPeerUser);
    const peer = resolved.inputPeer as { userId: bigint; accessHash: bigint; className: string };
    expect(typeof peer.userId).toBe("bigint");
    expect(typeof peer.accessHash).toBe("bigint");
    expect(peer.userId).toBe(BigInt(PICASSO_CHAT_ID));
    expect(peer.accessHash).toBe(BigInt(PICASSO_ACCESS_HASH));
    expect(peer.className).toBe("InputPeerUser");
    expect(getDialogs).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("string DB values parse to BigInt without Number precision loss", () => {
    expect(parseTelegramBigInt(PICASSO_CHAT_ID, "telegramChatId")).toBe(BigInt(PICASSO_CHAT_ID));
    expect(parseTelegramBigInt(PICASSO_ACCESS_HASH, "accessHash")).toBe(BigInt(PICASSO_ACCESS_HASH));
    expect(parseTelegramBigInt(BigInt(PICASSO_ACCESS_HASH), "accessHash")).toBe(BigInt(PICASSO_ACCESS_HASH));
    // Decimal-like object from older drivers
    expect(parseTelegramBigInt({ toString: () => PICASSO_ACCESS_HASH }, "accessHash")).toBe(
      BigInt(PICASSO_ACCESS_HASH)
    );
  });

  it("direct peer path is returned without fallback when enrichment RPC fails", async () => {
    const Api = makeApi();
    let dialogsCalled = 0;
    const runtime = {
      accountId: "acc",
      client: {
        getEntity: async () => null,
        getDialogs: async () => {
          dialogsCalled += 1;
          return [];
        },
        invoke: async () => {
          throw new Error("PEER_ID_INVALID");
        }
      },
      Api
    } as never;

    const resolved = await resolveInputPeer(runtime, {
      telegramChatId: PICASSO_CHAT_ID,
      peerType: "USER",
      chatType: "PRIVATE",
      accessHash: PICASSO_ACCESS_HASH
    });

    expect(resolved.inputPeer).toBeInstanceOf(Api.InputPeerUser);
    expect(dialogsCalled).toBe(0);
  });

  it("invalid access hash gives explicit parse error", () => {
    expect(() => parseTelegramBigInt("not-a-hash", "accessHash")).toThrow(TelegramAccessHashParseError);
    expect(() => parseTelegramBigInt(Number.MAX_VALUE, "accessHash")).toThrow(TelegramAccessHashParseError);
    expect(() => parseTelegramBigInt(undefined, "accessHash")).toThrow(TelegramAccessHashParseError);
    try {
      parseTelegramBigInt("abc", "accessHash");
    } catch (error) {
      expect(error).toBeInstanceOf(TelegramAccessHashParseError);
      expect((error as TelegramAccessHashParseError).code).toBe("TELEGRAM_ACCESS_HASH_PARSE_FAILED");
    }
  });

  it("Telegram RPC rejection preserves original error code", () => {
    const accessHash = classifyTelegramPeerRpcError(new Error("RPCError: ACCESS_HASH_INVALID (400)"));
    expect(accessHash).toMatchObject({
      code: "TELEGRAM_ACCESS_HASH_INVALID",
      telegramErrorCode: "ACCESS_HASH_INVALID",
      retryable: true
    });

    const peerId = classifyTelegramPeerRpcError(new Error("PEER_ID_INVALID"));
    expect(peerId).toMatchObject({
      code: "TELEGRAM_PEER_ID_INVALID",
      telegramErrorCode: "PEER_ID_INVALID"
    });

    const deactivated = classifyTelegramPeerRpcError(new Error("INPUT_USER_DEACTIVATED"));
    expect(deactivated).toMatchObject({
      code: "TELEGRAM_PEER_DEACTIVATED",
      retryable: false
    });

    const construction = classifyTelegramPeerRpcError(
      new TelegramPeerConstructionError("USER peer requires access_hash")
    );
    expect(construction?.code).toBe("TELEGRAM_PEER_CONSTRUCTION_FAILED");
  });

  it("Picasso-like peer constructs and resolves successfully for SEND_TEXT path", async () => {
    const Api = makeApi();
    const runtime = {
      accountId: "acc",
      client: {
        getEntity: async () => ({
          className: "User",
          id: PICASSO_CHAT_ID,
          accessHash: PICASSO_ACCESS_HASH,
          firstName: "Picasso"
        }),
        getDialogs: async () => {
          throw new Error("should not fetch dialogs");
        },
        invoke: async () => {
          throw new Error("should not invoke GetUsers for direct path");
        }
      },
      Api
    } as never;

    const resolved = await resolveInputPeer(runtime, {
      telegramChatId: PICASSO_CHAT_ID,
      chatType: "PRIVATE",
      peerType: "USER",
      accessHash: PICASSO_ACCESS_HASH,
      firstName: "Picasso"
    });

    expect(resolved.telegramChatId).toBe(PICASSO_CHAT_ID);
    expect(resolved.firstName).toBe("Picasso");
    expect(resolved.inputPeer).toBeInstanceOf(Api.InputPeerUser);
    const diagnostics = buildPeerConstructionDiagnostics(
      {
        telegramChatId: PICASSO_CHAT_ID,
        peerType: "USER",
        accessHash: PICASSO_ACCESS_HASH
      },
      "InputPeerUser",
      "stored_direct"
    );
    expect(diagnostics).toMatchObject({
      peerType: "USER",
      telegramChatIdPresent: true,
      accessHashPresent: true,
      telegramChatIdParseOk: true,
      accessHashParseOk: true,
      constructedPeerClass: "InputPeerUser"
    });
    // Never include raw hash in diagnostics object keys used for logging contract.
    expect(JSON.stringify(diagnostics)).not.toContain(PICASSO_ACCESS_HASH);
  });

  it("SEND_MEDIA uses the same resolveInputPeer resolver for USER peers", async () => {
    // sendMediaFile / sendText both call adapter.resolvePeer → resolveTelegramPeer.
    // Prove the shared resolver returns InputPeerUser for media-eligible Picasso metadata.
    const Api = makeApi();
    const runtime = {
      accountId: "acc",
      client: {
        getEntity: async () => null,
        getDialogs: async () => [],
        invoke: async () => {
          throw new Error("should not be required");
        }
      },
      Api
    } as never;

    const forMedia = await resolveInputPeer(runtime, {
      telegramChatId: PICASSO_CHAT_ID,
      peerType: "USER",
      chatType: "PRIVATE",
      accessHash: PICASSO_ACCESS_HASH
    });
    expect(forMedia.inputPeer).toBeInstanceOf(Api.InputPeerUser);
    expect((forMedia.inputPeer as { className: string }).className).toBe("InputPeerUser");
  });

  it("older working CHAT peers remain unaffected (InputPeerChat, no access hash)", async () => {
    const Api = makeApi();
    const runtime = {
      accountId: "acc",
      client: {
        getEntity: async () => ({ className: "Chat", id: "12345" }),
        getDialogs: async () => [],
        invoke: async () => null
      },
      Api
    } as never;

    const resolved = await resolveInputPeer(runtime, {
      telegramChatId: "-12345",
      peerType: "CHAT",
      chatType: "GROUP",
      accessHash: null
    });
    expect(resolved.peerType).toBe("CHAT");
    expect(resolved.inputPeer).toBeInstanceOf(Api.InputPeerChat);
  });

  it("read-only stored-vs-live diagnostic flags stale hash without printing it", () => {
    const report = diagnoseStoredPeerAgainstLive(
      {
        peerType: "USER",
        telegramChatId: PICASSO_CHAT_ID,
        accessHash: PICASSO_ACCESS_HASH
      },
      {
        peerType: "USER",
        telegramChatId: PICASSO_CHAT_ID,
        accessHash: "1111222233334444555"
      }
    );
    expect(report.possibleStaleAccessHash).toBe(true);
    expect(report.accessHashMatches).toBe(false);
    expect(report.storedAccessHashPresent).toBe(true);
    expect(report.liveAccessHashPresent).toBe(true);
    expect(JSON.stringify(report)).not.toContain(PICASSO_ACCESS_HASH);
    expect(JSON.stringify(report)).not.toContain("1111222233334444555");
  });
});
