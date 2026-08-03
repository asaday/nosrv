import assert from "node:assert/strict";
import test from "node:test";
import { createNetlifyHandler } from "@nosrv/adapter-netlify";
import { defineApp } from "@nosrv/core";

test("runs a portable app as a Netlify Function", async () => {
  const handler = createNetlifyHandler(
    defineApp({
      fetch(request, context) {
        return Response.json({
          path: new URL(request.url).pathname,
          platform: context.platform.name,
        });
      },
    }),
  );
  const response = await handler(new Request("https://example.netlify.app/api/hello"), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { path: "/api/hello", platform: "netlify" });
});

test("exposes Netlify environment configuration without App declarations", async () => {
  const name = "NOSRV_NETLIFY_TEST_SECRET";
  process.env[name] = "private-value";
  try {
    const handler = createNetlifyHandler(
      defineApp({
        async fetch(_request, context) {
          return Response.json({ env: context.env[name], secret: await context.secrets.get(name) });
        },
      }),
    );
    const response = await handler(new Request("https://example.netlify.app/"), {});
    assert.deepEqual(await response.json(), {
      env: "private-value",
      secret: "private-value",
    });
  } finally {
    delete process.env[name];
  }
});
