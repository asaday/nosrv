import assert from "node:assert/strict";
import test from "node:test";
import azureFunctions from "@azure/functions";
import { createAzureHttpHandler, createAzureTimerHandler } from "@nosrv/adapter-azure-functions";
import { defineApp } from "@nosrv/core";

const { HttpRequest } = azureFunctions;

function invocation() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  } as never;
}

function responseBody(response: unknown): Uint8Array {
  const body = (response as { body?: unknown }).body;
  assert.ok(body instanceof Uint8Array);
  return body;
}

test("runs a portable app as an Azure HTTP function", async () => {
  const handler = createAzureHttpHandler(
    defineApp({
      fetch(request, context) {
        return Response.json({
          path: new URL(request.url).pathname,
          platform: context.platform.name,
        });
      },
    }),
  );
  const response = await handler(
    new HttpRequest({ method: "GET", url: "https://example.azurewebsites.net/api/hello" }),
    invocation(),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(responseBody(response))), {
    path: "/api/hello",
    platform: "azure-functions",
  });
});

test("hides provider-owned environment values from Azure Apps", async () => {
  process.env.NOSRV_AZURE_TEST_SECRET = "private";
  try {
    const handler = createAzureHttpHandler(
      defineApp({
        fetch(_request, context) {
          return Response.json({ hidden: context.env.NOSRV_AZURE_TEST_SECRET === undefined });
        },
      }),
      { hiddenEnvNames: ["NOSRV_AZURE_TEST_SECRET"] },
    );
    const response = await handler(
      new HttpRequest({ method: "GET", url: "https://example.test/" }),
      invocation(),
    );
    assert.deepEqual(JSON.parse(new TextDecoder().decode(responseBody(response))), {
      hidden: true,
    });
  } finally {
    delete process.env.NOSRV_AZURE_TEST_SECRET;
  }
});

test("runs an Azure timer handler with the portable cron event", async () => {
  let received: unknown;
  const handler = createAzureTimerHandler(
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
  await handler(
    {
      isPastDue: false,
      scheduleStatus: {
        last: "2026-07-18T03:00:00Z",
        next: "2026-07-19T03:00:00Z",
        lastUpdated: "2026-07-18T03:00:00Z",
      },
      schedule: { adjustForDST: false },
    },
    invocation(),
  );
  assert.deepEqual(received, {
    event: {
      name: "cleanup",
      cron: "0 3 * * *",
      scheduledTime: Date.parse("2026-07-18T03:00:00Z"),
      trigger: "cron",
    },
    platform: "azure-functions",
  });
});
