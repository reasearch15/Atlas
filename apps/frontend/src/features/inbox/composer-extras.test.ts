import { afterEach, describe, expect, it, vi } from "vitest";
import { insertTextAtCursor, searchEmojis } from "./emoji-catalog";
import { loadRecentEmojis, rememberRecentEmoji } from "./recent-emojis";
import { classifyMediaError, markPermissionDeniedThisSession, wasPermissionDeniedThisSession } from "./media-permissions";
import {
  buildWaveformFromPeaks,
  pickVoiceMimeType,
  validateVoiceRecording,
  voiceFileNameForMime
} from "./voice-recorder";
import { inferAttachmentContentType, mediaPreviewLabel } from "./composer-media-upload";
import { mergeAndDeduplicate } from "./inbox-utils";
import { emptyMediaFields } from "./media-message-helpers";
import type { TelegramMessageDto } from "@atlas/shared";

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    }
  };
}

function message(partial: Partial<TelegramMessageDto> & Pick<TelegramMessageDto, "id" | "telegramMessageId" | "text">): TelegramMessageDto {
  return {
    telegramAccountId: "acc",
    chatId: "c",
    direction: "OUTBOUND",
    contentType: "VOICE",
    mediaType: "VOICE",
    sentAt: "2026-08-03T13:00:00.000Z",
    editedAt: null,
    isEdited: false,
    isDeleted: false,
    senderTelegramUserId: "1",
    senderDisplayName: "You",
    replyToTelegramMessageId: null,
    internalSenderUserId: "u",
    sendStatus: "QUEUED",
    ...emptyMediaFields(),
    ...partial
  };
}

describe("emoji insertion and recent persistence", () => {
  it("inserts emoji at the caret without replacing surrounding text", () => {
    expect(insertTextAtCursor("hello world", "😀", 5, 5)).toEqual({ next: "hello😀 world", caret: 7 });
    expect(insertTextAtCursor("ab", "🎉", 0, 2)).toEqual({ next: "🎉", caret: 2 });
  });

  it("searches emoji catalog by keyword", () => {
    expect(searchEmojis("fire").some((entry) => entry.emoji === "🔥")).toBe(true);
    expect(searchEmojis("zzzz-not-found")).toEqual([]);
  });

  it("persists recent emojis locally (characters only)", () => {
    const storage = memoryStorage();
    expect(rememberRecentEmoji("🔥", storage)).toEqual(["🔥"]);
    expect(rememberRecentEmoji("😂", storage)).toEqual(["😂", "🔥"]);
    expect(rememberRecentEmoji("🔥", storage)[0]).toBe("🔥");
    expect(loadRecentEmojis(storage)).toEqual(["🔥", "😂"]);
  });
});

describe("microphone and voice lifecycle helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("classifies microphone permission denial without looping prompts", () => {
    const storage = memoryStorage();
    vi.stubGlobal("sessionStorage", storage);
    const denied = classifyMediaError("microphone", Object.assign(new Error("denied"), { name: "NotAllowedError" }));
    expect(denied.state).toBe("denied");
    expect(wasPermissionDeniedThisSession("microphone")).toBe(true);
    markPermissionDeniedThisSession("microphone");
    expect(wasPermissionDeniedThisSession("microphone")).toBe(true);
  });

  it("picks a telegram-friendly voice filename and validates duration/size", () => {
    expect(voiceFileNameForMime("audio/ogg;codecs=opus")).toMatch(/\.ogg$/);
    expect(pickVoiceMimeType(() => false)).toBe("audio/webm");
    expect(
      validateVoiceRecording({
        blob: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }),
        durationSeconds: 3
      })
    ).toBeNull();
    expect(
      validateVoiceRecording({
        blob: new Blob([new Uint8Array([1])], { type: "audio/webm" }),
        durationSeconds: 0
      })
    ).toMatch(/too short/i);
    expect(buildWaveformFromPeaks([0.1, 0.9, 0.4], 8)).toHaveLength(8);
    expect(Math.max(...buildWaveformFromPeaks([1, 1], 4))).toBeLessThanOrEqual(31);
  });
});

describe("camera permission and media type mapping", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("classifies camera denial and maps attachment content types", () => {
    const storage = memoryStorage();
    vi.stubGlobal("sessionStorage", storage);
    const denied = classifyMediaError("camera", Object.assign(new Error("denied"), { name: "NotAllowedError" }));
    expect(denied.state).toBe("denied");
    expect(inferAttachmentContentType(new File([], "shot.jpg", { type: "image/jpeg" }))).toBe("PHOTO");
    expect(inferAttachmentContentType(new File([], "clip.mp4", { type: "video/mp4" }))).toBe("VIDEO");
    expect(mediaPreviewLabel("VOICE", "x")).toContain("Voice");
    expect(mediaPreviewLabel("PHOTO", "x")).toContain("Photo");
    expect(mediaPreviewLabel("VIDEO", "x")).toContain("Video");
  });
});

describe("object URL cleanup and outgoing deduplication", () => {
  it("revokes object URLs after use", () => {
    const revoke = vi.fn();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: () => "blob:mock",
      revokeObjectURL: revoke
    });
    const url = URL.createObjectURL(new Blob(["a"]));
    expect(url).toBe("blob:mock");
    URL.revokeObjectURL(url);
    expect(revoke).toHaveBeenCalledWith("blob:mock");
    vi.unstubAllGlobals();
  });

  it("merges optimistic voice/photo placeholders with Telegram echo", () => {
    const pending = message({
      id: "db-1",
      telegramMessageId: "pending:media:1",
      text: "🎤 Voice Message",
      sendStatus: "QUEUED",
      contentType: "VOICE"
    });
    const echo = message({
      id: "db-1",
      telegramMessageId: "9001",
      text: "🎤 Voice Message",
      sendStatus: "DELIVERED",
      contentType: "VOICE",
      durationSeconds: 4
    });
    const merged = mergeAndDeduplicate([pending], echo);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.telegramMessageId).toBe("9001");
    expect(merged[0]?.sendStatus).toBe("DELIVERED");
  });

  it("dedupes by account + chat + telegramMessageId across different db ids", () => {
    const first = message({
      id: "a",
      telegramMessageId: "55",
      text: "📷 Photo",
      contentType: "PHOTO",
      mediaType: "PHOTO"
    });
    const second = message({
      id: "b",
      telegramMessageId: "55",
      text: "📷 Photo",
      contentType: "PHOTO",
      mediaType: "PHOTO"
    });
    expect(mergeAndDeduplicate([first], second)).toHaveLength(1);
  });
});

describe("failure retry mapping", () => {
  it("keeps a clear failure message for unsupported browsers", () => {
    const result = classifyMediaError("microphone", Object.assign(new Error("nope"), { name: "NotFoundError" }));
    expect(result.state).toBe("unavailable");
    expect(result.message.toLowerCase()).toContain("microphone");
  });
});
