import { describe, expect, it } from "vitest";
import {
  contentTypeNeedsBinaryDownload,
  contentTypeToMediaType,
  formatTelegramMediaPreview,
  readDiceEmoji
} from "./telegram-media";

describe("telegram-media", () => {
  it("formats media previews with caption preference", () => {
    expect(formatTelegramMediaPreview("PHOTO")).toBe("📷 Photo");
    expect(formatTelegramMediaPreview("PHOTO", { caption: "Sunset" })).toBe("📷 Sunset");
    expect(formatTelegramMediaPreview("VOICE")).toBe("🎤 Voice Message");
    expect(formatTelegramMediaPreview("ANIMATION")).toBe("🎞 GIF");
    expect(formatTelegramMediaPreview("STICKER")).toBe("🖼 Sticker");
    expect(formatTelegramMediaPreview("POLL", { caption: "Lunch?" })).toBe("📊 Lunch?");
    expect(formatTelegramMediaPreview("DICE", { diceEmoji: "🎯" })).toBe("🎲 🎯");
    expect(formatTelegramMediaPreview("TEXT", { text: "hello" })).toBe("hello");
  });

  it("maps content types to download and mediaType flags", () => {
    expect(contentTypeNeedsBinaryDownload("PHOTO")).toBe(true);
    expect(contentTypeNeedsBinaryDownload("POLL")).toBe(false);
    expect(contentTypeToMediaType("VIDEO_NOTE")).toBe("VIDEO");
    expect(contentTypeToMediaType("LIVE_LOCATION")).toBe("LOCATION");
    expect(contentTypeToMediaType("ANIMATION")).toBe("ANIMATION");
  });

  it("reads dice emoji safely", () => {
    expect(readDiceEmoji({ emoji: "🎲" })).toBe("🎲");
    expect(readDiceEmoji(null)).toBeNull();
    expect(readDiceEmoji({ emoji: 1 })).toBeNull();
  });
});
