import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "./session-encryption";

const key = "x".repeat(64);
const wrongKey = "y".repeat(64);

describe("Telegram session encryption", () => {
  it("round trips encrypted session material", () => {
    const encrypted = encryptSecret("session-secret", key);
    expect(decryptSecret(encrypted, key)).toBe("session-secret");
  });

  it("rejects modified ciphertext", () => {
    const encrypted = encryptSecret("session-secret", key);
    expect(() => decryptSecret({ ...encrypted, ciphertext: `${encrypted.ciphertext}a` }, key)).toThrow();
  });

  it("rejects wrong keys", () => {
    const encrypted = encryptSecret("session-secret", key);
    expect(() => decryptSecret(encrypted, wrongKey)).toThrow();
  });
});
