import { describe, expect, it } from "vitest";
import { resolveContactIdentity, identityFromChatAndContact } from "./contact-identity";
import { tokenizeRichText } from "./rich-message-text";

describe("contact identity", () => {
  it("prefers usable telegram title over unknown crm placeholder", () => {
    const identity = resolveContactIdentity({
      contactDisplayName: "Unknown",
      title: "Facebook accounts for sale",
      username: "sellbuyaccountsfb",
      firstName: null,
      lastName: null,
      telegramChatId: "123",
      chatType: "PRIVATE"
    });
    expect(identity.displayName).toBe("Facebook accounts for sale");
    expect(identity.username).toBe("sellbuyaccountsfb");
    expect(identity.subtitle).toBe("@sellbuyaccountsfb");
  });

  it("prefers saved CRM contact name when present", () => {
    const identity = identityFromChatAndContact(
      {
        title: "Telegram Title",
        firstName: "A",
        lastName: "B",
        username: "user",
        telegramChatId: "1",
        chatType: "PRIVATE",
        isBot: false
      },
      {
        displayName: "VIP Buyer",
        username: "vip",
        phoneMasked: null,
        lastSeenAt: new Date().toISOString()
      }
    );
    expect(identity.displayName).toBe("VIP Buyer");
    expect(identity.presenceLabel).toBe("Online");
  });
  it("hides username and phone when direct contact is not allowed", () => {
    const identity = resolveContactIdentity({
      title: "Ada Lovelace",
      username: "ada",
      phone: "+15551234567",
      telegramChatId: "99",
      chatType: "PRIVATE",
      allowDirectContact: false
    });
    expect(identity.displayName).toBe("Ada Lovelace");
    expect(identity.username).toBeNull();
    expect(identity.phone).toBeNull();
    expect(identity.privacyNotice).toBeTruthy();
    expect(identity.subtitle).not.toMatch(/ada|1555/i);
  });
});

describe("rich message text", () => {
  it("tokenizes urls, mentions, hashtags, emails, and phones", () => {
    const tokens = tokenizeRichText("See https://t.me/atlas and @sellbuyaccountsfb #vip mail a@b.co +1 (555) 123-4567");
    const links = tokens.filter((token) => token.type === "link").map((token) => token.value);
    expect(links).toEqual(
      expect.arrayContaining(["https://t.me/atlas", "@sellbuyaccountsfb", "#vip", "a@b.co", "+1 (555) 123-4567"])
    );
  });

  it("keeps external contact matches as plain text when links are disabled", () => {
    const tokens = tokenizeRichText("Call +1 (555) 123-4567 or @secretuser via https://t.me/secret", {
      allowExternalContactLinks: false
    });
    expect(tokens.every((token) => token.type === "text" || token.value.startsWith("#"))).toBe(true);
    expect(tokens.some((token) => token.type === "link" && token.value.includes("t.me"))).toBe(false);
  });
});
