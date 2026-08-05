import { createClient, type RedisClientType } from "redis";
import {
  kvExpiration,
  kvListLimit,
  type KV,
  type KVGetOptions,
  type KVListOptions,
  type KVListResult,
  type KVSetOptions,
} from "@nosrv/core";

interface RedisListCursor {
  cursor: string;
  pending: string[];
}

function decodeListCursor(cursor?: string): RedisListCursor {
  if (cursor === undefined) return { cursor: "0", pending: [] };
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof value !== "object" ||
      value === null ||
      typeof value.cursor !== "string" ||
      !Array.isArray(value.pending) ||
      !value.pending.every((key: unknown) => typeof key === "string")
    ) {
      throw new Error();
    }
    return value as RedisListCursor;
  } catch {
    throw new TypeError("Invalid Redis KV cursor");
  }
}

function encodeListCursor(value: RedisListCursor): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export class RedisKV implements KV {
  private readonly client: RedisClientType;
  private readonly prefix: string;
  private connection?: Promise<unknown>;

  constructor(url: string, prefix: string, client?: RedisClientType) {
    if (!url && !client) throw new Error("Redis URL is required");
    this.client = client ?? createClient({ url });
    this.prefix = prefix;
  }

  private key(value: string): string {
    return `${this.prefix}${value}`;
  }

  private async ready(): Promise<void> {
    if (this.client.isReady) return;
    this.connection ??= this.client.connect();
    await this.connection;
  }

  async get(key: string, options?: KVGetOptions & { type?: "text" }): Promise<string | null>;
  async get(key: string, options: KVGetOptions & { type: "bytes" }): Promise<Uint8Array | null>;
  async get(key: string, options?: KVGetOptions): Promise<string | Uint8Array | null> {
    await this.ready();
    const value = await this.client.get(this.key(key));
    if (value === null) return null;
    const bytes = Uint8Array.from(Buffer.from(value, "base64"));
    return options?.type === "bytes" ? bytes : new TextDecoder().decode(bytes);
  }

  async set(key: string, value: string | Uint8Array, options?: KVSetOptions): Promise<void> {
    await this.ready();
    const expiration = kvExpiration(options);
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
    await this.client.set(this.key(key), Buffer.from(bytes).toString("base64"), {
      ...(expiration === undefined
        ? {}
        : { expiration: { type: "EXAT" as const, value: expiration } }),
    });
  }

  async delete(key: string): Promise<void> {
    await this.ready();
    await this.client.del(this.key(key));
  }

  async list(options: KVListOptions = {}): Promise<KVListResult> {
    await this.ready();
    const limit = kvListLimit(options);
    const prefix = options.prefix ?? "";
    const state = decodeListCursor(options.cursor);
    while (state.pending.length < limit) {
      const result = await this.client.scan(state.cursor, {
        MATCH: `${this.prefix}*`,
        COUNT: limit,
      });
      state.cursor = String(result.cursor);
      state.pending.push(
        ...result.keys
          .map((key) => key.slice(this.prefix.length))
          .filter((key) => key.startsWith(prefix)),
      );
      if (state.cursor === "0") break;
    }
    const names = state.pending.splice(0, limit);
    const keys = await Promise.all(
      names.map(async (key) => {
        const ttl = await this.client.pTTL(this.key(key));
        return {
          key,
          ...(ttl < 0 ? {} : { expiresAt: Math.floor((Date.now() + ttl) / 1000) }),
        };
      }),
    );
    const complete = state.cursor === "0" && state.pending.length === 0;
    return {
      keys,
      complete,
      ...(!complete ? { cursor: encodeListCursor(state) } : {}),
    };
  }

  async close(): Promise<void> {
    if (this.client.isOpen) await this.client.quit();
  }
}
