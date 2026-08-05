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

export interface R2ObjectLike {
  key: string;
  size: number;
  etag: string;
  uploaded: Date;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

export interface R2ObjectBodyLike extends R2ObjectLike {
  body: ReadableStream<Uint8Array>;
}

export interface R2BucketLike {
  get(key: string): Promise<R2ObjectBodyLike | null>;
  put(
    key: string,
    value: StorageBody,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<R2ObjectLike>;
  delete(key: string): Promise<void>;
  head(key: string): Promise<R2ObjectLike | null>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    objects: R2ObjectLike[];
    truncated: boolean;
    cursor?: string;
  }>;
}

function metadata(object: R2ObjectLike): StorageMetadata {
  return {
    key: object.key,
    size: object.size,
    etag: object.etag,
    lastModified: object.uploaded,
    ...(object.httpMetadata?.contentType ? { contentType: object.httpMetadata.contentType } : {}),
    ...(object.customMetadata ? { custom: { ...object.customMetadata } } : {}),
  };
}

async function uploadBody(body: StorageBody): Promise<string | Uint8Array | ArrayBuffer> {
  if (!(body instanceof ReadableStream)) return body;
  return new Uint8Array(await new Response(body).arrayBuffer());
}

export class R2ObjectStorage implements ObjectStorage {
  private readonly bucket: R2BucketLike;

  constructor(bucket: R2BucketLike) {
    this.bucket = bucket;
  }

  async get(key: string): Promise<StorageObject | null> {
    const object = await this.bucket.get(key);
    return object ? { body: object.body, metadata: metadata(object) } : null;
  }

  async put(
    key: string,
    body: StorageBody,
    options: StoragePutOptions = {},
  ): Promise<StoragePutResult> {
    const object = await this.bucket.put(key, await uploadBody(body), {
      ...(options.contentType ? { httpMetadata: { contentType: options.contentType } } : {}),
      ...(options.customMetadata ? { customMetadata: options.customMetadata } : {}),
    });
    return { key: object.key, etag: object.etag };
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  async head(key: string): Promise<StorageMetadata | null> {
    const object = await this.bucket.head(key);
    return object ? metadata(object) : null;
  }

  async list(options: StorageListOptions = {}): Promise<StorageListResult> {
    const result = await this.bucket.list(options);
    return {
      objects: result.objects.map(metadata),
      truncated: result.truncated,
      ...(result.cursor ? { cursor: result.cursor } : {}),
    };
  }
}
