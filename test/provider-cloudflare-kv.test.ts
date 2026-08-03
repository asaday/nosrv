import assert from "node:assert/strict";
import test from "node:test";
import { CloudflareKV, type WorkersKVNamespaceLike } from "@nosrv/provider-cloudflare-kv";

test("Cloudflare KV maps expiration and list pagination", async () => {
  let putOptions: { expiration?: number } | undefined;
  let listOptions: { prefix?: string; limit?: number; cursor?: string } | undefined;
  const namespace: WorkersKVNamespaceLike = {
    async get() {
      return null;
    },
    async put(_key, _value, options) {
      putOptions = options;
    },
    async delete() {},
    async list(options) {
      listOptions = options;
      return {
        keys: [{ name: "item:a", expiration: 2_000_000_000 }],
        list_complete: false,
        cursor: "next",
      };
    },
  };
  const kv = new CloudflareKV(namespace);
  await kv.set("item:a", "value", { expiration: 2_000_000_000 });
  assert.deepEqual(putOptions, { expiration: 2_000_000_000 });
  assert.deepEqual(await kv.list({ prefix: "item:", limit: 10, cursor: "previous" }), {
    keys: [{ key: "item:a", expiresAt: 2_000_000_000 }],
    complete: false,
    cursor: "next",
  });
  assert.deepEqual(listOptions, { prefix: "item:", limit: 10, cursor: "previous" });
});
