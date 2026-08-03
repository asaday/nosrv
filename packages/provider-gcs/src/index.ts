import { Storage, type Bucket, type File, type FileMetadata } from "@google-cloud/storage";
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

function metadata(key: string, value: FileMetadata): StorageMetadata {
  const size = typeof value.size === "string" ? Number(value.size) : (value.size ?? 0);
  const custom = value.metadata
    ? Object.fromEntries(
        Object.entries(value.metadata).flatMap(([name, item]) =>
          typeof item === "string" ? [[name, item]] : [],
        ),
      )
    : undefined;
  return {
    key,
    size,
    ...(value.etag ? { etag: value.etag } : {}),
    ...(value.contentType ? { contentType: value.contentType } : {}),
    ...(value.updated ? { lastModified: new Date(value.updated) } : {}),
    ...(custom && Object.keys(custom).length ? { custom } : {}),
  };
}

async function bytes(body: StorageBody): Promise<Uint8Array> {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

export class GCSObjectStorage implements ObjectStorage {
  private readonly bucket: Bucket;
  private readonly prefix: string;

  constructor(bucketName: string, storage: Storage = new Storage(), prefix = "") {
    this.bucket = storage.bucket(bucketName);
    this.prefix = prefix;
  }

  private key(key: string): string {
    return `${this.prefix}${key}`;
  }

  async get(key: string): Promise<StorageObject | null> {
    const file = this.bucket.file(this.key(key));
    try {
      const [value] = await file.getMetadata();
      const nodeStream = file.createReadStream();
      const iterator = nodeStream[Symbol.asyncIterator]();
      return {
        body: new ReadableStream<Uint8Array>({
          async pull(controller) {
            const result = await iterator.next();
            if (result.done) controller.close();
            else controller.enqueue(Uint8Array.from(result.value));
          },
          cancel() {
            nodeStream.destroy();
          },
        }),
        metadata: metadata(key, value),
      };
    } catch (error) {
      if (this.#isNotFound(error)) return null;
      throw error;
    }
  }

  async put(
    key: string,
    body: StorageBody,
    options: StoragePutOptions = {},
  ): Promise<StoragePutResult> {
    const file = this.bucket.file(this.key(key));
    await file.save(Buffer.from(await bytes(body)), {
      contentType: options.contentType,
      metadata: options.customMetadata ? { metadata: options.customMetadata } : undefined,
    });
    const [value] = await file.getMetadata();
    return { key, ...(value.etag ? { etag: value.etag } : {}) };
  }

  async delete(key: string): Promise<void> {
    await this.bucket.file(this.key(key)).delete({ ignoreNotFound: true });
  }

  async head(key: string): Promise<StorageMetadata | null> {
    try {
      const [value] = await this.bucket.file(this.key(key)).getMetadata();
      return metadata(key, value);
    } catch (error) {
      if (this.#isNotFound(error)) return null;
      throw error;
    }
  }

  async list(options: StorageListOptions = {}): Promise<StorageListResult> {
    const [files, nextQuery] = await this.bucket.getFiles({
      prefix: this.key(options.prefix ?? ""),
      pageToken: options.cursor,
      maxResults: options.limit,
      autoPaginate: false,
    });
    const nextPageToken =
      "pageToken" in nextQuery && typeof nextQuery.pageToken === "string"
        ? nextQuery.pageToken
        : undefined;
    return {
      objects: files
        .filter((file: File) => file.name.startsWith(this.prefix))
        .map((file: File) => metadata(file.name.slice(this.prefix.length), file.metadata)),
      truncated: Boolean(nextPageToken),
      ...(nextPageToken ? { cursor: nextPageToken } : {}),
    };
  }

  #isNotFound(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === 404;
  }
}
