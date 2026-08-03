import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { defineApp, MemoryResources } from "@nosrv/core";
import { createScheduledRunner, listen } from "@nosrv/runtime-node";
import type { Server } from "node:http";

let server: Server;
let baseUrl: string;

before(async () => {
  const running = await listen(
    defineApp({
      async fetch(request, ctx) {
        return Response.json({
          method: request.method,
          path: new URL(request.url).pathname,
          env: ctx.env.TEST_VALUE,
          body: request.method === "POST" ? await request.text() : null,
          resource: await (await ctx.resources.get("private.json"))?.text(),
        });
      },
    }),
    {
      port: 0,
      env: { TEST_VALUE: "works" },
      resources: new MemoryResources({ "private.json": '{"private":true}' }),
    },
  );
  server = running.server;
  baseUrl = `http://${running.hostname}:${running.port}`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

test("adapts an HTTP request and response", async () => {
  const response = await fetch(`${baseUrl}/hello`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    method: "GET",
    path: "/hello",
    env: "works",
    body: null,
    resource: '{"private":true}',
  });
});

test("streams a request body to the app", async () => {
  const response = await fetch(`${baseUrl}/submit`, { method: "POST", body: "payload" });
  assert.deepEqual(await response.json(), {
    method: "POST",
    path: "/submit",
    env: "works",
    body: "payload",
    resource: '{"private":true}',
  });
});

test("runs a scheduled handler with Node capabilities", async () => {
  let value: unknown;
  const app = defineApp({
    requires: { kv: true },
    fetch() {
      return new Response("OK");
    },
    async scheduled(event, context) {
      await context.kv.set("last", event.name);
      value = {
        event,
        stored: await context.kv.get("last"),
        platform: context.platform.name,
      };
    },
  });
  const run = createScheduledRunner(app);
  const event = {
    name: "cleanup",
    cron: "0 3 * * *",
    scheduledTime: 1_700_000_000_000,
    trigger: "manual" as const,
  };
  await run(event);
  assert.deepEqual(value, { event, stored: "cleanup", platform: "node" });
});
