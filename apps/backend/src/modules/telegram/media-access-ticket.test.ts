import { describe, expect, it } from "vitest";
import {
  signMediaAccessTicket,
  verifyMediaAccessTicket,
  withMediaAccessTicket
} from "./media-access-ticket";

describe("media access tickets", () => {
  const secret = "test-jwt-access-secret-for-media-tickets";
  const base = {
    messageId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    userId: "33333333-3333-4333-8333-333333333333",
    variant: "media" as const
  };

  it("signs and verifies a ticket", () => {
    const ticket = signMediaAccessTicket(secret, base);
    const verified = verifyMediaAccessTicket(secret, ticket);
    expect(verified).toMatchObject(base);
    expect(verified?.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("rejects tampered signatures and expired tickets", () => {
    const ticket = signMediaAccessTicket(secret, base);
    expect(verifyMediaAccessTicket(secret, `${ticket}x`)).toBeNull();
    expect(verifyMediaAccessTicket("other-secret", ticket)).toBeNull();
    const expired = signMediaAccessTicket(secret, { ...base, ttlSeconds: -10 });
    expect(verifyMediaAccessTicket(secret, expired)).toBeNull();
  });

  it("appends access query without exposing storage keys", () => {
    const path = `/api/telegram/messages/${base.messageId}/media`;
    const url = withMediaAccessTicket(path, "ticket.value");
    expect(url).toBe(`${path}?access=ticket.value`);
    expect(url).not.toContain("127.0.0.1");
    expect(url).not.toContain(":9000");
    expect(url).not.toContain("X-Amz-Signature");
  });
});
