import { describe, expect, it } from "vitest";
import { normalizeGramJsMedia } from "./media-normalize";

describe("normalizeGramJsMedia", () => {
  it("normalizes plain text", () => {
    const result = normalizeGramJsMedia({ message: "hello", id: 1 });
    expect(result.contentType).toBe("TEXT");
    expect(result.text).toBe("hello");
    expect(result.needsBinaryDownload).toBe(false);
  });

  it("normalizes photo media", () => {
    const result = normalizeGramJsMedia({
      message: "Sunset",
      media: {
        className: "MessageMediaPhoto",
        photo: { id: "99", sizes: [{ w: 100, h: 50, size: 1234 }] }
      }
    });
    expect(result.contentType).toBe("PHOTO");
    expect(result.caption).toBe("Sunset");
    expect(result.needsBinaryDownload).toBe(true);
    expect(result.width).toBe(100);
    expect(result.previewText).toContain("Sunset");
  });

  it("normalizes voice documents", () => {
    const result = normalizeGramJsMedia({
      message: "",
      media: {
        className: "MessageMediaDocument",
        document: {
          mimeType: "audio/ogg",
          size: 2048,
          attributes: [{ className: "DocumentAttributeAudio", voice: true, duration: 12, waveform: [1, 2, 3] }]
        }
      }
    });
    expect(result.contentType).toBe("VOICE");
    expect(result.durationSeconds).toBe(12);
    expect(result.waveform).toEqual([1, 2, 3]);
  });

  it("normalizes stickers, polls, dice, location, contact", () => {
    expect(
      normalizeGramJsMedia({
        media: {
          className: "MessageMediaDocument",
          document: {
            mimeType: "image/webp",
            attributes: [{ className: "DocumentAttributeSticker", alt: "😀" }]
          }
        }
      }).contentType
    ).toBe("STICKER");

    expect(
      normalizeGramJsMedia({
        media: {
          className: "MessageMediaPoll",
          poll: { question: { text: "Lunch?" }, answers: [{ text: { text: "Yes" } }] }
        }
      }).previewText
    ).toContain("Lunch");

    expect(
      normalizeGramJsMedia({
        media: { className: "MessageMediaDice", emoticon: "🎯", value: 4 }
      }).mediaMetadata
    ).toMatchObject({ emoji: "🎯", value: 4 });

    expect(
      normalizeGramJsMedia({
        media: { className: "MessageMediaGeo", geo: { lat: 1.2, long: 3.4 } }
      }).contentType
    ).toBe("LOCATION");

    expect(
      normalizeGramJsMedia({
        media: {
          className: "MessageMediaContact",
          firstName: "Ada",
          lastName: "Lovelace",
          phoneNumber: "+15551212"
        }
      }).contentType
    ).toBe("CONTACT");
  });

  it("never returns circular media objects", () => {
    const result = normalizeGramJsMedia({
      message: "x",
      media: { className: "MessageMediaPhoto", photo: { id: "1", sizes: [] } }
    });
    expect(() => JSON.stringify(result)).not.toThrow();
  });
});
