import { Pool, type PoolClient, type PoolConfig } from "pg";
import type {
  DatabaseExecuteResult,
  DatabaseQueryResult,
  DatabaseRow,
  DatabaseSql,
  SqlValue,
} from "@nosrv/core";
import { PortableSqlDatabase } from "@nosrv/provider-sql";

export function postgresSchemaName(appId: string): string {
  return `nosrv_${appId.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}

function postgresValue(value: SqlValue): unknown {
  if (value instanceof Uint8Array) return Buffer.from(value);
  return value;
}

/** Converts nosrv's portable `?` parameters without touching quoted SQL text. */
export function postgresParameters(sql: string): string {
  let result = "";
  let parameter = 0;
  let index = 0;
  let quote: "'" | '"' | null = null;
  let dollarQuote: string | null = null;
  let lineComment = false;
  let blockComment = false;

  while (index < sql.length) {
    if (lineComment) {
      const character = sql[index++];
      result += character;
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (sql.startsWith("*/", index)) {
        result += "*/";
        index += 2;
        blockComment = false;
      } else result += sql[index++];
      continue;
    }
    if (dollarQuote) {
      if (sql.startsWith(dollarQuote, index)) {
        result += dollarQuote;
        index += dollarQuote.length;
        dollarQuote = null;
      } else result += sql[index++];
      continue;
    }
    if (quote) {
      const character = sql[index++];
      result += character;
      if (character === quote) {
        if (sql[index] === quote) result += sql[index++];
        else quote = null;
      }
      continue;
    }
    if (sql.startsWith("--", index)) {
      result += "--";
      index += 2;
      lineComment = true;
      continue;
    }
    if (sql.startsWith("/*", index)) {
      result += "/*";
      index += 2;
      blockComment = true;
      continue;
    }
    const dollar = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(index))?.[0];
    if (dollar) {
      result += dollar;
      index += dollar.length;
      dollarQuote = dollar;
      continue;
    }
    const character = sql[index++];
    if (character === "'" || character === '"') {
      quote = character;
      result += character;
      continue;
    }
    result += character === "?" ? `$${++parameter}` : character;
  }
  return result;
}

class PostgresSql implements DatabaseSql {
  readonly schema: string;
  private readonly pool: Pool;
  private initialized?: Promise<void>;

  constructor(connectionString: string, appId: string, pool?: Pool) {
    if (!connectionString && !pool) throw new Error("PostgreSQL connection URL is required");
    this.schema = postgresSchemaName(appId);
    const config: PoolConfig = connectionString ? { connectionString } : {};
    this.pool = pool ?? new Pool(config);
  }

  private async initialize(): Promise<void> {
    this.initialized ??= this.pool
      .query(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`)
      .then(() => undefined);
    await this.initialized;
  }

  private async client(): Promise<PoolClient> {
    await this.initialize();
    const client = await this.pool.connect();
    await client.query(`SET search_path TO "${this.schema}"`);
    return client;
  }

  async query<T extends DatabaseRow = DatabaseRow>(
    sql: string,
    params: readonly SqlValue[] = [],
  ): Promise<DatabaseQueryResult<T>> {
    const client = await this.client();
    try {
      const result = await client.query(postgresParameters(sql), params.map(postgresValue));
      return { rows: result.rows as T[] };
    } finally {
      client.release();
    }
  }

  async execute(sql: string, params: readonly SqlValue[] = []): Promise<DatabaseExecuteResult> {
    const client = await this.client();
    try {
      const result = await client.query(postgresParameters(sql), params.map(postgresValue));
      return { rowsAffected: result.rowCount ?? 0 };
    } finally {
      client.release();
    }
  }

  async transaction<T>(callback: (sql: DatabaseSql) => Promise<T>): Promise<T> {
    const client = await this.client();
    const transactionSql: DatabaseSql = {
      async query<R extends DatabaseRow = DatabaseRow>(
        sql: string,
        params: readonly SqlValue[] = [],
      ): Promise<DatabaseQueryResult<R>> {
        const result = await client.query(postgresParameters(sql), params.map(postgresValue));
        return { rows: result.rows as R[] };
      },
      async execute(sql: string, params: readonly SqlValue[] = []): Promise<DatabaseExecuteResult> {
        const result = await client.query(postgresParameters(sql), params.map(postgresValue));
        return { rowsAffected: result.rowCount ?? 0 };
      },
    };
    try {
      await client.query("BEGIN");
      const result = await callback(transactionSql);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export class PostgresDatabase extends PortableSqlDatabase {
  readonly schema: string;
  readonly #postgres: PostgresSql;

  constructor(connectionString: string, appId: string, pool?: Pool) {
    const postgres = new PostgresSql(connectionString, appId, pool);
    super(postgres, "postgres");
    this.schema = postgres.schema;
    this.#postgres = postgres;
  }

  async close(): Promise<void> {
    await this.#postgres.close();
  }
}
