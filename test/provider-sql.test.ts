import assert from "node:assert/strict";
import test from "node:test";
import type { DatabaseRow, DatabaseSql, SqlValue } from "@nosrv/core";
import { PortableSqlDatabase, type SqlDialect } from "@nosrv/provider-sql";

function recordingDatabase(dialect: SqlDialect, rows: DatabaseRow[] = []) {
  const calls: { sql: string; params: readonly SqlValue[] }[] = [];
  const sql: DatabaseSql = {
    async query<T extends DatabaseRow>(statement: string, params: readonly SqlValue[] = []) {
      calls.push({ sql: statement, params });
      if (statement === "SELECT CURRENT_TIMESTAMP AS value") {
        return {
          rows: [
            {
              value:
                dialect === "postgres"
                  ? new Date("2026-07-22T00:00:00.000Z")
                  : "2026-07-22 00:00:00",
            },
          ] as unknown as T[],
        };
      }
      if (
        statement.startsWith("PRAGMA table_info") ||
        statement.startsWith("PRAGMA index_") ||
        statement.includes("information_schema.columns") ||
        statement.includes("FROM information_schema.table_constraints constraints") ||
        statement.includes("FROM pg_class source")
      ) {
        return { rows: [] };
      }
      if (statement.startsWith('SELECT COUNT(*) AS "count"'))
        return { rows: [{ count: rows.length }] as unknown as T[] };
      if (statement.startsWith('SELECT 1 AS "exists"'))
        return { rows: (rows.length ? [{ exists: 1 }] : []) as unknown as T[] };
      return { rows: rows as T[] };
    },
    async execute(statement, params = []) {
      calls.push({ sql: statement, params });
      return { rowsAffected: 1 };
    },
  };
  sql.transaction = async (callback) => callback(sql);
  return { db: new PortableSqlDatabase(sql, dialect, undefined, false), calls };
}

for (const dialect of ["sqlite", "postgres"] as const) {
  test(`portable CRUD compiles for ${dialect}`, async () => {
    const rawRows = [
      {
        id: "todo-1",
        title: "hello",
        completed: dialect === "sqlite" ? 1 : true,
        created_at:
          dialect === "sqlite" ? "2026-07-22T00:00:00.000Z" : new Date("2026-07-22T00:00:00.000Z"),
      },
    ];
    const { db, calls } = recordingDatabase(dialect, rawRows);
    const databaseTime = await db.currentTimestamp();
    await db.ensureTable("todos", {
      id: { type: "text", primaryKey: true },
      title: { type: "text", required: true },
      completed: { type: "boolean", required: true, default: false },
      created_at: { type: "timestamp", required: true },
    });
    await db.insert("todos", {
      id: "todo-1",
      title: "hello",
      completed: false,
      created_at: "2026-07-22T00:00:00.000Z",
    });
    const selected = await db.select("todos", {
      fields: ["id", "completed", "created_at"],
      where: { completed: false },
      orderBy: [{ field: "created_at", direction: "desc" }],
      limit: 20,
    });
    await db.update("todos", { completed: true }, { where: { id: "todo-1" } });
    await db.delete("todos", { where: { id: "todo-1" } });
    await db.upsert(
      "todos",
      {
        id: "todo-1",
        title: "updated",
        completed: true,
        created_at: "2026-07-22T00:00:00.000Z",
      },
      { conflict: ["id"], update: ["title", "completed"] },
    );
    await db.transaction(async (tx) =>
      tx.update(
        "todos",
        { completed: true },
        { where: { id: "todo-1", created_at: { lte: "2026-07-22T00:00:00.000Z" } } },
      ),
    );

    assert.equal(databaseTime, "2026-07-22T00:00:00.000Z");
    assert.equal(selected[0].completed, true);
    assert.equal(selected[0].created_at, "2026-07-22T00:00:00.000Z");
    assert.equal(calls[0].sql, "SELECT CURRENT_TIMESTAMP AS value");
    assert.match(calls[1].sql, dialect === "postgres" ? /BOOLEAN.*TIMESTAMPTZ/ : /INTEGER.*TEXT/);

    const selectCall = calls.find((call) => call.sql.startsWith('SELECT "id", "completed"'))!;
    assert.equal(
      selectCall.sql,
      'SELECT "id", "completed", "created_at" FROM "todos" WHERE "completed" = ? ORDER BY "created_at" DESC LIMIT ?',
    );
    assert.deepEqual(selectCall.params, [false, 20]);
    assert.equal(
      calls.find((call) => call.sql.includes("ON CONFLICT"))!.sql,
      'INSERT INTO "todos" ("id", "title", "completed", "created_at") VALUES (?, ?, ?, ?) ON CONFLICT ("id") DO UPDATE SET "title" = excluded."title", "completed" = excluded."completed"',
    );
    assert.equal(
      calls.at(-1)!.sql,
      'UPDATE "todos" SET "completed" = ? WHERE "id" = ? AND "created_at" <= ?',
    );
  });
}

for (const dialect of ["sqlite", "postgres"] as const) {
  test(`portable CRUD generates identity columns for ${dialect}`, async () => {
    const { db, calls } = recordingDatabase(dialect, dialect === "postgres" ? [{ id: 42 }] : []);
    await db.ensureTable("items", {
      id: { type: "integer", primaryKey: true, generated: "identity" },
      name: { type: "text", required: true },
    });
    const inserted = await db.insert("items", { name: "hello" });
    await db.insert("items", {});

    assert.equal(
      calls[0].sql,
      dialect === "postgres"
        ? 'CREATE TABLE IF NOT EXISTS "items" ("id" INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY NOT NULL, "name" TEXT NOT NULL)'
        : 'CREATE TABLE IF NOT EXISTS "items" ("id" INTEGER PRIMARY KEY NOT NULL, "name" TEXT NOT NULL)',
    );
    assert.equal(
      calls.find((call) => call.sql.startsWith("INSERT INTO"))!.sql,
      dialect === "postgres"
        ? 'INSERT INTO "items" ("name") VALUES (?) RETURNING "id"'
        : 'INSERT INTO "items" ("name") VALUES (?)',
    );
    if (dialect === "postgres") assert.deepEqual(inserted, { rowsAffected: 1, lastInsertId: 42 });
    assert.equal(
      calls.filter((call) => call.sql.startsWith("INSERT INTO"))[1].sql,
      dialect === "postgres"
        ? 'INSERT INTO "items" DEFAULT VALUES RETURNING "id"'
        : 'INSERT INTO "items" DEFAULT VALUES',
    );
  });
}

test("portable CRUD validates generated identity columns", async () => {
  const { db } = recordingDatabase("sqlite");
  await assert.rejects(
    db.ensureTable("items", {
      id: { type: "number", primaryKey: true, generated: "identity" },
    }),
    /must be integer primary keys/,
  );
  await assert.rejects(
    db.ensureTable("items", {
      id: {
        type: "integer",
        primaryKey: true,
        generated: "identity",
        default: 1,
      },
    }),
    /cannot have a default value/,
  );
});

for (const dialect of ["sqlite", "postgres"] as const) {
  test(`portable CRUD compiles pagination, grouped filters, count, exists, indexes, and bulk inserts for ${dialect}`, async () => {
    const { db, calls } = recordingDatabase(dialect, [{ id: "one" }]);
    await db.ensureTable("items", {
      id: { type: "text", primaryKey: true },
      owner_id: { type: "text", required: true },
      status: { type: "text", required: true },
    });
    await db.ensureIndex("items_owner_status", "items", {
      fields: ["owner_id", "status"],
    });
    assert.equal(
      (
        await db.insertMany("items", [
          { id: "one", owner_id: "a", status: "open" },
          { id: "two", owner_id: "a", status: "held" },
        ])
      ).rowsAffected,
      1,
    );
    const where = {
      $and: [
        { owner_id: "a" },
        { $or: [{ status: "open" }, { status: { in: ["held", "closed"] } }] },
      ],
    } as const;
    await db.select("items", { where, orderBy: [{ field: "id" }], limit: 20, offset: 20 });
    assert.equal(await db.count("items", { where }), 1);
    assert.equal(await db.exists("items", { where }), true);

    assert.equal(
      calls.find((call) => call.sql.startsWith("CREATE INDEX"))!.sql,
      'CREATE INDEX IF NOT EXISTS "items_owner_status" ON "items" ("owner_id", "status")',
    );
    assert.equal(
      calls.find((call) => call.sql.includes("), ("))!.sql,
      'INSERT INTO "items" ("id", "owner_id", "status") VALUES (?, ?, ?), (?, ?, ?)',
    );
    const page = calls.find((call) => call.sql.startsWith('SELECT * FROM "items"'))!;
    assert.match(
      page.sql,
      /\(\("owner_id" = \?\) AND \(\(\("status" = \?\) OR \("status" IN \(\?, \?\)\)\)\)\)/,
    );
    assert.match(page.sql, /LIMIT \? OFFSET \?$/);
    assert.deepEqual(page.params, ["a", "open", "held", "closed", 20, 20]);
  });
}

test("portable CRUD rejects unsafe identifiers and unbounded mutations", async () => {
  const { db } = recordingDatabase("sqlite");
  await assert.rejects(
    db.ensureTable("todos; DROP TABLE users", { id: { type: "text" } }),
    /Invalid database identifier/,
  );
  await assert.rejects(
    db.update("todos", { title: "x" }, { where: {} }),
    /requires a where condition/,
  );
  await assert.rejects(
    db.select("todos", { fields: ["id; DROP TABLE users"] }),
    /Invalid database identifier/,
  );
  await assert.rejects(db.select("todos", { fields: [] }), /fields must not be empty/);
  await assert.rejects(db.delete("todos", { where: {} }), /requires a where condition/);
});
