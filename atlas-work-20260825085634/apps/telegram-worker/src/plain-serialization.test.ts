import { describe, expect, it } from "vitest";
import { assertPlainSerializable } from "./plain-serialization";

describe("Telegram serialization boundaries", () => {
  it("rejects the remaining GramJS connection/codec circular shape without printing it", () => {
    const connection: Record<string, unknown> = {};
    const codec = { _conn: connection };
    connection._codec = codec;

    expect(() => assertPlainSerializable(connection, "SUBMIT_PHONE_JOB_RESULT")).toThrow(
      /boundary=SUBMIT_PHONE_JOB_RESULT constructor=Object field=\$._codec._conn/
    );
  });

  it("rejects class instances such as GramJS SentCode before Redis or BullMQ boundaries", () => {
    class SentCode {
      public readonly phoneCodeHash = "hash";
      public readonly timeout = 60;
    }

    expect(() => assertPlainSerializable(new SentCode(), "TELEGRAM_SEND_CODE_RESPONSE")).toThrow(
      /constructor=SentCode/
    );
  });

  it("accepts normalized worker result DTOs", () => {
    const result = {
      ok: true,
      accountId: "22222222-2222-4222-8222-222222222222",
      authorizationState: "WAITING_FOR_CODE",
      occurredAt: new Date("2026-08-02T00:00:00.000Z").toISOString()
    };

    expect(() => assertPlainSerializable(result, "BULLMQ_COMMAND_RESULT")).not.toThrow();
    expect(JSON.stringify(result)).toContain("WAITING_FOR_CODE");
    expect(structuredClone(result)).toEqual(result);
  });

  it("accepts strict Redis auth-attempt DTOs with encrypted scalar fields only", () => {
    const stored = {
      version: 1,
      accountId: "22222222-2222-4222-8222-222222222222",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      developerAppId: "33333333-3333-4333-8333-333333333333",
      state: "WAITING_FOR_CODE",
      encryptedTemporarySession: "{\"iv\":\"a\",\"tag\":\"b\",\"ciphertext\":\"c\"}",
      encryptedPhoneCodeHash: "{\"iv\":\"d\",\"tag\":\"e\",\"ciphertext\":\"f\"}",
      encryptedPhoneNumber: "{\"iv\":\"g\",\"tag\":\"h\",\"ciphertext\":\"i\"}",
      targetDcId: 5,
      workerId: "worker-test",
      expiresAt: "2026-08-02T00:15:00.000Z",
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z"
    };

    expect(() => assertPlainSerializable(stored, "REDIS_AUTH_ATTEMPT")).not.toThrow();
    expect(JSON.stringify(stored)).not.toContain("phoneCodeHash");
    expect(structuredClone(stored)).toEqual(stored);
  });
});
