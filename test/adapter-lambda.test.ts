import assert from "node:assert/strict";
import { test } from "node:test";
import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
import {
  createLambdaHandler,
  createLambdaScheduledHandler,
  lambdaEventToRequest,
  responseToLambdaResult,
} from "@nosrv/adapter-lambda";
import { defineApp } from "@nosrv/core";

function event(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: "/hello",
    rawQueryString: "name=nosrv",
    headers: { host: "example.lambda-url.test", "x-forwarded-proto": "https" },
    requestContext: {
      accountId: "anonymous",
      apiId: "test",
      domainName: "example.lambda-url.test",
      domainPrefix: "example",
      http: {
        method: "GET",
        path: "/hello",
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "test",
      },
      requestId: "test-request",
      routeKey: "$default",
      stage: "$default",
      time: "17/Jul/2026:00:00:00 +0000",
      timeEpoch: 1,
    },
    isBase64Encoded: false,
    ...overrides,
  };
}

test("converts an HTTP API v2 event to a web Request", async () => {
  const request = lambdaEventToRequest(
    event({
      rawPath: "/submit",
      rawQueryString: "value=1",
      cookies: ["session=abc", "theme=dark"],
      body: Buffer.from("payload").toString("base64"),
      isBase64Encoded: true,
      requestContext: {
        ...event().requestContext,
        http: { ...event().requestContext.http, method: "POST", path: "/submit" },
      },
    }),
  );

  assert.equal(request.url, "https://example.lambda-url.test/submit?value=1");
  assert.equal(request.method, "POST");
  assert.equal(request.headers.get("cookie"), "session=abc; theme=dark");
  assert.equal(await request.text(), "payload");
});

test("converts text responses and cookies to a Lambda result", async () => {
  const headers = new Headers({ "content-type": "text/plain; charset=utf-8", "x-test": "yes" });
  headers.append("set-cookie", "first=1; Path=/");
  headers.append("set-cookie", "second=2; Path=/");
  const result = await responseToLambdaResult(new Response("hello", { status: 201, headers }));

  assert.deepEqual(result, {
    statusCode: 201,
    headers: { "content-type": "text/plain; charset=utf-8", "x-test": "yes" },
    cookies: ["first=1; Path=/", "second=2; Path=/"],
    body: "hello",
    isBase64Encoded: false,
  });
});

test("base64 encodes binary responses", async () => {
  const result = await responseToLambdaResult(
    new Response(new Uint8Array([0, 1, 2, 255]), {
      headers: { "content-type": "application/octet-stream" },
    }),
  );
  assert.equal(result.body, "AAEC/w==");
  assert.equal(result.isBase64Encoded, true);
});

test("runs the same portable app as a Lambda handler", async () => {
  const handler = createLambdaHandler(
    defineApp({
      fetch(request) {
        return Response.json({ path: new URL(request.url).pathname });
      },
    }),
  );
  const result = await handler(event(), {} as Context);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body ?? ""), { path: "/hello" });
});

test("hides provider-owned environment values from Lambda Apps", async () => {
  process.env.NOSRV_TEST_DATABASE_URL = "private";
  try {
    const handler = createLambdaHandler(
      defineApp({
        fetch(_request, context) {
          return Response.json({ hidden: context.env.NOSRV_TEST_DATABASE_URL === undefined });
        },
      }),
      { hiddenEnvNames: ["NOSRV_TEST_DATABASE_URL"] },
    );
    const result = await handler(event(), {} as Context);
    assert.deepEqual(JSON.parse(result.body ?? ""), { hidden: true });
  } finally {
    delete process.env.NOSRV_TEST_DATABASE_URL;
  }
});

test("maps verified API Gateway authorizer claims to ctx.user", async () => {
  const handler = createLambdaHandler(
    defineApp({
      fetch(_request, context) {
        return Response.json(context.user);
      },
    }),
  );
  const authenticated = event();
  Reflect.set(authenticated.requestContext, "authorizer", {
    jwt: {
      claims: { sub: "user-123", email: "user@example.com" },
      scopes: [],
    },
  });

  const result = await handler(authenticated, {} as Context);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body ?? ""), {
    id: "user-123",
    email: "user@example.com",
  });
});

test("supplies a null user when no verified identity is available", async () => {
  const handler = createLambdaHandler(
    defineApp({
      fetch(_request, context) {
        return Response.json(context.user);
      },
    }),
  );
  const result = await handler(event(), {} as Context);
  assert.equal(result.statusCode, 200);
  assert.equal(JSON.parse(result.body ?? ""), null);
});

test("runs an EventBridge schedule as a portable scheduled handler", async () => {
  let received: unknown;
  const handler = createLambdaScheduledHandler(
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
      source: "aws.events",
      time: "2026-07-18T03:00:00Z",
      detail: { name: "cleanup", cron: "0 3 * * *" },
    },
    {} as Context,
  );
  assert.deepEqual(received, {
    event: {
      name: "cleanup",
      cron: "0 3 * * *",
      scheduledTime: Date.parse("2026-07-18T03:00:00Z"),
      trigger: "cron",
    },
    platform: "lambda",
  });
});
