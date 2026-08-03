import { describe, expect, it } from "vitest";
import {
  isPrivateMinioBrowserUrl,
  signMediaUploadTicket,
  verifyMediaUploadTicket
} from "./media-upload-ticket";

const secret = "upload-ticket-test-secret";
const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const chatId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const userId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const storageKey = `workspaces/${workspaceId}/telegram/acc/peer/upload:key/photo.jpg`;

describe("media upload ticket", () => {
  it("signs and verifies a ticket bound to workspace storage key", () => {
    const ticket = signMediaUploadTicket(secret, {
      chatId,
      workspaceId,
      userId,
      storageKey,
      mimeType: "image/jpeg",
      fileName: "photo.jpg",
      contentType: "PHOTO",
      fileSizeBytes: 496_000,
      ttlSeconds: 900
    });
    const payload = verifyMediaUploadTicket(secret, ticket);
    expect(payload).toMatchObject({
      chatId,
      workspaceId,
      userId,
      storageKey,
      mimeType: "image/jpeg",
      contentType: "PHOTO",
      fileSizeBytes: 496_000
    });
  });

  it("rejects expired or tampered tickets", () => {
    const ticket = signMediaUploadTicket(secret, {
      chatId,
      workspaceId,
      userId,
      storageKey,
      mimeType: "image/jpeg",
      fileName: "photo.jpg",
      contentType: "PHOTO",
      fileSizeBytes: 100,
      ttlSeconds: -10
    });
    expect(verifyMediaUploadTicket(secret, ticket)).toBeNull();
    expect(verifyMediaUploadTicket(secret, `${ticket}x`)).toBeNull();
  });

  it("rejects path traversal / cross-workspace storage keys", () => {
    const bad = signMediaUploadTicket(secret, {
      chatId,
      workspaceId,
      userId,
      storageKey: `workspaces/other-ws/telegram/x`,
      mimeType: "image/jpeg",
      fileName: "photo.jpg",
      contentType: "PHOTO",
      fileSizeBytes: 100
    });
    // Ticket signs the bad key, but verify enforces workspace prefix match.
    expect(verifyMediaUploadTicket(secret, bad)).toBeNull();
  });

  it("detects private MinIO browser URLs", () => {
    expect(isPrivateMinioBrowserUrl("http://127.0.0.1:9000/atlas/key?X-Amz-Algorithm=AWS4")).toBe(true);
    expect(isPrivateMinioBrowserUrl("http://localhost:9000/atlas/key")).toBe(true);
    expect(isPrivateMinioBrowserUrl("/api/telegram/chats/x/media/upload?upload=ticket")).toBe(false);
  });
});
