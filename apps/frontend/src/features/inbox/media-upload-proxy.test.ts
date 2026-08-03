import { describe, expect, it } from "vitest";
import { isBlockedPrivateUploadUrl, resolveComposerUploadUrl } from "./composer-media-upload";

describe("composer media upload URL safety", () => {
  it("blocks private MinIO upload targets", () => {
    expect(isBlockedPrivateUploadUrl("http://127.0.0.1:9000/atlas/key?X-Amz-Signature=abc")).toBe(true);
    expect(isBlockedPrivateUploadUrl("http://localhost:9000/atlas/key")).toBe(true);
    expect(isBlockedPrivateUploadUrl("/api/telegram/chats/chat-1/media/upload?upload=ticket")).toBe(false);
  });

  it("resolves same-origin relative upload URLs and rejects private hosts", () => {
    const resolved = resolveComposerUploadUrl("/api/telegram/chats/chat-1/media/upload?upload=ticket");
    expect(resolved).toContain("/api/telegram/chats/chat-1/media/upload");
    expect(resolved).not.toMatch(/127\.0\.0\.1|:9000|localhost:9000/);
    expect(() => resolveComposerUploadUrl("http://127.0.0.1:9000/atlas/key")).toThrow(/FAILED_UPLOAD/);
  });
});
