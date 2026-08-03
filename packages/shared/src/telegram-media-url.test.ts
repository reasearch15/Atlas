import { describe, expect, it } from "vitest";
import {
  buildTelegramMessageMediaPath,
  isAtlasMediaProxyPath,
  isPrivateStorageMediaUrl
} from "./telegram-media-url";

describe("telegram media URL helpers", () => {
  const messageId = "11111111-1111-4111-8111-111111111111";

  it("builds same-origin media and thumbnail paths", () => {
    expect(buildTelegramMessageMediaPath(messageId, "media")).toBe(
      `/api/telegram/messages/${messageId}/media`
    );
    expect(buildTelegramMessageMediaPath(messageId, "thumbnail")).toBe(
      `/api/telegram/messages/${messageId}/thumbnail`
    );
  });

  it("detects private MinIO / localhost URLs that must never reach browsers", () => {
    expect(isPrivateStorageMediaUrl("http://127.0.0.1:9000/bucket/key")).toBe(true);
    expect(isPrivateStorageMediaUrl("http://localhost:9000/bucket/key")).toBe(true);
    expect(
      isPrivateStorageMediaUrl(
        "https://cdn.example/x?X-Amz-Credential=AKIA&X-Amz-Signature=abc"
      )
    ).toBe(true);
    expect(isPrivateStorageMediaUrl(`/api/telegram/messages/${messageId}/media`)).toBe(false);
  });

  it("recognizes Atlas media proxy paths", () => {
    expect(isAtlasMediaProxyPath(`/api/telegram/messages/${messageId}/media`)).toBe(true);
    expect(isAtlasMediaProxyPath(`/api/telegram/messages/${messageId}/thumbnail?access=abc`)).toBe(true);
    expect(isAtlasMediaProxyPath("http://127.0.0.1:9000/x")).toBe(false);
  });
});
