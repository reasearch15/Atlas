import { describe, expect, it } from "vitest";
import {
  emptyMediaFields,
  formatDuration,
  formatFileSize,
  isMediaLoading,
  normalizeWaveform,
  readContactMeta,
  readLocationCoords,
  readPollMeta
} from "./media-message-helpers";

describe("media-message-helpers", () => {
  it("detects pending/downloading media", () => {
    expect(isMediaLoading({ mediaDownloadState: "PENDING" })).toBe(true);
    expect(isMediaLoading({ mediaDownloadState: "DOWNLOADING" })).toBe(true);
    expect(isMediaLoading({ mediaDownloadState: "STORED" })).toBe(false);
  });

  it("reads location and contact metadata", () => {
    expect(readLocationCoords({ lat: 27.7, long: 85.3 })).toEqual({ lat: 27.7, long: 85.3 });
    expect(readLocationCoords({ latitude: "1.5", longitude: "2.5" })).toEqual({ lat: 1.5, long: 2.5 });
    expect(readContactMeta({ firstName: "Ada", lastName: "Lovelace", phoneNumber: "+123" })).toEqual({
      name: "Ada Lovelace",
      phone: "+123"
    });
  });

  it("reads poll options and formats sizes/durations", () => {
    expect(readPollMeta({ question: "Lunch?", options: ["Pizza", { text: "Salad" }] })).toEqual({
      question: "Lunch?",
      options: ["Pizza", "Salad"]
    });
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatDuration(125)).toBe("2:05");
  });

  it("normalizes waveform bars and provides empty media fields", () => {
    expect(normalizeWaveform([0, 15, 31], 3)).toHaveLength(3);
    expect(emptyMediaFields().mediaDownloadState).toBe("NONE");
    expect(emptyMediaFields().webPreview).toBeNull();
  });
});
