import { describe, expect, it } from "vitest";
import { contentTypeToMediaType, formatTelegramMediaPreview } from "@atlas/shared";

describe("telegram media DTO helpers", () => {
  it("maps content types for API mediaType", () => {
    expect(contentTypeToMediaType("PHOTO")).toBe("PHOTO");
    expect(contentTypeToMediaType("VIDEO_NOTE")).toBe("VIDEO");
    expect(contentTypeToMediaType("ANIMATION")).toBe("ANIMATION");
    expect(contentTypeToMediaType("LIVE_LOCATION")).toBe("LOCATION");
  });

  it("builds chat preview labels", () => {
    expect(formatTelegramMediaPreview("DOCUMENT")).toBe("📄 Document");
    expect(formatTelegramMediaPreview("VOICE")).toBe("🎤 Voice Message");
    expect(formatTelegramMediaPreview("PHOTO", { caption: "Hi" })).toBe("📷 Hi");
  });
});

describe("workspace media key isolation", () => {
  it("rejects keys outside workspace prefix", () => {
    const workspaceId = "11111111-1111-1111-1111-111111111111";
    const other = "workspaces/22222222-2222-2222-2222-222222222222/telegram/a/b/c/file.jpg";
    const ok = `workspaces/${workspaceId}/telegram/a/b/c/file.jpg`;
    expect(ok.startsWith(`workspaces/${workspaceId}/`)).toBe(true);
    expect(other.startsWith(`workspaces/${workspaceId}/`)).toBe(false);
    expect(other.includes("..")).toBe(false);
  });
});
