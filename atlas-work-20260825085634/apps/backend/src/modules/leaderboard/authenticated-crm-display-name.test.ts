import { describe, expect, it } from "vitest";
import {
  isUnknownPlaceholderDisplayName,
  resolveAuthenticatedCrmDisplayName,
  resolveAuthenticatedCrmDisplayNameFromContact
} from "./authenticated-crm-display-name";

describe("resolveAuthenticatedCrmDisplayName", () => {
  it("falls back from Unknown User to Telegram firstName", () => {
    expect(
      resolveAuthenticatedCrmDisplayName({
        displayName: "Unknown User",
        firstName: "Picasso",
        lastName: null,
        username: null
      })
    ).toBe("Picasso");
  });

  it("falls back from Unknown User to firstName + lastName", () => {
    expect(
      resolveAuthenticatedCrmDisplayName({
        displayName: "Unknown User",
        firstName: "Charles",
        lastName: "McBride",
        username: null
      })
    ).toBe("Charles McBride");
  });

  it("keeps usable CRM displayName including initials", () => {
    expect(
      resolveAuthenticatedCrmDisplayName({
        displayName: "A.",
        firstName: "Ignored",
        lastName: "Name",
        username: "someone"
      })
    ).toBe("A.");
  });

  it("uses username when no usable displayName or first/last", () => {
    expect(
      resolveAuthenticatedCrmDisplayName({
        displayName: "Unknown User",
        firstName: null,
        lastName: null,
        username: "Piccaso47"
      })
    ).toBe("Piccaso47");
    expect(
      resolveAuthenticatedCrmDisplayName({
        displayName: "Unknown Bot",
        firstName: "  ",
        lastName: null,
        username: "@Piccaso47"
      })
    ).toBe("Piccaso47");
  });

  it("returns Unknown when no usable identity exists", () => {
    expect(
      resolveAuthenticatedCrmDisplayName({
        displayName: "Unknown User",
        firstName: null,
        lastName: null,
        username: null
      })
    ).toBe("Unknown");
    expect(
      resolveAuthenticatedCrmDisplayName({
        displayName: null,
        firstName: null,
        lastName: null,
        username: null,
        allowUsername: false
      })
    ).toBe("Unknown");
  });

  it("skips username when allowUsername is false", () => {
    expect(
      resolveAuthenticatedCrmDisplayName({
        displayName: "Unknown User",
        firstName: null,
        lastName: null,
        username: "hidden_user",
        allowUsername: false
      })
    ).toBe("Unknown");
  });

  it("rejects Unknown* placeholders via isUnknownPlaceholderDisplayName", () => {
    expect(isUnknownPlaceholderDisplayName("Unknown")).toBe(true);
    expect(isUnknownPlaceholderDisplayName("Unknown User")).toBe(true);
    expect(isUnknownPlaceholderDisplayName("Unknown Bot")).toBe(true);
    expect(isUnknownPlaceholderDisplayName("A.")).toBe(false);
    expect(isUnknownPlaceholderDisplayName("Picasso")).toBe(false);
  });
});

describe("resolveAuthenticatedCrmDisplayNameFromContact", () => {
  it("uses the same resolver for contact + chat shape (both referral sides)", () => {
    const referrer = resolveAuthenticatedCrmDisplayNameFromContact({
      displayName: "Unknown User",
      username: null,
      chats: [{ firstName: "Picasso", lastName: null, username: null }]
    });
    const referred = resolveAuthenticatedCrmDisplayNameFromContact({
      displayName: "Unknown User",
      username: null,
      chats: [{ firstName: "Charles", lastName: "McBride", username: null }]
    });
    expect(referrer).toBe("Picasso");
    expect(referred).toBe("Charles McBride");
  });

  it("prefers a chat with names over an earlier empty chat", () => {
    expect(
      resolveAuthenticatedCrmDisplayNameFromContact({
        displayName: "Unknown User",
        username: null,
        chats: [
          { firstName: null, lastName: null, username: "empty_chat" },
          { firstName: "L.", lastName: "J.", username: null }
        ]
      })
    ).toBe("L. J.");
  });
});
