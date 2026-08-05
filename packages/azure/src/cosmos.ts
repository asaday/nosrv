import { CosmosClient, type Container } from "@azure/cosmos";
import {
  kvExpiration,
  kvListLimit,
  type KV,
  type KVGetOptions,
  type KVListOptions,
  type KVListResult,
  type KVSetOptions,
} from "@nosrv/core";

interface CosmosKVDocument {
  id: string;
  key: string;
  value: string;
  expiresAt?: number;
  ttl?: number;
}

function idForKey(key: string): string {
  return Buffer.from(key).toString("base64url") || "_";
}

function encodeValue(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return Buffer.from(bytes).toString("base64");
}

function decodeValue(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "base64"));
}

export class CosmosKV implements KV {
  private readonly container: Container;

  constructor(container: Container);
  constructor(connectionString: string, database: string, container: string);
  constructor(
    containerOrConnection: Container | string,
    database?: string,
    containerName?: string,
  ) {
    if (typeof containerOrConnection === "string") {
      if (!database || !containerName) {
        throw new TypeError("Cosmos DB database and container are required");
      }
      this.container = new CosmosClient(containerOrConnection)
        .database(database)
        .container(containerName);
    } else {
      this.container = containerOrConnection;
    }
  }

  async get(key: string, options?: KVGetOptions & { type?: "text" }): Promise<string | null>;
  async get(key: string, options: KVGetOptions & { type: "bytes" }): Promise<Uint8Array | null>;
  async get(key: string, options?: KVGetOptions): Promise<string | Uint8Array | null> {
    try {
      const { resource } = await this.container
        .item(idForKey(key), idForKey(key))
        .read<CosmosKVDocument>();
      if (
        !resource ||
        (resource.expiresAt !== undefined && resource.expiresAt <= Date.now() / 1000)
      ) {
        return null;
      }
      const value = decodeValue(resource.value);
      return options?.type === "bytes" ? value : new TextDecoder().decode(value);
    } catch (error) {
      if (this.#isNotFound(error)) return null;
      throw error;
    }
  }

  async set(key: string, value: string | Uint8Array, options?: KVSetOptions): Promise<void> {
    const expiration = kvExpiration(options);
    const id = idForKey(key);
    const now = Math.floor(Date.now() / 1000);
    await this.container.items.upsert<CosmosKVDocument>({
      id,
      key,
      value: encodeValue(value),
      ...(expiration === undefined
        ? {}
        : { expiresAt: expiration, ttl: Math.max(1, expiration - now) }),
    });
  }

  async delete(key: string): Promise<void> {
    try {
      await this.container.item(idForKey(key), idForKey(key)).delete();
    } catch (error) {
      if (!this.#isNotFound(error)) throw error;
    }
  }

  async list(options: KVListOptions = {}): Promise<KVListResult> {
    const limit = kvListLimit(options);
    const now = Math.floor(Date.now() / 1000);
    const filters = ["(NOT IS_DEFINED(c.expiresAt) OR c.expiresAt > @now)"];
    const parameters: Array<{ name: string; value: string | number }> = [
      { name: "@now", value: now },
    ];
    if (options.prefix !== undefined) {
      filters.push("STARTSWITH(c.key, @prefix)");
      parameters.push({ name: "@prefix", value: options.prefix });
    }
    const iterator = this.container.items.query<CosmosKVDocument>(
      {
        query: `SELECT c.key, c.expiresAt FROM c WHERE ${filters.join(" AND ")} ORDER BY c.key`,
        parameters,
      },
      {
        maxItemCount: limit,
        continuationToken: options.cursor,
        partitionKey: undefined,
      },
    );
    const result = await iterator.fetchNext();
    const cursor = result.continuationToken;
    return {
      keys: result.resources.map((item) => ({
        key: item.key,
        ...(item.expiresAt === undefined ? {} : { expiresAt: item.expiresAt }),
      })),
      complete: !cursor,
      ...(cursor ? { cursor } : {}),
    };
  }

  #isNotFound(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === 404 || error.code === "NotFound")
    );
  }
}
