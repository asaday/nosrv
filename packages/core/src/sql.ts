import type {
  Database,
  DatabaseColumn,
  DatabaseExecuteResult,
  DatabaseIndexOptions,
  DatabaseRow,
  DatabaseSelectOptions,
  DatabaseSql,
  DatabaseTable,
  DatabaseTableOptions,
  DatabaseUpsertOptions,
  DatabaseValues,
  DatabaseWhere,
  SqlValue,
} from "@nosrv/core";

export type SqlDialect = "sqlite" | "postgres";

function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
    throw new Error(`Invalid database identifier: ${value}`);
  return `"${value}"`;
}

function columnType(column: DatabaseColumn, dialect: SqlDialect): string {
  if (column.type === "text") return "TEXT";
  if (column.type === "number") return dialect === "postgres" ? "DOUBLE PRECISION" : "REAL";
  if (column.type === "integer") return "INTEGER";
  if (column.type === "boolean") return dialect === "postgres" ? "BOOLEAN" : "INTEGER";
  if (column.type === "bytes") return dialect === "postgres" ? "BYTEA" : "BLOB";
  return dialect === "postgres" ? "TIMESTAMPTZ" : "TEXT";
}

function literal(value: SqlValue, dialect: SqlDialect): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "bigint") return String(value);
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  throw new Error(`Unsupported ${dialect} column default`);
}

function whereClause(where: DatabaseWhere | undefined): { sql: string; params: SqlValue[] } {
  const entries = Object.entries(where ?? {});
  if (!entries.length) return { sql: "", params: [] };
  const conditions: string[] = [];
  const params: SqlValue[] = [];
  const operators = { eq: "=", ne: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=" } as const;
  for (const [field, configured] of entries) {
    if (field === "$and" || field === "$or") {
      if (!Array.isArray(configured) || !configured.length)
        throw new Error(`Database where ${field} requires a non-empty array`);
      const nested = configured.map((condition) => whereClause(condition as DatabaseWhere));
      conditions.push(
        "(" +
          nested
            .map(({ sql }) => `(${sql.slice(" WHERE ".length)})`)
            .join(field === "$and" ? " AND " : " OR ") +
          ")",
      );
      for (const condition of nested) params.push(...condition.params);
      continue;
    }
    const column = identifier(field);
    const expression =
      configured !== null &&
      typeof configured === "object" &&
      !Array.isArray(configured) &&
      !(configured instanceof Uint8Array)
        ? configured
        : { eq: configured as SqlValue };
    const selected = Object.entries(expression);
    if (!selected.length) throw new Error("Database where operator must not be empty");
    for (const [operator, value] of selected) {
      if (operator === "in" || operator === "notIn") {
        if (!Array.isArray(value)) throw new Error("Database where in operator requires an array");
        if (!value.length) {
          conditions.push(operator === "in" ? "1 = 0" : "1 = 1");
          continue;
        }
        conditions.push(
          column +
            (operator === "notIn" ? " NOT" : "") +
            " IN (" +
            value.map(() => "?").join(", ") +
            ")",
        );
        params.push(...(value as SqlValue[]));
        continue;
      }
      if (!(operator in operators))
        throw new Error("Unsupported database where operator: " + operator);
      if (value === null && (operator === "eq" || operator === "ne")) {
        conditions.push(column + " IS " + (operator === "ne" ? "NOT " : "") + "NULL");
        continue;
      }
      conditions.push(column + " " + operators[operator as keyof typeof operators] + " ?");
      params.push(value as SqlValue);
    }
  }
  return { sql: " WHERE " + conditions.join(" AND "), params };
}

function writeValue(value: SqlValue, column: DatabaseColumn | undefined): SqlValue {
  if (column?.type === "timestamp" && typeof value !== "string")
    throw new TypeError("Portable timestamp values must be ISO 8601 strings");
  return value;
}

function readValue(value: unknown, column: DatabaseColumn | undefined): unknown {
  if (column?.type === "boolean") return Boolean(value);
  if (column?.type === "timestamp" && value instanceof Date) return value.toISOString();
  if (column?.type === "bytes" && value instanceof Uint8Array) return Uint8Array.from(value);
  return value;
}

export class PortableSqlDatabase implements Database {
  readonly sql: DatabaseSql;
  readonly #dialect: SqlDialect;
  readonly #tables: Map<string, DatabaseTable>;
  readonly #validateSchema: boolean;

  constructor(
    sql: DatabaseSql,
    dialect: SqlDialect,
    tables = new Map<string, DatabaseTable>(),
    validateSchema = true,
  ) {
    this.sql = sql;
    this.#dialect = dialect;
    this.#tables = tables;
    this.#validateSchema = validateSchema;
  }

  async currentTimestamp(): Promise<string> {
    const row = (
      await this.sql.query<{ value: string | Date }>("SELECT CURRENT_TIMESTAMP AS value")
    ).rows[0];
    if (!row?.value) throw new Error("Database did not return its current timestamp");
    if (row.value instanceof Date) return row.value.toISOString();
    const value = String(row.value);
    return new Date(
      /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? value : `${value.replace(" ", "T")}Z`,
    ).toISOString();
  }

  async ensureTable(
    name: string,
    columns: DatabaseTable,
    options: DatabaseTableOptions = {},
  ): Promise<void> {
    const entries = Object.entries(columns);
    if (!entries.length) throw new Error("Database table requires at least one column");
    const definitions = entries.map(([field, column]) => {
      if (column.generated === "identity") {
        if (column.type !== "integer" || !column.primaryKey)
          throw new Error("Generated identity columns must be integer primary keys");
        if (column.default !== undefined)
          throw new Error("Generated identity columns cannot have a default value");
      }
      const parts = [identifier(field), columnType(column, this.#dialect)];
      if (column.generated === "identity" && this.#dialect === "postgres")
        parts.push("GENERATED BY DEFAULT AS IDENTITY");
      if (column.primaryKey) parts.push("PRIMARY KEY");
      if (column.required || column.primaryKey) parts.push("NOT NULL");
      if (column.default !== undefined) {
        const defaultValue = column.default;
        parts.push(
          "DEFAULT",
          typeof defaultValue === "object" &&
            defaultValue !== null &&
            !(defaultValue instanceof Uint8Array) &&
            "expression" in defaultValue
            ? "CURRENT_TIMESTAMP"
            : literal(defaultValue as SqlValue, this.#dialect),
        );
      }
      if (column.references) {
        parts.push(
          "REFERENCES",
          identifier(column.references.table) + "(" + identifier(column.references.field) + ")",
        );
        if (column.references.onDelete)
          parts.push("ON DELETE", column.references.onDelete.toUpperCase());
      }
      return parts.join(" ");
    });
    const unique = (options.unique ?? []).map((fields) => {
      if (!fields.length) throw new Error("Database unique constraint requires a field");
      return "UNIQUE (" + fields.map(identifier).join(", ") + ")";
    });
    await this.sql.execute(
      "CREATE TABLE IF NOT EXISTS " +
        identifier(name) +
        " (" +
        [...definitions, ...unique].join(", ") +
        ")",
    );
    if (this.#validateSchema) await this.validateTable(name, columns, options);
    this.#tables.set(name, columns);
  }

  private async validateTable(
    name: string,
    columns: DatabaseTable,
    options: DatabaseTableOptions,
  ): Promise<void> {
    const actual =
      this.#dialect === "sqlite"
        ? (
            await this.sql.query<{
              name: string;
              type: string;
              notnull: number;
              pk: number;
            }>(`PRAGMA table_info(${identifier(name)})`)
          ).rows.map((column) => ({
            name: column.name,
            type: column.type.toUpperCase(),
            required: Boolean(column.notnull),
            primaryKey: Boolean(column.pk),
          }))
        : (
            await this.sql.query<{
              column_name: string;
              data_type: string;
              is_nullable: "YES" | "NO";
              is_identity: "YES" | "NO";
              primary_key: boolean;
            }>(
              `SELECT columns.column_name, columns.data_type, columns.is_nullable, columns.is_identity,
                      EXISTS (
                        SELECT 1
                          FROM information_schema.table_constraints constraints
                          JOIN information_schema.key_column_usage keys
                            ON keys.constraint_schema = constraints.constraint_schema
                           AND keys.constraint_name = constraints.constraint_name
                         WHERE constraints.table_schema = columns.table_schema
                           AND constraints.table_name = columns.table_name
                           AND constraints.constraint_type = 'PRIMARY KEY'
                           AND keys.column_name = columns.column_name
                      ) AS primary_key
                 FROM information_schema.columns columns
                WHERE columns.table_schema = current_schema()
                  AND columns.table_name = ?`,
              [name],
            )
          ).rows.map((column) => ({
            name: column.column_name,
            type: column.data_type.toUpperCase(),
            required: column.is_nullable === "NO",
            primaryKey: Boolean(column.primary_key),
          }));
    if (!actual.length) throw new Error(`Database table ${name} schema could not be inspected`);
    for (const [field, expected] of Object.entries(columns)) {
      const found = actual.find((column) => column.name === field);
      if (!found) throw new Error(`Database table ${name} is missing required column ${field}`);
      const expectedType = columnType(expected, this.#dialect).toUpperCase();
      const actualType =
        this.#dialect === "postgres" && found.type === "TIMESTAMP WITH TIME ZONE"
          ? "TIMESTAMPTZ"
          : found.type;
      if (actualType !== expectedType) {
        throw new Error(
          `Database table ${name} column ${field} has type ${actualType}; expected ${expectedType}`,
        );
      }
      if ((expected.required || expected.primaryKey) && !found.required)
        throw new Error(`Database table ${name} column ${field} must be required`);
      if (Boolean(expected.primaryKey) !== found.primaryKey)
        throw new Error(`Database table ${name} column ${field} primary-key definition differs`);
    }
    const expectedUnique = (options.unique ?? [])
      .map((fields) => [...fields])
      .sort((left, right) => left.join("\0").localeCompare(right.join("\0")));
    const actualUnique = await this.tableUniqueConstraints(name);
    if (
      actualUnique.length !== expectedUnique.length ||
      actualUnique.some(
        (fields, index) =>
          fields.length !== expectedUnique[index]?.length ||
          fields.some((field, fieldIndex) => field !== expectedUnique[index][fieldIndex]),
      )
    ) {
      throw new Error(`Database table ${name} unique-constraint definition differs`);
    }
  }

  private async tableUniqueConstraints(name: string): Promise<string[][]> {
    if (this.#dialect === "sqlite") {
      const indexes = (
        await this.sql.query<{ name: string; unique: number; origin: string }>(
          `PRAGMA index_list(${identifier(name)})`,
        )
      ).rows.filter((index) => Boolean(index.unique) && index.origin === "u");
      const constraints: string[][] = [];
      for (const index of indexes) {
        constraints.push(
          (
            await this.sql.query<{ seqno: number; name: string }>(
              `PRAGMA index_info(${identifier(index.name)})`,
            )
          ).rows
            .sort((left, right) => left.seqno - right.seqno)
            .map((field) => field.name),
        );
      }
      return constraints.sort((left, right) => left.join("\0").localeCompare(right.join("\0")));
    }
    const rows = (
      await this.sql.query<{ constraint_name: string; column_name: string; position: number }>(
        `SELECT constraints.constraint_name, keys.column_name,
                keys.ordinal_position AS position
           FROM information_schema.table_constraints constraints
           JOIN information_schema.key_column_usage keys
             ON keys.constraint_schema = constraints.constraint_schema
            AND keys.constraint_name = constraints.constraint_name
          WHERE constraints.table_schema = current_schema()
            AND constraints.table_name = ?
            AND constraints.constraint_type = 'UNIQUE'
          ORDER BY constraints.constraint_name, keys.ordinal_position`,
        [name],
      )
    ).rows;
    const grouped = new Map<string, string[]>();
    for (const row of rows) {
      const fields = grouped.get(row.constraint_name) ?? [];
      fields.push(row.column_name);
      grouped.set(row.constraint_name, fields);
    }
    return [...grouped.values()].sort((left, right) =>
      left.join("\0").localeCompare(right.join("\0")),
    );
  }

  async ensureIndex(name: string, table: string, options: DatabaseIndexOptions): Promise<void> {
    if (!options.fields.length) throw new Error("Database index requires at least one field");
    await this.sql.execute(
      `CREATE ${options.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${identifier(name)} ON ${identifier(table)} (${options.fields.map(identifier).join(", ")})`,
    );
    if (!this.#validateSchema) return;
    const actual =
      this.#dialect === "sqlite"
        ? await this.sqliteIndex(name, table)
        : await this.postgresIndex(name, table);
    if (!actual) throw new Error(`Database index ${name} schema could not be inspected`);
    if (
      actual.unique !== Boolean(options.unique) ||
      actual.fields.length !== options.fields.length ||
      actual.fields.some((field, index) => field !== options.fields[index])
    ) {
      throw new Error(`Database index ${name} definition differs from the requested definition`);
    }
  }

  private async sqliteIndex(
    name: string,
    table: string,
  ): Promise<{ fields: string[]; unique: boolean } | undefined> {
    const fields = (
      await this.sql.query<{ seqno: number; name: string }>(
        `PRAGMA index_info(${identifier(name)})`,
      )
    ).rows
      .sort((left, right) => left.seqno - right.seqno)
      .map((row) => row.name);
    if (!fields.length) return undefined;
    const listed = (
      await this.sql.query<{ name: string; unique: number }>(
        `PRAGMA index_list(${identifier(table)})`,
      )
    ).rows.find((row) => row.name === name);
    return { fields, unique: Boolean(listed?.unique) };
  }

  private async postgresIndex(
    name: string,
    table: string,
  ): Promise<{ fields: string[]; unique: boolean } | undefined> {
    const rows = (
      await this.sql.query<{ field_name: string; is_unique: boolean; position: number }>(
        `SELECT attribute.attname AS field_name, definition.indisunique AS is_unique,
                key.position AS position
           FROM pg_class source
           JOIN pg_namespace namespace ON namespace.oid = source.relnamespace
           JOIN pg_index definition ON definition.indrelid = source.oid
           JOIN pg_class index_class ON index_class.oid = definition.indexrelid
           JOIN LATERAL unnest(definition.indkey) WITH ORDINALITY AS key(attnum, position)
             ON true
           JOIN pg_attribute attribute
             ON attribute.attrelid = source.oid AND attribute.attnum = key.attnum
          WHERE namespace.nspname = current_schema()
            AND source.relname = ?
            AND index_class.relname = ?
          ORDER BY key.position`,
        [table, name],
      )
    ).rows;
    if (!rows.length) return undefined;
    return { fields: rows.map((row) => row.field_name), unique: Boolean(rows[0].is_unique) };
  }

  async insert(name: string, values: DatabaseValues): Promise<DatabaseExecuteResult> {
    const entries = Object.entries(values);
    const table = this.#tables.get(name);
    const identityField = Object.entries(table ?? {}).find(
      ([, column]) => column.generated === "identity",
    )?.[0];
    const statement = entries.length
      ? `INSERT INTO ${identifier(name)} (${entries.map(([field]) => identifier(field)).join(", ")}) VALUES (${entries.map(() => "?").join(", ")})`
      : `INSERT INTO ${identifier(name)} DEFAULT VALUES`;
    const params = entries.map(([field, value]) => writeValue(value, table?.[field]));

    if (this.#dialect === "postgres" && identityField) {
      const result = await this.sql.query(
        `${statement} RETURNING ${identifier(identityField)}`,
        params,
      );
      const lastInsertId = result.rows[0]?.[identityField];
      return {
        rowsAffected: result.rows.length,
        ...(typeof lastInsertId === "string" ||
        typeof lastInsertId === "number" ||
        typeof lastInsertId === "bigint"
          ? { lastInsertId }
          : {}),
      };
    }

    return await this.sql.execute(statement, params);
  }

  async insertMany(name: string, rows: readonly DatabaseValues[]): Promise<DatabaseExecuteResult> {
    if (!rows.length) return { rowsAffected: 0 };
    const fields = Object.keys(rows[0]);
    if (!fields.length) throw new Error("Database bulk insert requires at least one field");
    const fieldSet = new Set(fields);
    for (const row of rows) {
      const rowFields = Object.keys(row);
      if (rowFields.length !== fields.length || rowFields.some((field) => !fieldSet.has(field)))
        throw new Error("Database bulk insert rows must have the same fields");
    }
    const table = this.#tables.get(name);
    const batchSize = Math.max(1, Math.floor(500 / fields.length));
    let rowsAffected = 0;
    for (let offset = 0; offset < rows.length; offset += batchSize) {
      const batch = rows.slice(offset, offset + batchSize);
      const result = await this.sql.execute(
        `INSERT INTO ${identifier(name)} (${fields.map(identifier).join(", ")}) VALUES ${batch
          .map(() => `(${fields.map(() => "?").join(", ")})`)
          .join(", ")}`,
        batch.flatMap((row) => fields.map((field) => writeValue(row[field], table?.[field]))),
      );
      rowsAffected += result.rowsAffected;
    }
    return { rowsAffected };
  }

  async upsert(
    name: string,
    values: DatabaseValues,
    options: DatabaseUpsertOptions,
  ): Promise<DatabaseExecuteResult> {
    const entries = Object.entries(values);
    if (!entries.length) throw new Error("Database upsert requires at least one value");
    if (!options.conflict.length) throw new Error("Database upsert requires a conflict field");
    for (const field of [...options.conflict, ...options.update]) {
      identifier(field);
      if (!Object.hasOwn(values, field)) {
        throw new Error("Database upsert field is missing from values: " + field);
      }
    }
    const table = this.#tables.get(name);
    const columns = entries.map(([field]) => identifier(field)).join(", ");
    const placeholders = entries.map(() => "?").join(", ");
    const conflict = options.conflict.map(identifier).join(", ");
    const action = options.update.length
      ? "DO UPDATE SET " +
        options.update
          .map((field) => identifier(field) + " = excluded." + identifier(field))
          .join(", ")
      : "DO NOTHING";
    return await this.sql.execute(
      "INSERT INTO " +
        identifier(name) +
        " (" +
        columns +
        ") VALUES (" +
        placeholders +
        ") ON CONFLICT (" +
        conflict +
        ") " +
        action,
      entries.map(([field, value]) => writeValue(value, table?.[field])),
    );
  }

  async select<T extends DatabaseRow = DatabaseRow>(
    name: string,
    options: DatabaseSelectOptions = {},
  ): Promise<T[]> {
    if (options.fields !== undefined && !options.fields.length)
      throw new Error("Database select fields must not be empty");
    const fields = options.fields?.length ? options.fields.map(identifier).join(", ") : "*";
    const where = whereClause(options.where);
    const order = options.orderBy?.length
      ? ` ORDER BY ${options.orderBy.map(({ field, direction }) => `${identifier(field)} ${(direction ?? "asc").toUpperCase()}`).join(", ")}`
      : "";
    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 0))
      throw new Error("Database select limit must be a non-negative integer");
    if (options.offset !== undefined && (!Number.isInteger(options.offset) || options.offset < 0))
      throw new Error("Database select offset must be a non-negative integer");
    if (options.offset !== undefined && options.limit === undefined)
      throw new Error("Database select offset requires a limit");
    const limit = options.limit === undefined ? "" : " LIMIT ?";
    const offset = options.offset === undefined ? "" : " OFFSET ?";
    const result = await this.sql.query(
      `SELECT ${fields} FROM ${identifier(name)}${where.sql}${order}${limit}${offset}`,
      [
        ...where.params,
        ...(options.limit === undefined ? [] : [options.limit]),
        ...(options.offset === undefined ? [] : [options.offset]),
      ],
    );
    const table = this.#tables.get(name);
    return result.rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([field, value]) => [field, readValue(value, table?.[field])]),
      ),
    ) as T[];
  }

  async count(name: string, options: { where?: DatabaseWhere } = {}): Promise<number> {
    const where = whereClause(options.where);
    const row = (
      await this.sql.query<{ count: number | bigint | string }>(
        `SELECT COUNT(*) AS "count" FROM ${identifier(name)}${where.sql}`,
        where.params,
      )
    ).rows[0];
    const count = Number(row?.count);
    if (!Number.isSafeInteger(count) || count < 0)
      throw new RangeError("Database count is outside the safe integer range");
    return count;
  }

  async exists(name: string, options: { where?: DatabaseWhere } = {}): Promise<boolean> {
    const where = whereClause(options.where);
    return (
      (
        await this.sql.query(`SELECT 1 AS "exists" FROM ${identifier(name)}${where.sql} LIMIT ?`, [
          ...where.params,
          1,
        ])
      ).rows.length > 0
    );
  }

  async update(
    name: string,
    values: DatabaseValues,
    options: { where: DatabaseWhere },
  ): Promise<DatabaseExecuteResult> {
    const entries = Object.entries(values);
    if (!entries.length) throw new Error("Database update requires at least one value");
    const where = whereClause(options.where);
    if (!where.sql) throw new Error("Database update requires a where condition");
    const table = this.#tables.get(name);
    return await this.sql.execute(
      `UPDATE ${identifier(name)} SET ${entries.map(([field]) => `${identifier(field)} = ?`).join(", ")}${where.sql}`,
      [...entries.map(([field, value]) => writeValue(value, table?.[field])), ...where.params],
    );
  }

  async delete(name: string, options: { where: DatabaseWhere }): Promise<DatabaseExecuteResult> {
    const where = whereClause(options.where);
    if (!where.sql) throw new Error("Database delete requires a where condition");
    return await this.sql.execute("DELETE FROM " + identifier(name) + where.sql, where.params);
  }

  async transaction<T>(callback: (db: Database) => Promise<T>): Promise<T> {
    if (!this.sql.transaction) throw new Error("Database transactions are not supported");
    return await this.sql.transaction(async (sql) =>
      callback(new PortableSqlDatabase(sql, this.#dialect, this.#tables, this.#validateSchema)),
    );
  }
}
