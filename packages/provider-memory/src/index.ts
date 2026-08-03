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

function copyBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

async function bodyBytes(body: StorageBody): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return copyBytes(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
  return new Uint8Array(await new Response(body).arrayBuffer());
}

interface MemoryStorageEntry {
  bytes: Uint8Array;
  metadata: StorageMetadata;
}

export class MemoryObjectStorage implements ObjectStorage {
  readonly #entries = new Map<string, MemoryStorageEntry>();

  async get(key: string): Promise<StorageObject | null> {
    const entry = this.#entries.get(key);
    if (!entry) return null;
    const bytes = copyBytes(entry.bytes);
    return {
      body: new Blob([bytes.buffer]).stream(),
      metadata: {
        ...entry.metadata,
        custom: entry.metadata.custom ? { ...entry.metadata.custom } : undefined,
      },
    };
  }

  async put(
    key: string,
    body: StorageBody,
    options: StoragePutOptions = {},
  ): Promise<StoragePutResult> {
    const bytes = await bodyBytes(body);
    const etag = await this.#etag(bytes);
    const metadata: StorageMetadata = {
      key,
      size: bytes.byteLength,
      etag,
      lastModified: new Date(),
      ...(options.contentType ? { contentType: options.contentType } : {}),
      ...(options.customMetadata ? { custom: { ...options.customMetadata } } : {}),
    };
    this.#entries.set(key, { bytes: copyBytes(bytes), metadata });
    return { key, etag };
  }

  async delete(key: string): Promise<void> {
    this.#entries.delete(key);
  }

  async head(key: string): Promise<StorageMetadata | null> {
    const metadata = this.#entries.get(key)?.metadata;
    return metadata
      ? { ...metadata, custom: metadata.custom ? { ...metadata.custom } : undefined }
      : null;
  }

  async list(options: StorageListOptions = {}): Promise<StorageListResult> {
    const keys = [...this.#entries.keys()]
      .filter((key) => key.startsWith(options.prefix ?? ""))
      .sort();
    const cursorIndex = options.cursor ? keys.findIndex((key) => key > options.cursor!) : 0;
    const start = cursorIndex === -1 ? keys.length : cursorIndex;
    const limit = Math.max(1, options.limit ?? 1000);
    const selected = keys.slice(start, start + limit);
    const truncated = start + limit < keys.length;
    return {
      objects: selected.map((key) => ({ ...this.#entries.get(key)!.metadata })),
      truncated,
      ...(truncated && selected.length ? { cursor: selected.at(-1) } : {}),
    };
  }

  async #etag(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", bytes.buffer);
    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
}
