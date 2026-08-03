import { createReadStream } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type {
  ObjectStorage,
  StorageBody,
  StorageListOptions,
  StorageListResult,
  StorageMetadata,
  StorageObject,
  StoragePutOptions,
  StoragePutResult,
  Resources,
} from "@nosrv/core";
import { isResourcePath } from "@nosrv/core";

export class FilesystemResources implements Resources {
  readonly #root: string;

  constructor(directory: string) {
    this.#root = resolve(directory);
  }

  async get(path: string): Promise<Blob | null> {
    if (!isResourcePath(path)) return null;
    try {
      return new Blob([await readFile(resolve(this.#root, path))]);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "EISDIR")
      ) {
        return null;
      }
      throw error;
    }
  }
}

interface StoredMetadata {
  key: string;
  size: number;
  etag: string;
  contentType?: string;
  lastModified: string;
  custom?: Record<string, string>;
}

function identifier(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function toMetadata(value: StoredMetadata): StorageMetadata {
  return { ...value, lastModified: new Date(value.lastModified) };
}

function fileWebStream(path: string): ReadableStream<Uint8Array> {
  const stream = createReadStream(path);
  const iterator = stream[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const result = await iterator.next();
      if (result.done) controller.close();
      else controller.enqueue(Uint8Array.from(result.value));
    },
    cancel() {
      stream.destroy();
    },
  });
}

export class FilesystemObjectStorage implements ObjectStorage {
  readonly #objects: string;
  readonly #metadata: string;

  constructor(directory: string) {
    const root = resolve(directory);
    this.#objects = resolve(root, "objects");
    this.#metadata = resolve(root, "metadata");
  }

  async get(key: string): Promise<StorageObject | null> {
    const metadata = await this.#readMetadata(key);
    if (!metadata) return null;
    return {
      body: fileWebStream(this.#objectPath(key)),
      metadata: toMetadata(metadata),
    };
  }

  async put(
    key: string,
    body: StorageBody,
    options: StoragePutOptions = {},
  ): Promise<StoragePutResult> {
    if (!key) throw new Error("Storage key must not be empty");
    await Promise.all([
      mkdir(this.#objects, { recursive: true }),
      mkdir(this.#metadata, { recursive: true }),
    ]);
    const objectPath = this.#objectPath(key);
    const temporaryPath = `${objectPath}.${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, "wx");
    const hash = createHash("sha256");
    let size = 0;

    try {
      if (typeof body === "string" || body instanceof Uint8Array || body instanceof ArrayBuffer) {
        const bytes =
          typeof body === "string"
            ? new TextEncoder().encode(body)
            : body instanceof ArrayBuffer
              ? new Uint8Array(body)
              : body;
        await handle.writeFile(bytes);
        hash.update(bytes);
        size = bytes.byteLength;
      } else {
        const reader = body.getReader();
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          await handle.write(result.value);
          hash.update(result.value);
          size += result.value.byteLength;
        }
      }
    } catch (error) {
      await handle.close();
      await rm(temporaryPath, { force: true });
      throw error;
    }

    await handle.close();
    await rename(temporaryPath, objectPath);
    const etag = hash.digest("hex");
    const metadata: StoredMetadata = {
      key,
      size,
      etag,
      lastModified: new Date().toISOString(),
      ...(options.contentType ? { contentType: options.contentType } : {}),
      ...(options.customMetadata ? { custom: { ...options.customMetadata } } : {}),
    };
    await writeFile(this.#metadataPath(key), `${JSON.stringify(metadata)}\n`, "utf8");
    return { key, etag };
  }

  async delete(key: string): Promise<void> {
    await Promise.all([
      rm(this.#objectPath(key), { force: true }),
      rm(this.#metadataPath(key), { force: true }),
    ]);
  }

  async head(key: string): Promise<StorageMetadata | null> {
    const metadata = await this.#readMetadata(key);
    return metadata ? toMetadata(metadata) : null;
  }

  async list(options: StorageListOptions = {}): Promise<StorageListResult> {
    let names: string[];
    try {
      names = await readdir(this.#metadata);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return { objects: [], truncated: false };
      }
      throw error;
    }
    const all = (
      await Promise.all(
        names
          .filter((name) => name.endsWith(".json"))
          .map(async (name) => {
            const value = JSON.parse(
              await readFile(resolve(this.#metadata, name), "utf8"),
            ) as StoredMetadata;
            return toMetadata(value);
          }),
      )
    )
      .filter(({ key }) => key.startsWith(options.prefix ?? ""))
      .sort((left, right) => left.key.localeCompare(right.key));
    const cursorIndex = options.cursor ? all.findIndex(({ key }) => key > options.cursor!) : 0;
    const start = cursorIndex === -1 ? all.length : cursorIndex;
    const limit = Math.max(1, options.limit ?? 1000);
    const objects = all.slice(start, start + limit);
    const truncated = start + limit < all.length;
    return {
      objects,
      truncated,
      ...(truncated && objects.length ? { cursor: objects.at(-1)!.key } : {}),
    };
  }

  #objectPath(key: string): string {
    return resolve(this.#objects, identifier(key));
  }

  #metadataPath(key: string): string {
    return resolve(this.#metadata, `${identifier(key)}.json`);
  }

  async #readMetadata(key: string): Promise<StoredMetadata | null> {
    try {
      const value = JSON.parse(await readFile(this.#metadataPath(key), "utf8")) as StoredMetadata;
      await stat(this.#objectPath(key));
      return value;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
        return null;
      throw error;
    }
  }
}
