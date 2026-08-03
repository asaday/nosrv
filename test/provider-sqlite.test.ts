import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { SQLiteDatabase, SQLiteKV } from "@nosrv/provider-sqlite";

test("SQLiteDatabase executes parameterized statements and returns rows", async () => {
  const db = new SQLiteDatabase(":memory:");
  try {
    await db.sql.execute(
      "CREATE TABLE messages (id INTEGER PRIMARY KEY, text TEXT, enabled INTEGER)",
    );
    const inserted = await db.sql.execute("INSERT INTO messages (text, enabled) VALUES (?, ?)", [
      "hello",
      true,
    ]);
    assert.equal(inserted.rowsAffected, 1);
    assert.equal(inserted.lastInsertId, 1);

    const result = await db.sql.query<{ id: number; text: string; enabled: number }>(
      "SELECT id, text, enabled FROM messages WHERE id = ?",
      [1],
    );
    assert.deepEqual(result.rows, [{ id: 1, text: "hello", enabled: 1 }]);
  } finally {
    db.close();
  }
});

test("SQLiteDatabase exposes a portable database timestamp", async () => {
  const db = new SQLiteDatabase(":memory:");
  try {
    assert.match(await db.currentTimestamp(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  } finally {
    db.close();
  }
});

test("SQLiteDatabase runs portable CRUD and normalizes booleans", async () => {
  const db = new SQLiteDatabase(":memory:");
  try {
    await db.ensureTable("todos", {
      id: { type: "text", primaryKey: true },
      title: { type: "text", required: true },
      completed: { type: "boolean", required: true, default: false },
      created_at: { type: "timestamp", required: true },
    });
    await db.insert("todos", {
      id: "one",
      title: "hello",
      completed: false,
      created_at: "2026-07-22T00:00:00.000Z",
    });
    assert.deepEqual(await db.select("todos", { where: { id: "one" } }), [
      {
        id: "one",
        title: "hello",
        completed: false,
        created_at: "2026-07-22T00:00:00.000Z",
      },
    ]);
    assert.deepEqual(
      await db.select("todos", { fields: ["id", "completed"], where: { id: "one" } }),
      [{ id: "one", completed: false }],
    );
    await assert.rejects(
      db.select("todos", { fields: ["missing_column"], limit: 0 }),
      /no such column/,
    );
    assert.equal(
      (await db.update("todos", { completed: true }, { where: { id: "one" } })).rowsAffected,
      1,
    );
    assert.equal((await db.select("todos", { where: { id: "one" } }))[0].completed, true);
    assert.equal((await db.delete("todos", { where: { id: "one" } })).rowsAffected, 1);
  } finally {
    db.close();
  }
});

test("SQLiteDatabase supports portable indexes, bulk writes, grouped filters, pagination, count, and exists", async () => {
  const db = new SQLiteDatabase(":memory:");
  try {
    const schema = {
      id: { type: "text", primaryKey: true },
      owner_id: { type: "text", required: true },
      status: { type: "text", required: true },
    } as const;
    await db.ensureTable("items", schema);
    await db.ensureTable("items", schema);
    await db.ensureIndex("items_owner_status", "items", {
      fields: ["owner_id", "status"],
    });
    await db.ensureIndex("items_owner_status", "items", {
      fields: ["owner_id", "status"],
    });
    assert.equal(
      (
        await db.insertMany("items", [
          { id: "one", owner_id: "a", status: "open" },
          { id: "two", owner_id: "a", status: "held" },
          { id: "three", owner_id: "b", status: "open" },
        ])
      ).rowsAffected,
      3,
    );
    const where = {
      $and: [{ owner_id: "a" }, { $or: [{ status: "open" }, { status: "held" }] }],
    } as const;
    assert.deepEqual(
      await db.select("items", {
        fields: ["id"],
        where,
        orderBy: [{ field: "id" }],
        limit: 1,
        offset: 1,
      }),
      [{ id: "two" }],
    );
    assert.equal(await db.count("items", { where }), 2);
    assert.equal(await db.exists("items", { where: { status: "missing" } }), false);
    await assert.rejects(
      db.ensureIndex("items_owner_status", "items", { fields: ["status"] }),
      /definition differs/,
    );
    await assert.rejects(
      db.ensureTable("items", { ...schema, missing: { type: "text" } }),
      /missing required column missing/,
    );
  } finally {
    db.close();
  }
});

test("SQLiteDatabase auto-generates portable integer identity values", async () => {
  const db = new SQLiteDatabase(":memory:");
  try {
    await db.ensureTable("messages", {
      id: { type: "integer", primaryKey: true, generated: "identity" },
      text: { type: "text", required: true },
    });
    const first = await db.insert("messages", { text: "hello" });
    const second = await db.insert("messages", { text: "world" });

    assert.equal(first.lastInsertId, 1);
    assert.equal(second.lastInsertId, 2);
    assert.deepEqual(await db.select("messages", { orderBy: [{ field: "id" }] }), [
      { id: 1, text: "hello" },
      { id: 2, text: "world" },
    ]);
  } finally {
    db.close();
  }
});

test("SQLiteDatabase supports composite upserts, conditional leases, and atomic rollback", async () => {
  const db = new SQLiteDatabase(":memory:");
  try {
    await db.ensureTable(
      "identities",
      {
        id: { type: "text", primaryKey: true },
        issuer: { type: "text", required: true },
        subject: { type: "text", required: true },
        email: { type: "text", required: true },
      },
      { unique: [["issuer", "subject"]] },
    );
    await db.upsert(
      "identities",
      { id: "one", issuer: "google", subject: "123", email: "old.com" },
      { conflict: ["issuer", "subject"], update: ["email"] },
    );
    await db.upsert(
      "identities",
      { id: "ignored", issuer: "google", subject: "123", email: "new.com" },
      { conflict: ["issuer", "subject"], update: ["email"] },
    );
    assert.deepEqual(await db.select("identities"), [
      { id: "one", issuer: "google", subject: "123", email: "new.com" },
    ]);

    await db.ensureTable("leases", {
      id: { type: "text", primaryKey: true },
      owner: { type: "text", required: true },
      expires_at: { type: "timestamp", required: true },
    });
    await db.insert("leases", {
      id: "app-one",
      owner: "host-a",
      expires_at: "2026-07-24T00:00:00.000Z",
    });
    const acquired = await db.transaction((tx) =>
      tx.update(
        "leases",
        { owner: "host-b", expires_at: "2026-07-24T00:02:00.000Z" },
        { where: { id: "app-one", expires_at: { lt: "2026-07-24T00:01:00.000Z" } } },
      ),
    );
    assert.equal(acquired.rowsAffected, 1);
    assert.equal(
      (
        await db.update(
          "leases",
          { owner: "host-c" },
          { where: { id: { in: ["app-one"] }, expires_at: { lte: "2026-07-24T00:01:00.000Z" } } },
        )
      ).rowsAffected,
      0,
    );
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.update("leases", { owner: "rolled-back" }, { where: { id: "app-one" } });
        throw new Error("rollback");
      }),
      /rollback/,
    );
    assert.equal((await db.select("leases", { where: { id: "app-one" } }))[0].owner, "host-b");
  } finally {
    db.close();
  }
});
