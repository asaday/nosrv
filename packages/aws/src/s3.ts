import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type {
  ObjectStorage,
  StorageBody,
  StorageListOptions,
  StorageListResult,
  StorageMetadata,
  StorageObject,
  StoragePutOptions,
  StoragePutResult,
} from "@nosrv/core";

async function uploadBody(body: StorageBody): Promise<string | Uint8Array> {
  if (typeof body === "string" || body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

export class S3ObjectStorage implements ObjectStorage {
  private readonly bucket: string;
  private readonly client: S3Client;
  private readonly prefix: string;

  constructor(
    bucket: string,
    client: S3Client = new S3Client({
      ...(process.env.AWS_ENDPOINT_URL ? { endpoint: process.env.AWS_ENDPOINT_URL } : {}),
      ...(process.env.AWS_S3_FORCE_PATH_STYLE === "true" ? { forcePathStyle: true } : {}),
    }),
    prefix = "",
  ) {
    this.bucket = bucket;
    this.client = client;
    this.prefix = prefix;
  }

  private key(key: string): string {
    return `${this.prefix}${key}`;
  }

  async get(key: string): Promise<StorageObject | null> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.key(key) }),
      );
      if (!result.Body) return null;
      return {
        body: result.Body.transformToWebStream(),
        metadata: {
          key,
          size: result.ContentLength ?? 0,
          ...(result.ETag ? { etag: result.ETag } : {}),
          ...(result.ContentType ? { contentType: result.ContentType } : {}),
          ...(result.LastModified ? { lastModified: result.LastModified } : {}),
          ...(result.Metadata ? { custom: result.Metadata } : {}),
        },
      };
    } catch (error) {
      if (error instanceof NoSuchKey || error instanceof NotFound) return null;
      throw error;
    }
  }

  async put(
    key: string,
    body: StorageBody,
    options: StoragePutOptions = {},
  ): Promise<StoragePutResult> {
    const result = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(key),
        Body: await uploadBody(body),
        ContentType: options.contentType,
        Metadata: options.customMetadata,
      }),
    );
    return { key, ...(result.ETag ? { etag: result.ETag } : {}) };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(key) }));
  }

  async head(key: string): Promise<StorageMetadata | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(key) }),
      );
      return {
        key,
        size: result.ContentLength ?? 0,
        ...(result.ETag ? { etag: result.ETag } : {}),
        ...(result.ContentType ? { contentType: result.ContentType } : {}),
        ...(result.LastModified ? { lastModified: result.LastModified } : {}),
        ...(result.Metadata ? { custom: result.Metadata } : {}),
      };
    } catch (error) {
      if (
        error instanceof NotFound ||
        (typeof error === "object" &&
          error !== null &&
          "$metadata" in error &&
          error.$metadata &&
          typeof error.$metadata === "object" &&
          "httpStatusCode" in error.$metadata &&
          error.$metadata.httpStatusCode === 404)
      )
        return null;
      throw error;
    }
  }

  async list(options: StorageListOptions = {}): Promise<StorageListResult> {
    const result = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: this.key(options.prefix ?? ""),
        ContinuationToken: options.cursor,
        MaxKeys: options.limit,
      }),
    );
    return {
      objects: (result.Contents ?? []).flatMap((object) =>
        object.Key?.startsWith(this.prefix)
          ? [
              {
                key: object.Key.slice(this.prefix.length),
                size: object.Size ?? 0,
                ...(object.ETag ? { etag: object.ETag } : {}),
                ...(object.LastModified ? { lastModified: object.LastModified } : {}),
              },
            ]
          : [],
      ),
      truncated: result.IsTruncated ?? false,
      ...(result.NextContinuationToken ? { cursor: result.NextContinuationToken } : {}),
    };
  }
}
