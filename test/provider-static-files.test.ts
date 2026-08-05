import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { serveSpaFallback, serveStaticFile } from "nosrv/runtime/static-files";

const publicDirectory = resolve("examples/todo/public");

test("static files serve index documents with content types", async () => {
  const index = await serveStaticFile(new Request("https://example.com/"), publicDirectory);
  assert.equal(index?.status, 200);
  assert.equal(index?.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(await index!.text(), /nosrv Todo/);
  const script = await serveStaticFile(new Request("https://example.com/app.js"), publicDirectory);
  assert.equal(script?.headers.get("content-type"), "text/javascript; charset=utf-8");
});

test("static files serve PWA manifests with the standard content type", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "nosrv-static-manifest-"));
  try {
    await writeFile(resolve(directory, "app.webmanifest"), '{"name":"App"}');
    const manifest = await serveStaticFile(
      new Request("https://example.com/app.webmanifest"),
      directory,
    );
    assert.equal(manifest?.headers.get("content-type"), "application/manifest+json; charset=utf-8");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("static files ignore missing, unsafe, and non-read requests", async () => {
  assert.equal(
    await serveStaticFile(new Request("https://example.com/missing"), publicDirectory),
    null,
  );
  assert.equal(
    await serveStaticFile(new Request("https://example.com/%2e%2e/package.json"), publicDirectory),
    null,
  );
  assert.equal(
    await serveStaticFile(new Request("https://example.com/", { method: "POST" }), publicDirectory),
    null,
  );
});

test("static files allow development runtimes to disable asset caching", async () => {
  const script = await serveStaticFile(new Request("https://example.com/app.js"), publicDirectory, {
    cacheControl: "no-cache",
  });
  assert.equal(script?.headers.get("cache-control"), "no-cache");
});

test("SPA fallback serves index only for browser navigation", async () => {
  const navigation = await serveSpaFallback(
    new Request("https://example.com/client/route", { headers: { accept: "text/html" } }),
    publicDirectory,
  );
  assert.equal(navigation?.status, 200);
  assert.match(await navigation!.text(), /nosrv Todo/);

  const apiRequest = await serveSpaFallback(
    new Request("https://example.com/api/missing", { headers: { accept: "application/json" } }),
    publicDirectory,
  );
  assert.equal(apiRequest, null);
});
