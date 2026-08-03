import type { DatabaseRow, SqlValue } from "@nosrv/core";
import { PortableSqlDatabase } from "@nosrv/provider-sql";

type D1Value = string | number | null | ArrayBuffer;

export interface D1ResultLike<T = unknown> {
  results?: T[];
  meta?: { changes?: number; last_row_id?: number };
}

export interface D1PreparedStatementLike {
  bind(...values: D1Value[]): D1PreparedStatementLike;
  all<T = unknown>(): Promise<D1ResultLike<T>>;
  run<T = unknown>(): Promise<D1ResultLike<T>>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
}

function d1Value(value: SqlValue): D1Value {
  if (typeof value === "bigint") {
    const number = Number(value);
    if (!Number.isSafeInteger(number))
      throw new RangeError("D1 cannot bind a bigint outside the safe integer range");
    return number;
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Uint8Array)
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  return value;
}

export class D1Database extends PortableSqlDatabase {
  constructor(database: D1DatabaseLike) {
    super(
      {
        async query<T extends DatabaseRow = DatabaseRow>(
          sql: string,
          params: readonly SqlValue[] = [],
        ) {
          const result = await database
            .prepare(sql)
            .bind(...params.map(d1Value))
            .all<T>();
          return { rows: result.results ?? [] };
        },
        async execute(sql: string, params: readonly SqlValue[] = []) {
          const result = await database
            .prepare(sql)
            .bind(...params.map(d1Value))
            .run();
          return {
            rowsAffected: result.meta?.changes ?? 0,
            ...(result.meta?.last_row_id === undefined
              ? {}
              : { lastInsertId: result.meta.last_row_id }),
          };
        },
      },
      "sqlite",
    );
  }
}
