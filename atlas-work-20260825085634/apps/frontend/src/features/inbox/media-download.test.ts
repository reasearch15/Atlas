import { describe, expect, it } from "vitest";
import { resolveInboxMediaFileName, withDownloadQuery } from "./media-download";

describe("media download helpers", () => {
  it("defaults photo downloads to photo.jpg", () => {
    expect(
      resolveInboxMediaFileName({
        contentType: "PHOTO",
        mediaType: "PHOTO",
        mimeType: "image/jpeg",
        fileName: null
      })
    ).toBe("photo.jpg");
    expect(
      resolveInboxMediaFileName({
        contentType: "PHOTO",
        fileName: "holiday.png"
      })
    ).toBe("holiday.png");
  });

  it("appends download=1 without dropping the access ticket", () => {
    const url = withDownloadQuery(
      "https://platform.atlast.work/api/telegram/messages/abc/media?access=ticket-token"
    );
    expect(url).toContain("access=ticket-token");
    expect(url).toContain("download=1");
  });
});
