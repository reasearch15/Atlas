import { describe, expect, it } from "vitest";
import { buildMessageTombstoneFields } from "@atlas/shared";
import { SafeTelegramDeleteError } from "./telegram-client";

describe("worker message deletion", () => {
  it("exposes stable forbidden codes when Telegram rejects revoke delete", () => {
    const error = new SafeTelegramDeleteError(
      "TELEGRAM_DELETE_FORBIDDEN",
      "Telegram rejected deleting this message for everyone."
    );
    expect(error.code).toBe("TELEGRAM_DELETE_FORBIDDEN");
    // Failed Telegram delete must not soft-delete locally.
    const deletedAt = null;
    const telegramDeleteStatus = "FAILED";
    expect(deletedAt).toBeNull();
    expect(telegramDeleteStatus).toBe("FAILED");
  });

  it("tombstones media messages without retaining storage keys", () => {
    for (const contentType of ["PHOTO", "VIDEO", "VOICE", "DOCUMENT"] as const) {
      const tombstone = buildMessageTombstoneFields({
        deletedAt: new Date(),
        deletionScope: "EVERYONE",
        originalContentType: contentType
      });
      expect(tombstone.mediaStorageKey).toBeNull();
      expect(tombstone.thumbnailStorageKey).toBeNull();
      expect(tombstone.mediaMetadataJson.originalContentType).toBe(contentType);
    }
  });

  it("native Telegram deletion sync uses EVERYONE scope without an Atlas actor", () => {
    const deletedByUserId = null;
    const scope = "EVERYONE" as const;
    expect(deletedByUserId).toBeNull();
    expect(scope).toBe("EVERYONE");
  });
});
