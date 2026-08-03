import assert from "node:assert/strict";
import { test } from "node:test";
import { R2ObjectStorage, type R2BucketLike } from "@nosrv/provider-r2";

test("buffers streams before uploading them to R2", async () => {
  let uploaded: unknown;
  const bucket = {
    async put(key, value) {
      uploaded = value;
      return { key, size: 5, etag: "etag", uploaded: new Date() };
    },
  } as R2BucketLike;
  const storage = new R2ObjectStorage(bucket);
  const stream = new Blob(["hello"]).stream();

  const result = await storage.put("hello.txt", stream);

  assert.deepEqual(uploaded, new TextEncoder().encode("hello"));
  assert.deepEqual(result, { key: "hello.txt", etag: "etag" });
});
