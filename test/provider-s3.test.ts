import assert from "node:assert/strict";
import test from "node:test";
import { S3ObjectStorage } from "@nosrv/aws";

test("S3 storage prefixes Platform App keys without exposing the prefix", async () => {
  const inputs: Array<Record<string, unknown>> = [];
  const client = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      inputs.push(command.input);
      if (command.constructor.name === "ListObjectsV2Command") {
        return {
          Contents: [{ Key: "apps/app-one/photos/a.jpg", Size: 3 }],
          IsTruncated: false,
        };
      }
      return { ETag: "etag" };
    },
  };
  const storage = new S3ObjectStorage("bucket", client as never, "apps/app-one/");
  await storage.put("photos/a.jpg", "abc");
  assert.equal(inputs[0].Key, "apps/app-one/photos/a.jpg");
  const listed = await storage.list({ prefix: "photos/" });
  assert.equal(inputs[1].Prefix, "apps/app-one/photos/");
  assert.deepEqual(listed, {
    objects: [{ key: "photos/a.jpg", size: 3 }],
    truncated: false,
  });
});
