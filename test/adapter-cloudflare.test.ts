import assert from "node:assert/strict";
import { test } from "node:test";
import { createCloudflareHandler } from "@nosrv/cloudflare";
import { defineApp, MemoryResources } from "@nosrv/core";

test("runs a portable app as a Cloudflare fetch handler", async () => {
  const handler = createCloudflareHandler<{ MESSAGE: string; BINDING: object }>(
    defineApp({
      async fetch(request, context) {
        return Response.json({
          message: context.env.MESSAGE,
          path: new URL(request.url).pathname,
          bindingIsHidden: context.env.BINDING === undefined,
          resource: await (await context.resources.get("private.txt"))?.text(),
        });
      },
    }),
    { resources: new MemoryResources({ "private.txt": "internal" }) },
  );

  const response = await handler.fetch(
    new Request("https://example.com/cloudflare"),
    { MESSAGE: "hello", BINDING: {} },
    { waitUntil() {} },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    message: "hello",
    path: "/cloudflare",
    bindingIsHidden: true,
    resource: "internal",
  });
});

test("returns a safe response when the app throws", async () => {
  const handler = createCloudflareHandler(
    defineApp({
      fetch() {
        throw new Error("private failure");
      },
    }),
  );

  const response = await handler.fetch(
    new Request("https://example.com/error"),
    {},
    { waitUntil() {} },
  );
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Internal Server Error" });
});

test("initializes once before concurrent fetch and retries after failure", async () => {
  let attempts = 0;
  let fetches = 0;
  let release: (() => void) | undefined;
  let initializedAgain: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const retryStarted = new Promise<void>((resolve) => {
    initializedAgain = resolve;
  });
  const app = defineApp({
    async initialize() {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary initialization failure");
      initializedAgain!();
      await ready;
    },
    fetch() {
      fetches += 1;
      return new Response("OK");
    },
  });
  const handler = createCloudflareHandler(app);
  const execution = { waitUntil() {} };

  assert.equal(
    (await handler.fetch(new Request("https://example.com/first"), {}, execution)).status,
    500,
  );
  const first = handler.fetch(new Request("https://example.com/second"), {}, execution);
  const second = handler.fetch(new Request("https://example.com/third"), {}, execution);
  await retryStarted;
  assert.equal(attempts, 2);
  assert.equal(fetches, 0);
  release!();
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  assert.equal(attempts, 2);
  assert.equal(fetches, 2);
});

test("runs a portable scheduled handler with its configured name", async () => {
  let received: unknown;
  const handler = createCloudflareHandler(
    defineApp({
      fetch() {
        return new Response("OK");
      },
      scheduled(event, context) {
        received = { event, platform: context.platform.name };
      },
    }),
    { schedules: [{ name: "daily-cleanup", cron: "0 3 * * *" }] },
  );

  await handler.scheduled?.(
    { cron: "0 3 * * *", scheduledTime: 1_700_000_000_000 },
    {},
    { waitUntil() {} },
  );

  assert.deepEqual(received, {
    event: {
      name: "daily-cleanup",
      cron: "0 3 * * *",
      scheduledTime: 1_700_000_000_000,
      trigger: "cron",
    },
    platform: "cloudflare",
  });
});
