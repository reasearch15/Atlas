import { describe, expect, it, vi } from "vitest";
import {
  createFakeLeaderboardTelegramClient,
  HttpLeaderboardTelegramClient,
  LeaderboardTelegramApiError,
  type FakeLeaderboardTelegramState
} from "./leaderboard-telegram.client";

describe("HttpLeaderboardTelegramClient media", () => {
  it("sendPhoto posts multipart with caption + URL keyboard", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            message_id: 99,
            date: 1,
            chat: { id: -1001, type: "channel", title: "Hub" },
            caption: "🔥 Competition is live. Keep climbing."
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    const client = new HttpLeaderboardTelegramClient(fetchImpl as unknown as typeof fetch);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const msg = await client.sendPhoto("secret-token", "-1001", png, {
      caption: "🔥 Competition is live. Keep climbing.",
      replyMarkup: {
        inline_keyboard: [[{ text: "🏆 My Rank", url: "https://t.me/atlas_lb_bot?start=rank" }]]
      }
    });
    expect(msg.messageId).toBe(99);
    expect(msg.caption).toContain("Competition is live");
    expect(String(calls[0]!.url)).toContain("/botsecret-token/sendPhoto");
    expect(calls[0]!.init.body).toBeInstanceOf(FormData);
    const form = calls[0]!.init.body as FormData;
    expect(form.get("chat_id")).toBe("-1001");
    expect(form.get("caption")).toBe("🔥 Competition is live. Keep climbing.");
    expect(String(form.get("reply_markup"))).toContain("https://t.me/atlas_lb_bot?start=rank");
    expect(form.get("photo")).toBeTruthy();
  });

  it("editMessageMedia posts multipart media attach", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            message_id: 42,
            date: 1,
            chat: { id: -1001, type: "channel" },
            caption: "cap"
          }
        }),
        { status: 200 }
      );
    });
    const client = new HttpLeaderboardTelegramClient(fetchImpl as unknown as typeof fetch);
    const result = await client.editMessageMedia("tok", "-1001", 42, Buffer.from("png-bytes"), {
      caption: "cap"
    });
    expect(result === true || (typeof result === "object" && result.messageId === 42)).toBe(true);
    const form = (fetchImpl.mock.calls[0]![1] as RequestInit).body as FormData;
    expect(form.get("message_id")).toBe("42");
    expect(String(form.get("media"))).toContain("attach://leaderboard.png");
    expect(form.get("leaderboard.png")).toBeTruthy();
  });

  it("maps Telegram API errors", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: photo must be a file" }),
        { status: 400 }
      );
    });
    const client = new HttpLeaderboardTelegramClient(fetchImpl as unknown as typeof fetch);
    await expect(client.sendPhoto("tok", "1", Buffer.from("x"))).rejects.toBeInstanceOf(
      LeaderboardTelegramApiError
    );
  });

  it("maps network errors", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const client = new HttpLeaderboardTelegramClient(fetchImpl as unknown as typeof fetch);
    await expect(client.sendPhoto("tok", "1", Buffer.from("x"))).rejects.toMatchObject({
      description: expect.stringContaining("network failure")
    });
  });
});

describe("FakeLeaderboardTelegramClient media", () => {
  it("supports URL buttons on sendPhoto and editMessageMedia", async () => {
    const state: FakeLeaderboardTelegramState = {
      bots: new Map([["tok", { id: 1, isBot: true, firstName: "Bot", username: "botname" }]]),
      chats: new Map([
        [
          -1001,
          {
            id: -1001,
            type: "channel",
            members: new Map([[1, "administrator"]]),
            messages: [{ messageId: 1, photo: true, photoBytes: 10, caption: "old" }],
            nextMessageId: 2
          }
        ]
      ])
    };
    const client = createFakeLeaderboardTelegramClient(state);
    const sent = await client.sendPhoto("tok", -1001, Buffer.from("abc"), {
      caption: "new",
      replyMarkup: { inline_keyboard: [[{ text: "🏆 My Rank", url: "https://t.me/botname?start=rank" }]] }
    });
    expect(sent.messageId).toBe(2);
    expect(state.chats.get(-1001)!.messages[1]!.replyMarkup?.inline_keyboard[0]?.[0]).toMatchObject({
      url: "https://t.me/botname?start=rank"
    });

    await client.editMessageMedia("tok", -1001, 1, Buffer.from("abcdef"), { caption: "edited" });
    expect(state.chats.get(-1001)!.messages[0]!.caption).toBe("edited");
    expect(state.chats.get(-1001)!.messages[0]!.photoBytes).toBe(6);
  });
});
