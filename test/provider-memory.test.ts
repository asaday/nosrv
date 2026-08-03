import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryObjectStorage } from "@nosrv/provider-memory";

test("memory object storage supports put, get, head, list, and delete", async () => {
  const storage = new MemoryObjectStorage();
  const put = await storage.put("reports/hello.txt", "hello", {
    contentType: "text/plain",
    customMetadata: { source: "test" },
  });
  await storage.put("other.txt", "other");

  assert.equal(put.key, "reports/hello.txt");
  assert.ok(put.etag);
  const object = await storage.get("reports/hello.txt");
  assert.ok(object);
  assert.equal(await new Response(object.body).text(), "hello");
  assert.equal(object.metadata.contentType, "text/plain");
  assert.deepEqual(object.metadata.custom, { source: "test" });
  assert.equal((await storage.head("reports/hello.txt"))?.size, 5);

  const listed = await storage.list({ prefix: "reports/" });
  assert.deepEqual(
    listed.objects.map(({ key }) => key),
    ["reports/hello.txt"],
  );
  assert.equal(listed.truncated, false);

  await storage.delete("reports/hello.txt");
  assert.equal(await storage.get("reports/hello.txt"), null);
});
