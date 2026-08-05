import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FilesystemObjectStorage, FilesystemResources } from "nosrv/runtime/filesystem";

test("filesystem resources read private files without allowing traversal", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "nosrv-resources-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "nested"));
  await writeFile(join(directory, "nested/config.json"), '{"enabled":true}\n');
  const resources = new FilesystemResources(directory);

  assert.equal(await (await resources.get("nested/config.json"))?.text(), '{"enabled":true}\n');
  assert.equal(await resources.get("missing.json"), null);
  assert.equal(await resources.get("../outside"), null);
  assert.equal(await resources.get("/etc/passwd"), null);
});

test("filesystem storage persists objects across provider instances", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "nosrv-storage-"));
  context.after(() => rm(directory, { recursive: true, force: true }));

  const first = new FilesystemObjectStorage(directory);
  await first.put("nested/hello.txt", "persistent", {
    contentType: "text/plain",
    customMetadata: { test: "yes" },
  });

  const second = new FilesystemObjectStorage(directory);
  const object = await second.get("nested/hello.txt");
  assert.ok(object);
  assert.equal(await new Response(object.body).text(), "persistent");
  assert.equal(object.metadata.contentType, "text/plain");
  assert.deepEqual(object.metadata.custom, { test: "yes" });
  assert.deepEqual(
    (await second.list({ prefix: "nested/" })).objects.map(({ key }) => key),
    ["nested/hello.txt"],
  );

  await second.delete("nested/hello.txt");
  assert.equal(await first.get("nested/hello.txt"), null);
});

test("filesystem storage handles long and traversal-like keys safely", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "nosrv-storage-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const storage = new FilesystemObjectStorage(directory);
  const key = `../../${"long-key-".repeat(100)}`;

  await storage.put(key, "safe");
  assert.equal(await new Response((await storage.get(key))!.body).text(), "safe");
});
