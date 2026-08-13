import assert from "node:assert/strict";
import test from "node:test";
import { D1Database, type D1DatabaseLike } from "@nosrv/cloudflare";

test("D1Database binds values and normalizes results", async () => {
  let bound: unknown[] = [];
  const binding: D1DatabaseLike = {
    prepare() {
      return {
        bind(...values) {
          bound = values;
          return this;
        },
        async all<T>() {
          return { results: [{ id: 1 }] as T[] };
        },
        async run() {
          return { meta: { changes: 1, last_row_id: 3 } };
        },
      };
    },
  };
  const db = new D1Database(binding);
  assert.deepEqual((await db.sql.query<{ id: number }>("SELECT ?", [true])).rows, [{ id: 1 }]);
  assert.deepEqual(bound, [1]);
  assert.deepEqual(await db.sql.execute("INSERT", ["x"]), {
    rowsAffected: 1,
    lastInsertId: 3,
  });
  await assert.rejects(
    db.transaction(async () => undefined),
    /transactions are not supported/,
  );
});
