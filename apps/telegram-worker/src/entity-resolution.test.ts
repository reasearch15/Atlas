import { describe, expect, it } from "vitest";
import {
  accessHashAsString,
  extractPeerFields,
  isPeerEntityResolutionError,
  normalizePeerType,
  invalidateDialogEntities,
  resolveInputPeer,
  seedDialogEntities,
  TelegramPeerUnresolvedError
} from "./entity-resolution";

describe("entity resolution helpers", () => {
  it("maps chat types to peer types and marked ids", () => {
    expect(normalizePeerType(null, "PRIVATE")).toBe("USER");
    expect(normalizePeerType(null, "GROUP")).toBe("CHAT");
    expect(normalizePeerType(null, "SUPERGROUP")).toBe("CHANNEL");
    expect(normalizePeerType(null, null, "-100123")).toBe("CHANNEL");
    expect(normalizePeerType(null, null, "-456")).toBe("CHAT");
    expect(normalizePeerType(null, null, "7818896100")).toBe("USER");
  });

  it("extracts accessHash and names from GramJS user entities", () => {
    const fields = extractPeerFields(
      {
        className: "User",
        id: "7818896100",
        accessHash: "998877665544",
        username: "alice",
        phone: "15551212",
        firstName: "Alice",
        lastName: "Smith"
      },
      "7818896100"
    );
    expect(fields).toMatchObject({
      accessHash: "998877665544",
      peerType: "USER",
      username: "alice",
      phone: "15551212",
      firstName: "Alice",
      lastName: "Smith"
    });
  });

  it("keeps large access hashes as strings without Number precision loss", () => {
    expect(accessHashAsString("8949449174917549431")).toBe("8949449174917549431");
    expect(accessHashAsString(BigInt("8949449174917549431"))).toBe("8949449174917549431");
  });

  it("exposes a stable unresolved error code for user-facing failures", () => {
    const error = new TelegramPeerUnresolvedError();
    expect(error.code).toBe("TELEGRAM_PEER_UNRESOLVED");
    expect(error.message.toLowerCase()).toContain("access hash");
    expect(isPeerEntityResolutionError(error)).toBe(true);
    expect(
      isPeerEntityResolutionError(
        new Error('Could not find the input entity for {"userId":"7818896100","className":"PeerUser"}')
      )
    ).toBe(true);
  });

  it("seeds dialog entities once and resolves subsequent peers without another GetDialogs", async () => {
    let getDialogsCalls = 0;
    const client = {
      getDialogs: async () => {
        getDialogsCalls += 1;
        return [
          {
            id: "111",
            entity: { className: "User", id: "111", accessHash: "999", firstName: "One" }
          },
          {
            id: "222",
            entity: { className: "User", id: "222", accessHash: "888", firstName: "Two" }
          }
        ];
      },
      getEntity: async () => {
        throw new Error("no entity");
      },
      invoke: async () => {
        throw new Error("no invoke");
      },
      session: {}
    };
    const runtime = {
      client,
      Api: {
        InputPeerUser: class {
          userId: unknown;
          accessHash: unknown;
          className = "InputPeerUser";
          constructor(input: { userId: unknown; accessHash: unknown }) {
            this.userId = input.userId;
            this.accessHash = input.accessHash;
          }
        },
        InputPeerChat: class {
          className = "InputPeerChat";
          constructor(_input: { chatId: unknown }) {}
        },
        InputPeerChannel: class {
          className = "InputPeerChannel";
          constructor(_input: { channelId: unknown; accessHash: unknown }) {}
        }
      },
      credentials: { apiId: 1, apiHash: "x" }
    };

    invalidateDialogEntities(runtime as never);
    const dialogs = await client.getDialogs();
    seedDialogEntities(runtime as never, dialogs);
    expect(getDialogsCalls).toBe(1);

    const first = await resolveInputPeer(runtime as never, { telegramChatId: "111", chatType: "PRIVATE" });
    const second = await resolveInputPeer(runtime as never, { telegramChatId: "222", chatType: "PRIVATE" });
    expect(first.accessHash).toBe("999");
    expect(second.accessHash).toBe("888");
    expect(getDialogsCalls).toBe(1);
  });
});
