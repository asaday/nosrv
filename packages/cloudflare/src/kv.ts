import {
  kvExpiration,
  kvListLimit,
  type KV,
  type KVGetOptions,
  type KVListOptions,
  type KVListResult,
  type KVSetOptions,
} from "@nosrv/core";

export interface WorkersKVNamespaceLike {
  get(key: string, type?: "text"): Promise<string | null>;
  get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
  put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView,
    options?: { expiration?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: { name: string; expiration?: number }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}

export class CloudflareKV implements KV {
  private readonly namespace: WorkersKVNamespaceLike;

  constructor(namespace: WorkersKVNamespaceLike) {
    this.namespace = namespace;
  }

  async get(key: string, options?: KVGetOptions & { type?: "text" }): Promise<string | null>;
  async get(key: string, options: KVGetOptions & { type: "bytes" }): Promise<Uint8Array | null>;
  async get(key: string, options?: KVGetOptions): Promise<string | Uint8Array | null> {
    if (options?.type === "bytes") {
      const value = await this.namespace.get(key, "arrayBuffer");
      return value ? new Uint8Array(value) : null;
    }
    return this.namespace.get(key, "text");
  }

  async set(key: string, value: string | Uint8Array, options?: KVSetOptions): Promise<void> {
    const expiration = kvExpiration(options);
    await this.namespace.put(key, value, {
      ...(expiration !== undefined ? { expiration } : {}),
    });
  }

  async delete(key: string): Promise<void> {
    await this.namespace.delete(key);
  }

  async list(options: KVListOptions = {}): Promise<KVListResult> {
    const result = await this.namespace.list({
      ...(options.prefix !== undefined ? { prefix: options.prefix } : {}),
      limit: kvListLimit(options),
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    });
    return {
      keys: result.keys.map(({ name, expiration }) => ({
        key: name,
        ...(expiration !== undefined ? { expiresAt: expiration } : {}),
      })),
      complete: result.list_complete,
      ...(!result.list_complete && result.cursor ? { cursor: result.cursor } : {}),
    };
  }
}
