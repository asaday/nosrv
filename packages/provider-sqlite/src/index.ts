import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  kvExpiration,
  kvListLimit,
  type DatabaseRow,
  type DatabaseSql,
  type KV,
  type KVGetOptions,
  type KVListOptions,
  type KVListResult,
  type KVSetOptions,
  type SqlValue,
} from "@nosrv/core";
import { PortableSqlDatabase } from "@nosrv/provider-sql";

function sqliteValue(value: SqlValue): SQLInputValue {
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

export class SQLiteDatabase extends PortableSqlDatabase {
  readonly path: string;
  private readonly database: DatabaseSync;

  constructor(path = resolve(process.cwd(), ".nosrv/database.sqlite")) {
    const resolvedPath = path === ":memory:" ? path : resolve(path);
    if (resolvedPath !== ":memory:") mkdirSync(dirname(resolvedPath), { recursive: true });
    const database = new DatabaseSync(resolvedPath);
    database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    const transactionSql: DatabaseSql = {
      async query<T extends DatabaseRow = DatabaseRow>(
        sql: string,
        params: readonly SqlValue[] = [],
      ) {
        const rows = database.prepare(sql).all(...params.map(sqliteValue));
        return { rows: rows.map((row) => ({ ...row })) as T[] };
      },
      async execute(sql: string, params: readonly SqlValue[] = []) {
        const result = database.prepare(sql).run(...params.map(sqliteValue));
        return {
          rowsAffected: Number(result.changes),
          ...(result.lastInsertRowid === 0 ? {} : { lastInsertId: result.lastInsertRowid }),
        };
      },
    };
    const sql: DatabaseSql = {
      ...transactionSql,
      async transaction<T>(callback: (sql: DatabaseSql) => Promise<T>): Promise<T> {
        database.exec("BEGIN IMMEDIATE");
        try {
          const result = await callback(transactionSql);
          database.exec("COMMIT");
          return result;
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      },
    };
    super(sql, "sqlite");
    this.path = resolvedPath;
    this.database = database;
  }

  close(): void {
    this.database.close();
  }
}

export class SQLiteKV implements KV {
  readonly path: string;
  private readonly database: DatabaseSync;

  constructor(path = resolve(process.cwd(), ".nosrv/kv.sqlite")) {
    this.path = path === ":memory:" ? path : resolve(path);
    if (this.path !== ":memory:") mkdirSync(dirname(this.path), { recursive: true });
    this.database = new DatabaseSync(this.path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS nosrv_kv (
        key TEXT PRIMARY KEY,
        value BLOB NOT NULL,
        expires_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS nosrv_kv_expires_at
        ON nosrv_kv (expires_at) WHERE expires_at IS NOT NULL;
    `);
  }

  async get(key: string, options?: KVGetOptions & { type?: "text" }): Promise<string | null>;
  async get(key: string, options: KVGetOptions & { type: "bytes" }): Promise<Uint8Array | null>;
  async get(key: string, options?: KVGetOptions): Promise<string | Uint8Array | null> {
    const row = this.database
      .prepare("SELECT value, expires_at FROM nosrv_kv WHERE key = ?")
      .get(key) as { value: Uint8Array; expires_at: number | null } | undefined;
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= Date.now()) {
      this.database.prepare("DELETE FROM nosrv_kv WHERE key = ?").run(key);
      return null;
    }
    const value = Uint8Array.from(row.value);
    return options?.type === "bytes" ? value : new TextDecoder().decode(value);
  }

  async set(key: string, value: string | Uint8Array, options?: KVSetOptions): Promise<void> {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
    const expiration = kvExpiration(options);
    const expiresAt = expiration === undefined ? null : expiration * 1000;
    this.database
      .prepare(
        `
      INSERT INTO nosrv_kv (key, value, expires_at) VALUES (?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at
    `,
      )
      .run(key, bytes, expiresAt);
  }

  async delete(key: string): Promise<void> {
    this.database.prepare("DELETE FROM nosrv_kv WHERE key = ?").run(key);
  }

  async list(options: KVListOptions = {}): Promise<KVListResult> {
    const limit = kvListLimit(options);
    this.database
      .prepare("DELETE FROM nosrv_kv WHERE expires_at IS NOT NULL AND expires_at <= ?")
      .run(Date.now());
    const prefix = options.prefix ?? "";
    const rows = this.database
      .prepare(
        `SELECT key, expires_at FROM nosrv_kv
         WHERE key > ? AND substr(key, 1, length(?)) = ?
         ORDER BY key LIMIT ?`,
      )
      .all(options.cursor ?? "", prefix, prefix, limit + 1) as {
      key: string;
      expires_at: number | null;
    }[];
    const complete = rows.length <= limit;
    const selected = rows.slice(0, limit);
    return {
      keys: selected.map((row) => ({
        key: row.key,
        ...(row.expires_at === null ? {} : { expiresAt: Math.floor(row.expires_at / 1000) }),
      })),
      complete,
      ...(!complete && selected.length ? { cursor: selected.at(-1)!.key } : {}),
    };
  }

  close(): void {
    this.database.close();
  }
}
