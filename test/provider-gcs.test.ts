import assert from "node:assert/strict";
import test from "node:test";
import { GCSObjectStorage } from "@nosrv/google-cloud";

test("GCS storage prefixes Platform App keys without exposing the prefix", async () => {
  const fileNames: string[] = [];
  let listPrefix: string | undefined;
  const bucket = {
    file(name: string) {
      fileNames.push(name);
      return {
        async save() {},
        async getMetadata() {
          return [{ size: "3", etag: "etag" }];
        },
        async delete() {},
      };
    },
    async getFiles(options: { prefix?: string }) {
      listPrefix = options.prefix;
      return [[{ name: "apps/app-one/photos/a.jpg", metadata: { size: "3" } }], {}];
    },
  };
  const storageClient = { bucket: () => bucket };
  const storage = new GCSObjectStorage("bucket", storageClient as never, "apps/app-one/");
  await storage.put("photos/a.jpg", "abc");
  assert.equal(fileNames[0], "apps/app-one/photos/a.jpg");
  const listed = await storage.list({ prefix: "photos/" });
  assert.equal(listPrefix, "apps/app-one/photos/");
  assert.deepEqual(listed, {
    objects: [{ key: "photos/a.jpg", size: 3 }],
    truncated: false,
  });
});
