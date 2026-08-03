import { describe, expect, it } from "vitest";
import { buildMessageTombstoneFields, isSoftDeletedTelegramMessage } from "./telegram-message-deletion";

describe("telegram message deletion helpers", () => {
  it("marks soft-deleted rows and builds audit-safe tombstones", () => {
    expect(isSoftDeletedTelegramMessage({ deletedAt: new Date() })).toBe(true);
    expect(isSoftDeletedTelegramMessage({ isDeleted: true })).toBe(true);
    expect(isSoftDeletedTelegramMessage({ deletedAt: null })).toBe(false);

    const tombstone = buildMessageTombstoneFields({
      deletedAt: new Date("2026-08-03T00:00:00.000Z"),
      deletionScope: "ATLAS_ONLY",
      originalContentType: "VOICE"
    });
    expect(tombstone.mediaMetadataJson).toMatchObject({
      tombstone: true,
      deletionScope: "ATLAS_ONLY",
      originalContentType: "VOICE"
    });
    expect(tombstone.textContent).toBe("");
  });
});
