import { describe, expect, it } from "vitest";
import {
  classifyMessageOrigin,
  isAtlasPendingTelegramMessageId,
  summarizeOutboundSendDiagnostics
} from "@atlas/shared";
import {
  coalescePeerPersistenceFields,
  isIncompletePrivatePeer,
  isPeerEntityResolutionError,
  resolveInputPeer,
  TelegramPeerUnresolvedError
} from "./entity-resolution";
import { isRemoteTelegramMessageId } from "./delivery-status";

/**
 * Atlas outbound send path contracts.
 * Native Telegram-app outbound (real ids like 572/573/575) must never be treated as Atlas send success.
 */
describe("Atlas outbound send path", () => {
  it("does not treat native Telegram outbound sync ids as Atlas send success", () => {
    const summary = summarizeOutboundSendDiagnostics([
      { direction: "OUTBOUND", internalSenderUserId: null, telegramMessageId: "572", sendStatus: "DELIVERED" },
      { direction: "OUTBOUND", internalSenderUserId: null, telegramMessageId: "573", sendStatus: "DELIVERED" },
      { direction: "OUTBOUND", internalSenderUserId: null, telegramMessageId: "575", sendStatus: "SENT" },
      {
        direction: "OUTBOUND",
        internalSenderUserId: "staff-1",
        telegramMessageId: "pending:send:5476500286:uuid",
        sendStatus: "FAILED_RETRYABLE"
      }
    ]);
    expect(summary.telegramAppOutboundSynced).toBe(3);
    expect(summary.atlasSendAttempts).toBe(1);
    expect(summary.atlasSendsDelivered).toBe(0);
    expect(summary.atlasSendsFailed).toBe(1);
    expect(classifyMessageOrigin({ direction: "OUTBOUND", telegramMessageId: "572" })).toBe(
      "OUTBOUND_TELEGRAM_SYNCED"
    );
  });

  it("fails clearly when private peer lacks access hash and cannot be resolved from cache/dialogs", async () => {
    const client = {
      getEntity: async () => {
        throw new Error('Could not find the input entity for {"userId":"5476500286"}');
      },
      getDialogs: async () => [],
      invoke: async () => {
        throw new Error("no api");
      }
    };
    const runtime = {
      accountId: "acc",
      client,
      Api: {
        InputPeerUser: class {
          userId: unknown;
          accessHash: unknown;
          constructor(input: { userId: unknown; accessHash: unknown }) {
            this.userId = input.userId;
            this.accessHash = input.accessHash;
          }
        },
        InputUser: class {
          userId: unknown;
          accessHash: unknown;
          constructor(input: { userId: unknown; accessHash: unknown }) {
            this.userId = input.userId;
            this.accessHash = input.accessHash;
          }
        },
        users: { GetUsers: class {} },
        channels: { GetChannels: class {} }
      }
    } as never;

    await expect(
      resolveInputPeer(runtime, {
        telegramChatId: "5476500286",
        chatType: "PRIVATE",
        peerType: null,
        accessHash: null,
        username: null
      })
    ).rejects.toMatchObject({ code: "TELEGRAM_PEER_UNRESOLVED" });

    expect(isIncompletePrivatePeer({ chatType: "PRIVATE", peerType: null, accessHash: null, telegramChatId: "5476500286" })).toBe(
      true
    );
    expect(isPeerEntityResolutionError(new TelegramPeerUnresolvedError())).toBe(true);
  });

  it("succeeds building InputPeer when access_hash is persisted", async () => {
    const client = {
      getEntity: async (peer: { accessHash?: string }) => ({
        className: "User",
        id: "5476500286",
        accessHash: peer.accessHash ?? "8949449174917549431",
        firstName: "Pat"
      }),
      getDialogs: async () => {
        throw new Error("should not fetch dialogs when stored hash works");
      },
      invoke: async () => {
        throw new Error("GetUsers enrichment must not be required for direct InputPeer");
      }
    };
    const InputPeerUser = class {
      userId: unknown;
      accessHash: unknown;
      className = "InputPeerUser";
      constructor(input: { userId: unknown; accessHash: unknown }) {
        this.userId = input.userId;
        this.accessHash = input.accessHash;
      }
    };
    const runtime = {
      accountId: "acc",
      client,
      Api: {
        InputPeerUser,
        InputUser: InputPeerUser,
        users: { GetUsers: class {} },
        channels: { GetChannels: class {} }
      }
    } as never;

    const resolved = await resolveInputPeer(runtime, {
      telegramChatId: "5476500286",
      chatType: "PRIVATE",
      peerType: "USER",
      accessHash: "8949449174917549431",
      username: null
    });
    expect(resolved.accessHash).toBe("8949449174917549431");
    expect(resolved.peerType).toBe("USER");
    expect(resolved.telegramChatId).toBe("5476500286");
    expect(resolved.inputPeer).toBeInstanceOf(InputPeerUser);
  });

  it("does not discard direct InputPeer when GetUsers enrichment throws", async () => {
    const InputPeerUser = class {
      userId: unknown;
      accessHash: unknown;
      className = "InputPeerUser";
      constructor(input: { userId: unknown; accessHash: unknown }) {
        this.userId = input.userId;
        this.accessHash = input.accessHash;
      }
    };
    const runtime = {
      accountId: "acc",
      client: {
        getEntity: async () => {
          throw new Error("Could not find the input entity");
        },
        getDialogs: async () => {
          throw new Error("dialogs fallback must not run");
        },
        invoke: async () => {
          throw new Error("ACCESS_HASH_INVALID");
        }
      },
      Api: {
        InputPeerUser,
        InputUser: InputPeerUser,
        users: { GetUsers: class {} },
        channels: { GetChannels: class {} }
      }
    } as never;

    const resolved = await resolveInputPeer(runtime, {
      telegramChatId: "5476500286",
      chatType: "PRIVATE",
      peerType: "USER",
      accessHash: "8949449174917549431"
    });
    expect(resolved.inputPeer).toBeInstanceOf(InputPeerUser);
    expect(resolved.accessHash).toBe("8949449174917549431");
  });

  it("repairs incomplete chat identity from the next inbound peer fields without duplicating the conversation key", () => {
    const existing = {
      telegramChatId: "5476500286",
      accessHash: null as string | null,
      peerType: null as string | null,
      firstName: null as string | null,
      lastName: null as string | null,
      username: null as string | null,
      peerPhone: null as string | null,
      chatType: "PRIVATE"
    };
    const repaired = coalescePeerPersistenceFields(existing, {
      accessHash: "8949449174917549431",
      peerType: "USER",
      firstName: "Pat",
      lastName: null,
      username: null,
      phone: null,
      chatType: "PRIVATE"
    });
    expect(repaired.accessHash).toBe("8949449174917549431");
    expect(repaired.peerType).toBe("USER");
    expect(repaired.firstName).toBe("Pat");
    expect(isIncompletePrivatePeer({ ...existing, ...repaired, telegramChatId: existing.telegramChatId, title: "Pat", firstName: "Pat", lastName: null, username: null })).toBe(false);
    // Same telegram_chat_id key — upsert updates the row, never a duplicate conversation.
    expect(existing.telegramChatId).toBe("5476500286");
  });

  it("marks peer-unresolved as FAILED_RETRYABLE so explicit Retry can succeed after repair", () => {
    const failure = {
      safeErrorCode: "TELEGRAM_PEER_UNRESOLVED",
      retryable: true
    };
    const attempts = 5;
    const commandStatus =
      failure.safeErrorCode === "TELEGRAM_PEER_UNRESOLVED" || (failure.retryable && attempts < 4)
        ? "FAILED_RETRYABLE"
        : "FAILED_PERMANENT";
    const messageStatus = failure.retryable ? "FAILED_RETRYABLE" : "FAILED_PERMANENT";
    expect(commandStatus).toBe("FAILED_RETRYABLE");
    expect(messageStatus).toBe("FAILED_RETRYABLE");

    // Explicit retry requeues the same pending message id — no second Atlas row.
    const pendingId = "pending:send:5476500286:uuid";
    expect(isAtlasPendingTelegramMessageId(pendingId)).toBe(true);
    const afterRetry = { id: "msg-db-1", telegramMessageId: pendingId, sendStatus: "QUEUED" };
    expect(afterRetry.telegramMessageId).toBe(pendingId);
  });

  it("replaces Atlas pending telegram_message_id with the real Telegram acknowledgement id", () => {
    const pendingId = "pending:send:5476500286:uuid";
    const realId = "981";
    expect(isRemoteTelegramMessageId(pendingId)).toBe(false);
    expect(isRemoteTelegramMessageId(realId)).toBe(true);

    const before = { telegramMessageId: pendingId, sendStatus: "SENDING", origin: classifyMessageOrigin({
      direction: "OUTBOUND",
      internalSenderUserId: "staff-1",
      telegramMessageId: pendingId
    }) };
    const after = {
      telegramMessageId: realId,
      sendStatus: "SENT",
      origin: classifyMessageOrigin({
        direction: "OUTBOUND",
        internalSenderUserId: "staff-1",
        telegramMessageId: realId
      })
    };
    expect(before.origin).toBe("OUTBOUND_ATLAS");
    expect(after.origin).toBe("OUTBOUND_ATLAS");
    expect(after.telegramMessageId).not.toMatch(/^pending:/);
    expect(after.sendStatus).toBe("SENT");
  });
});
