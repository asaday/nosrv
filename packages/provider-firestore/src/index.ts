import { Firestore } from "@google-cloud/firestore";
import {
  kvExpiration,
  kvListLimit,
  type KV,
  type KVGetOptions,
  type KVListOptions,
  type KVListResult,
  type KVSetOptions,
} from "@nosrv/core";

interface KVDocument {
  value: string;
  expiresAt?: number;
}

function documentId(key: string): string {
  return Buffer.from(key).toString("base64url");
}

export class FirestoreKV implements KV {
  private readonly collection: string;
  private readonly firestore: Firestore;

  constructor(collection: string, firestore: Firestore = new Firestore()) {
    this.collection = collection;
    this.firestore = firestore;
  }

  async get(key: string, options?: KVGetOptions & { type?: "text" }): Promise<string | null>;
  async get(key: string, options: KVGetOptions & { type: "bytes" }): Promise<Uint8Array | null>;
  async get(key: string, options?: KVGetOptions): Promise<string | Uint8Array | null> {
    const document = await this.firestore.collection(this.collection).doc(documentId(key)).get();
    if (!document.exists) return null;
    const data = document.data() as KVDocument;
    if (data.expiresAt !== undefined && data.expiresAt <= Date.now()) return null;
    const bytes = Uint8Array.from(Buffer.from(data.value, "base64"));
    return options?.type === "bytes" ? bytes : new TextDecoder().decode(bytes);
  }

  async set(key: string, value: string | Uint8Array, options?: KVSetOptions): Promise<void> {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
    const expiration = kvExpiration(options);
    await this.firestore
      .collection(this.collection)
      .doc(documentId(key))
      .set({
        key,
        value: Buffer.from(bytes).toString("base64"),
        ...(expiration === undefined ? {} : { expiresAt: expiration * 1000 }),
      });
  }

  async delete(key: string): Promise<void> {
    await this.firestore.collection(this.collection).doc(documentId(key)).delete();
  }

  async list(options: KVListOptions = {}): Promise<KVListResult> {
    const limit = kvListLimit(options);
    let query = this.firestore.collection(this.collection).orderBy("key");
    if (options.prefix !== undefined && options.prefix !== "") {
      query = query.where("key", ">=", options.prefix).where("key", "<", `${options.prefix}\uf8ff`);
    }
    if (options.cursor !== undefined) query = query.startAfter(options.cursor);
    const snapshot = await query.limit(limit + 1).get();
    const documents = snapshot.docs.slice(0, limit);
    const now = Date.now();
    const keys = documents.flatMap((document) => {
      const data = document.data() as KVDocument & { key?: string };
      return !data.key || (data.expiresAt !== undefined && data.expiresAt <= now)
        ? []
        : [
            {
              key: data.key,
              ...(data.expiresAt === undefined
                ? {}
                : { expiresAt: Math.floor(data.expiresAt / 1000) }),
            },
          ];
    });
    const complete = snapshot.docs.length <= limit;
    return {
      keys,
      complete,
      ...(!complete && documents.length
        ? { cursor: (documents.at(-1)!.data() as KVDocument & { key: string }).key }
        : {}),
    };
  }
}
