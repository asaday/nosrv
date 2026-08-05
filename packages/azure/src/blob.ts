import { BlobServiceClient, type BlobItem, type ContainerClient } from "@azure/storage-blob";
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

interface AzureBlobMetadata {
  contentLength?: number;
  etag?: string;
  contentType?: string;
  lastModified?: Date;
  metadata?: Record<string, string>;
}

function metadata(key: string, value: AzureBlobMetadata): StorageMetadata {
  return {
    key,
    size: value.contentLength ?? 0,
    ...(value.etag ? { etag: value.etag } : {}),
    ...(value.contentType ? { contentType: value.contentType } : {}),
    ...(value.lastModified ? { lastModified: value.lastModified } : {}),
    ...(value.metadata && Object.keys(value.metadata).length ? { custom: value.metadata } : {}),
  };
}

async function bytes(body: StorageBody): Promise<Uint8Array> {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

function readable(body: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  const iterator = body[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const result = await iterator.next();
      if (result.done) controller.close();
      else controller.enqueue(Uint8Array.from(result.value as Uint8Array));
    },
    cancel() {
      if ("destroy" in body && typeof body.destroy === "function") body.destroy();
    },
  });
}

export interface AzureBlobObjectStorageOptions {
  prefix?: string;
}

export class AzureBlobObjectStorage implements ObjectStorage {
  private readonly container: ContainerClient;
  private readonly prefix: string;

  constructor(container: ContainerClient, options?: AzureBlobObjectStorageOptions);
  constructor(
    containerName: string,
    connectionString: string,
    options?: AzureBlobObjectStorageOptions,
  );
  constructor(
    containerOrName: ContainerClient | string,
    connectionStringOrOptions?: string | AzureBlobObjectStorageOptions,
    options: AzureBlobObjectStorageOptions = {},
  ) {
    if (typeof containerOrName === "string") {
      if (typeof connectionStringOrOptions !== "string") {
        throw new TypeError("Azure Blob Storage connection string is required");
      }
      this.container =
        BlobServiceClient.fromConnectionString(connectionStringOrOptions).getContainerClient(
          containerOrName,
        );
      this.prefix = options.prefix ?? "";
    } else {
      this.container = containerOrName;
      this.prefix =
        typeof connectionStringOrOptions === "object"
          ? (connectionStringOrOptions.prefix ?? "")
          : "";
    }
  }

  private key(key: string): string {
    return `${this.prefix}${key}`;
  }

  async get(key: string): Promise<StorageObject | null> {
    const blob = this.container.getBlobClient(this.key(key));
    try {
      const result = await blob.download();
      if (!result.readableStreamBody) return null;
      return {
        body: readable(result.readableStreamBody),
        metadata: metadata(key, result),
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
    const value = await bytes(body);
    const result = await this.container.getBlockBlobClient(this.key(key)).uploadData(value, {
      blobHTTPHeaders: options.contentType ? { blobContentType: options.contentType } : undefined,
      metadata: options.customMetadata,
    });
    return { key, ...(result.etag ? { etag: result.etag } : {}) };
  }

  async delete(key: string): Promise<void> {
    await this.container.getBlobClient(this.key(key)).deleteIfExists();
  }

  async head(key: string): Promise<StorageMetadata | null> {
    try {
      return metadata(key, await this.container.getBlobClient(this.key(key)).getProperties());
    } catch (error) {
      if (this.#isNotFound(error)) return null;
      throw error;
    }
  }

  async list(options: StorageListOptions = {}): Promise<StorageListResult> {
    const page = await this.container
      .listBlobsFlat({ prefix: this.key(options.prefix ?? "") })
      .byPage({ continuationToken: options.cursor, maxPageSize: options.limit })
      .next();
    const value = page.value;
    if (!value) return { objects: [], truncated: false };
    const cursor = value.continuationToken;
    return {
      objects: value.segment.blobItems
        .filter((blob: BlobItem) => blob.name.startsWith(this.prefix))
        .map((blob: BlobItem) =>
          metadata(blob.name.slice(this.prefix.length), {
            ...blob.properties,
            metadata: blob.metadata,
          }),
        ),
      truncated: Boolean(cursor),
      ...(cursor ? { cursor } : {}),
    };
  }

  #isNotFound(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      (("statusCode" in error && error.statusCode === 404) ||
        ("code" in error && error.code === "BlobNotFound"))
    );
  }
}
