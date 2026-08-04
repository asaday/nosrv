import assert from "node:assert/strict";
import test from "node:test";
import { AzureBlobObjectStorage } from "@nosrv/provider-azure-blob";

test("Azure Blob storage prefixes App keys without exposing the prefix", async () => {
  const names: string[] = [];
  let listPrefix: string | undefined;
  const container = {
    getBlockBlobClient(name: string) {
      names.push(name);
      return {
        async uploadData() {
          return { etag: "etag" };
        },
      };
    },
    listBlobsFlat(options: { prefix?: string }) {
      listPrefix = options.prefix;
      return {
        byPage() {
          return {
            async next() {
              return {
                value: {
                  segment: {
                    blobItems: [
                      { name: "apps/app-one/photos/a.jpg", properties: { contentLength: 3 } },
                    ],
                  },
                },
              };
            },
          };
        },
      };
    },
  };
  const storage = new AzureBlobObjectStorage(container as never, { prefix: "apps/app-one/" });
  await storage.put("photos/a.jpg", "abc");
  assert.equal(names[0], "apps/app-one/photos/a.jpg");
  const listed = await storage.list({ prefix: "photos/" });
  assert.equal(listPrefix, "apps/app-one/photos/");
  assert.deepEqual(listed, {
    objects: [{ key: "photos/a.jpg", size: 3 }],
    truncated: false,
  });
});
