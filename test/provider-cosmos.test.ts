import assert from "node:assert/strict";
import test from "node:test";
import { CosmosKV } from "@nosrv/azure";

test("Cosmos KV maps expiration and continuation cursors", async () => {
  let upserted: Record<string, unknown> | undefined;
  let queryOptions: Record<string, unknown> | undefined;
  const container = {
    items: {
      async upsert(value: Record<string, unknown>) {
        upserted = value;
      },
      query(_query: unknown, options: Record<string, unknown>) {
        queryOptions = options;
        return {
          async fetchNext() {
            return {
              resources: [{ key: "item:a", expiresAt: 2_000_000_000 }],
              continuationToken: "next-page",
            };
          },
        };
      },
    },
  };
  const kv = new CosmosKV(container as never);
  await kv.set("item:a", "value", { expiration: 2_000_000_000 });
  assert.equal(upserted?.key, "item:a");
  assert.equal(upserted?.expiresAt, 2_000_000_000);
  const result = await kv.list({ prefix: "item:", limit: 10, cursor: "page" });
  assert.deepEqual(result, {
    keys: [{ key: "item:a", expiresAt: 2_000_000_000 }],
    complete: false,
    cursor: "next-page",
  });
  assert.equal(queryOptions?.maxItemCount, 10);
  assert.equal(queryOptions?.continuationToken, "page");
});
