import { PutObjectCommand, S3Client, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { WorkerEnv } from "./env";

export type MediaObjectStore = {
  readonly putObject: (input: {
    readonly key: string;
    readonly body: Buffer;
    readonly contentType: string;
  }) => Promise<void>;
  readonly getSignedGetUrl: (key: string, expiresInSeconds?: number) => Promise<string>;
  readonly objectExists: (key: string) => Promise<boolean>;
  readonly buildObjectKey: (input: {
    readonly workspaceId: string;
    readonly telegramAccountId: string;
    readonly telegramChatId: string;
    readonly telegramMessageId: string;
    readonly fileName: string;
  }) => string;
};

/**
 * Creates an S3-compatible object store for Telegram media bytes.
 */
export function createMediaObjectStore(env: WorkerEnv): MediaObjectStore {
  const client = new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY
    }
  });

  return {
    buildObjectKey(input) {
      const safeName = input.fileName.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "media.bin";
      return [
        "workspaces",
        input.workspaceId,
        "telegram",
        input.telegramAccountId,
        input.telegramChatId,
        input.telegramMessageId,
        safeName
      ].join("/");
    },
    async putObject(input) {
      await client.send(
        new PutObjectCommand({
          Bucket: env.S3_BUCKET,
          Key: input.key,
          Body: input.body,
          ContentType: input.contentType
        })
      );
    },
    async getSignedGetUrl(key, expiresInSeconds = 3600) {
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: env.S3_BUCKET,
          Key: key
        }),
        { expiresIn: expiresInSeconds }
      );
    },
    async objectExists(key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
        return true;
      } catch {
        return false;
      }
    }
  };
}
