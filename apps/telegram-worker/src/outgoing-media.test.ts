import { describe, expect, it } from "vitest";
import {
  resolveGramJsUploadFileName,
  resolveOutgoingMediaSendMode,
  TELEGRAM_PHOTO_MAX_BYTES
} from "./outgoing-media";

describe("outgoing media send mode", () => {
  it("sends jpeg/png/webp as photos by default", () => {
    expect(resolveOutgoingMediaSendMode({ contentType: "PHOTO", mimeType: "image/jpeg" })).toMatchObject({
      forceDocument: false,
      asPhoto: true
    });
    expect(resolveOutgoingMediaSendMode({ contentType: "PHOTO", mimeType: "image/png" }).asPhoto).toBe(true);
    expect(resolveOutgoingMediaSendMode({ contentType: "PHOTO", mimeType: "image/webp" }).asPhoto).toBe(true);
  });

  it("forces document when user requests send-as-file or photo is too large", () => {
    expect(
      resolveOutgoingMediaSendMode({ contentType: "PHOTO", mimeType: "image/png", forceDocument: true })
    ).toMatchObject({ forceDocument: true, asPhoto: false, reason: "user_force_document" });
    expect(
      resolveOutgoingMediaSendMode({
        contentType: "PHOTO",
        mimeType: "image/jpeg",
        fileSizeBytes: TELEGRAM_PHOTO_MAX_BYTES + 1
      })
    ).toMatchObject({ forceDocument: true, reason: "photo_too_large" });
  });

  it("treats gif as animation (not photo, not forced document)", () => {
    expect(
      resolveOutgoingMediaSendMode({ contentType: "ANIMATION", mimeType: "image/gif", fileName: "a.gif" })
    ).toMatchObject({ forceDocument: false, asPhoto: false, asAnimation: true });
  });

  it("keeps voice and video as non-document telegram media", () => {
    expect(resolveOutgoingMediaSendMode({ contentType: "VOICE", mimeType: "audio/ogg" })).toMatchObject({
      forceDocument: false,
      reason: "voice_note"
    });
    expect(resolveOutgoingMediaSendMode({ contentType: "VIDEO", mimeType: "video/mp4" })).toMatchObject({
      forceDocument: false,
      reason: "video"
    });
  });
});

describe("GramJS upload file names", () => {
  it("uses image extensions GramJS isImage() recognizes for photos", () => {
    expect(resolveGramJsUploadFileName({ fileName: "shot", mimeType: "image/jpeg", asPhoto: true })).toBe("shot.jpg");
    expect(resolveGramJsUploadFileName({ fileName: "shot.png", mimeType: "image/png", asPhoto: true })).toBe("shot.png");
    expect(resolveGramJsUploadFileName({ fileName: "shot.webp", mimeType: "image/webp", asPhoto: true })).toBe(
      "shot.jpg"
    );
  });

  it("keeps gif extension for animations and original name for forced documents", () => {
    expect(resolveGramJsUploadFileName({ fileName: "clip", mimeType: "image/gif", asAnimation: true })).toBe(
      "clip.gif"
    );
    expect(
      resolveGramJsUploadFileName({ fileName: "report.pdf", forceDocument: true, asPhoto: true })
    ).toBe("report.pdf");
  });
});
