import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const algorithm = "aes-256-gcm";
const salt = Buffer.from("atlas.telegram.session.v1", "utf8");

export interface EncryptedSecret {
  readonly version: 1;
  readonly algorithm: "AES-256-GCM";
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

/**
 * Derives a fixed-length encryption key from the configured master key.
 */
function deriveKey(masterKey: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(masterKey, "utf8"), salt, Buffer.from("telegram-session", "utf8"), 32));
}

/**
 * Encrypts sensitive Telegram session material with authenticated encryption.
 */
export function encryptSecret(plaintext: string, masterKey: string): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv(algorithm, deriveKey(masterKey), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: 1,
    algorithm: "AES-256-GCM",
    iv: iv.toString("base64url"),
    tag: tag.toString("base64url"),
    ciphertext: ciphertext.toString("base64url")
  };
}

/**
 * Decrypts encrypted Telegram session material and rejects tampered payloads.
 */
export function decryptSecret(envelope: EncryptedSecret, masterKey: string): string {
  const decipher = createDecipheriv(algorithm, deriveKey(masterKey), Buffer.from(envelope.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
    decipher.final()
  ]).toString("utf8");
}
