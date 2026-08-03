import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import fp from "fastify-plugin";
import type { Env } from "../config/env";
import { forbidden } from "../utils/errors";

export type StorageObjectStreamResult = {
  readonly body: Readable;
  readonly statusCode: 200 | 206;
  readonly contentType: string | null;
  readonly contentLength: number | null;
  readonly contentRange: string | null;
  readonly acceptRanges: string;
  readonly etag: string | null;
};

declare module "fastify" {
  interface FastifyInstance {
    storage: {
      client: S3Client;
      bucket: string;
      assertReady: () => Promise<void>;
      putObject: (input: { key: string; body: Buffer; contentType: string }) => Promise<void>;
      putObjectStream: (input: {
        key: string;
        body: Readable;
        contentType: string;
        contentLength: number;
      }) => Promise<void>;
      deleteObject: (key: string) => Promise<void>;
      listObjectKeys: (prefix: string) => Promise<string[]>;
      objectExists: (key: string) => Promise<boolean>;
      getObjectStream: (input: { key: string; range?: string | null }) => Promise<StorageObjectStreamResult>;
      getSignedGetUrl: (key: string, expiresInSeconds?: number) => Promise<string>;
      getSignedPutUrl: (key: string, contentType: string, expiresInSeconds?: number) => Promise<string>;
      buildWorkspaceMediaKey: (input: {
        workspaceId: string;
        telegramAccountId: string;
        telegramChatId: string;
        telegramMessageId: string;
        fileName: string;
      }) => string;
      assertWorkspaceKey: (workspaceId: string, key: string) => void;
    };
  }
}

/**
 * Registers an S3-compatible storage client for Telegram media workflows.
 */
export const storagePlugin = fp<{ env: Env }>(async (app, options) => {
  const client = new S3Client({
    endpoint: options.env.S3_ENDPOINT,
    region: options.env.S3_REGION,
    forcePathStyle: true,
    credentials: {
      accessKeyId: options.env.S3_ACCESS_KEY_ID,
      secretAccessKey: options.env.S3_SECRET_ACCESS_KEY
    }
  });

  app.decorate("storage", {
    client,
    bucket: options.env.S3_BUCKET,
    assertReady: async () => {
      await client.send(new HeadBucketCommand({ Bucket: options.env.S3_BUCKET }));
    },
    async putObject(input) {
      await client.send(
        new PutObjectCommand({
          Bucket: options.env.S3_BUCKET,
          Key: input.key,
          Body: input.body,
          ContentType: input.contentType
        })
      );
    },
    async putObjectStream(input) {
      await client.send(
        new PutObjectCommand({
          Bucket: options.env.S3_BUCKET,
          Key: input.key,
          Body: input.body,
          ContentType: input.contentType,
          ContentLength: input.contentLength
        })
      );
    },
    async deleteObject(key) {
      await client.send(new DeleteObjectCommand({ Bucket: options.env.S3_BUCKET, Key: key }));
    },
    async listObjectKeys(prefix) {
      const keys: string[] = [];
      let continuationToken: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: options.env.S3_BUCKET,
            Prefix: prefix,
            ContinuationToken: continuationToken
          })
        );
        for (const object of page.Contents ?? []) {
          if (object.Key) keys.push(object.Key);
        }
        continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (continuationToken);
      return keys;
    },
    async objectExists(key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: options.env.S3_BUCKET, Key: key }));
        return true;
      } catch {
        return false;
      }
    },
    async getObjectStream(input) {
      const response = await client.send(
        new GetObjectCommand({
          Bucket: options.env.S3_BUCKET,
          Key: input.key,
          ...(input.range ? { Range: input.range } : {})
        })
      );
      const body = response.Body;
      if (!body) {
        throw new Error("S3_OBJECT_BODY_EMPTY");
      }
      const nodeStream =
        typeof (body as { transformToWebStream?: unknown }).transformToWebStream === "function"
          ? Readable.fromWeb((body as { transformToWebStream: () => ReadableStream }).transformToWebStream() as never)
          : (body as Readable);

      const contentRange = response.ContentRange ?? null;
      const statusCode: 200 | 206 = contentRange ? 206 : 200;
      return {
        body: nodeStream,
        statusCode,
        contentType: response.ContentType ?? null,
        contentLength: typeof response.ContentLength === "number" ? response.ContentLength : null,
        contentRange,
        acceptRanges: "bytes",
        etag: response.ETag ?? null
      };
    },
    async getSignedGetUrl(key, expiresInSeconds = 3600) {
      return getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: options.env.S3_BUCKET, Key: key }),
        { expiresIn: expiresInSeconds }
      );
    },
    async getSignedPutUrl(key, contentType, expiresInSeconds = 900) {
      return getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: options.env.S3_BUCKET,
          Key: key,
          ContentType: contentType
        }),
        { expiresIn: expiresInSeconds }
      );
    },
    buildWorkspaceMediaKey(input) {
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
    assertWorkspaceKey(workspaceId, key) {
      const prefix = `workspaces/${workspaceId}/`;
      if (!key.startsWith(prefix) || key.includes("..")) {
        throw forbidden("Media key is outside workspace scope.");
      }
    }
  });
});
