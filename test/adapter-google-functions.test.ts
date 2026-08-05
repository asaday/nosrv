import assert from "node:assert/strict";
import { test } from "node:test";
import { createGoogleFunctionsHandler, createGoogleScheduledHandler } from "@nosrv/google-cloud";
import { defineApp } from "@nosrv/core";

function responseRecorder() {
  const headers = new Map<string, unknown>();
  return {
    statusCode: 200,
    body: undefined as unknown,
    headersSent: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(name: string, value: unknown) {
      headers.set(name, value);
      return this;
    },
    send(body: unknown) {
      this.body = body;
      this.headersSent = true;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      this.headersSent = true;
      return this;
    },
    end() {
      this.headersSent = true;
      return this;
    },
    headers,
  };
}

test("runs a portable app as a Google HTTP function", async () => {
  const handler = createGoogleFunctionsHandler(
    defineApp({
      fetch(request) {
        return Response.json({ path: new URL(request.url).pathname });
      },
    }),
  );
  const outgoing = responseRecorder();
  await handler(
    {
      headers: { host: "example.test", "x-forwarded-proto": "https" },
      protocol: "https",
      originalUrl: "/hello",
      url: "/hello",
      path: "/hello",
      method: "GET",
    } as never,
    outgoing as never,
  );
  assert.equal(outgoing.statusCode, 200);
  assert.deepEqual(JSON.parse(String(outgoing.body)), { path: "/hello" });
});

test("hides provider-owned environment values from Google Apps", async () => {
  process.env.NOSRV_TEST_DATABASE_URL = "private";
  try {
    const handler = createGoogleFunctionsHandler(
      defineApp({
        fetch(_request, context) {
          return Response.json({ hidden: context.env.NOSRV_TEST_DATABASE_URL === undefined });
        },
      }),
      { hiddenEnvNames: ["NOSRV_TEST_DATABASE_URL"] },
    );
    const outgoing = responseRecorder();
    await handler(
      {
        headers: { host: "example.test" },
        originalUrl: "/",
        url: "/",
        path: "/",
        method: "GET",
      } as never,
      outgoing as never,
    );
    assert.deepEqual(JSON.parse(String(outgoing.body)), { hidden: true });
  } finally {
    delete process.env.NOSRV_TEST_DATABASE_URL;
  }
});

test("runs a Google scheduled handler", async () => {
  let received: unknown;
  const handler = createGoogleScheduledHandler(
    defineApp({
      fetch() {
        return new Response("OK");
      },
      scheduled(event, context) {
        received = { event, platform: context.platform.name };
      },
    }),
    { name: "cleanup", cron: "0 3 * * *" },
  );
  const outgoing = responseRecorder();
  await handler(
    {
      headers: { "x-cloudscheduler-scheduletime": "2026-07-18T03:00:00Z" },
    } as never,
    outgoing as never,
  );
  assert.equal(outgoing.statusCode, 204);
  assert.deepEqual(received, {
    event: {
      name: "cleanup",
      cron: "0 3 * * *",
      scheduledTime: Date.parse("2026-07-18T03:00:00Z"),
      trigger: "cron",
    },
    platform: "google-functions",
  });
});
