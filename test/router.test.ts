import assert from "node:assert/strict";
import test from "node:test";
import {
  createRouter,
  deleteCookie,
  getCookie,
  parseCookies,
  readForm,
  readJson,
  serializeCookie,
} from "@nosrv/core";
import type { AppContext } from "@nosrv/core";
import { defineApp, MemoryResources } from "@nosrv/core";

const context: AppContext = {
  env: {},
  secrets: {
    async get() {
      return null;
    },
  },
  log: { debug() {}, info() {}, warn() {}, error() {} },
  platform: { name: "test" },
  user: null,
  waitUntil() {},
  resources: new MemoryResources(),
};

test("router matches methods and decoded path params", async () => {
  const router = createRouter();
  router.get("/items/:id", ({ params, query }) =>
    Response.json({ id: params.id, q: query.get("q") }),
  );
  const response = await router.fetch(
    new Request("https://example.com/items/hello%20world?q=yes"),
    context,
  );
  assert.deepEqual(await response.json(), { id: "hello world", q: "yes" });
});

test("router composes as a defineApp fetch implementation", async () => {
  const router = createRouter().get("/", () => new Response("routed"));
  const app = defineApp({
    async fetch(request, appContext) {
      const response = await router.fetch(request, appContext);
      response.headers.set("x-app", "wrapped");
      return response;
    },
  });

  const response = await app.fetch(new Request("https://example.com/"), context);
  assert.equal(await response.text(), "routed");
  assert.equal(response.headers.get("x-app"), "wrapped");
});

test("router is directly callable as a fetch handler", async () => {
  const router = createRouter().get("/", () => new Response("callable"));
  const response = await router(new Request("https://example.com/"), context);
  assert.equal(await response.text(), "callable");
});

test("router accepts a registration function", async () => {
  const router = createRouter((configured) => {
    configured.get("/configured", () => new Response("configured"));
  });
  const response = await router.fetch(new Request("https://example.com/configured"), context);
  assert.equal(await response.text(), "configured");
});

test("routes, middleware, and mounts run in registration order", async () => {
  const child = createRouter().get("/", () => new Response("mounted"));
  const router = createRouter()
    .get("/public", () => new Response("public"))
    .mount("/mounted", child)
    .use(() => new Response("protected", { status: 401 }))
    .get("/private", () => new Response("private"));

  const publicResponse = await router.fetch(new Request("https://example.com/public"), context);
  assert.equal(await publicResponse.text(), "public");
  const mountedResponse = await router.fetch(new Request("https://example.com/mounted"), context);
  assert.equal(await mountedResponse.text(), "mounted");
  const privateResponse = await router.fetch(new Request("https://example.com/private"), context);
  assert.equal(privateResponse.status, 401);
  assert.equal(await privateResponse.text(), "protected");
});

test("mount initializes a child App before dispatch", async () => {
  const calls: string[] = [];
  const child = defineApp({
    initialize() {
      calls.push("initialize");
    },
    fetch() {
      calls.push("fetch");
      return new Response("child");
    },
  });
  const router = createRouter().mount("/child", child);
  assert.equal(
    await (await router.fetch(new Request("https://example.com/child"), context)).text(),
    "child",
  );
  assert.equal(
    await (await router.fetch(new Request("https://example.com/child"), context)).text(),
    "child",
  );
  assert.deepEqual(calls, ["initialize", "fetch", "fetch"]);
});

test("path-scoped middleware matches only its path subtree", async () => {
  const router = createRouter()
    .use("/api", () => new Response("api middleware"))
    .get("/api/items", () => new Response("items"))
    .get("/apricot", () => new Response("apricot"));

  assert.equal(
    await (await router.fetch(new Request("https://example.com/api/items"), context)).text(),
    "api middleware",
  );
  assert.equal(
    await (await router.fetch(new Request("https://example.com/apricot"), context)).text(),
    "apricot",
  );
});

test("middleware can process responses around next", async () => {
  const calls: string[] = [];
  const router = createRouter()
    .use(async (_context, next) => {
      calls.push("before");
      const response = await next();
      calls.push("after");
      response.headers.set("x-middleware", "yes");
      return response;
    })
    .get("/items", () => {
      calls.push("handler");
      return new Response("items");
    });

  const response = await router.fetch(new Request("https://example.com/items"), context);
  assert.equal(response.headers.get("x-middleware"), "yes");
  assert.deepEqual(calls, ["before", "handler", "after"]);
});

test("routes accept middleware-style handler chains", async () => {
  const router = createRouter().get(
    "/items/:id",
    async ({ params }, next) => {
      assert.equal(params.id, "123");
      const response = await next();
      response.headers.set("x-route-middleware", "yes");
      return response;
    },
    ({ params }) => new Response(params.id),
  );
  const response = await router.fetch(new Request("https://example.com/items/123"), context);
  assert.equal(await response.text(), "123");
  assert.equal(response.headers.get("x-route-middleware"), "yes");
});

test("middleware rejects calling next more than once", async () => {
  const router = createRouter()
    .use(async (_context, next) => {
      await next();
      await next();
    })
    .get("/items", () => new Response("items"));
  await assert.rejects(
    async () => await router.fetch(new Request("https://example.com/items"), context),
    /next\(\) called more than once/,
  );
});

test("the first matching route wins", async () => {
  const router = createRouter()
    .get("/items/:id", () => new Response("parameter"))
    .get("/items/new", () => new Response("literal"));
  const response = await router.fetch(new Request("https://example.com/items/new"), context);
  assert.equal(await response.text(), "parameter");
});

test("router returns 404 and 405 with Allow", async () => {
  const router = createRouter().get("/items", () => new Response("ok"));
  const missing = await router.fetch(new Request("https://example.com/missing"), context);
  assert.equal(missing.status, 404);
  const wrongMethod = await router.fetch(
    new Request("https://example.com/items", { method: "POST" }),
    context,
  );
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "GET, HEAD, OPTIONS");
});

test("HEAD uses GET routes without returning a body", async () => {
  const router = createRouter().get(
    "/items",
    () =>
      new Response("content", {
        headers: { "x-route": "get" },
      }),
  );
  const response = await router.fetch(
    new Request("https://example.com/items", { method: "HEAD" }),
    context,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-route"), "get");
  assert.equal(await response.text(), "");
});

test("explicit HEAD routes take precedence over GET fallback", async () => {
  const router = createRouter()
    .get("/items", () => new Response("get", { headers: { "x-route": "get" } }))
    .head("/items", () => new Response(null, { headers: { "x-route": "head" } }));
  const response = await router.fetch(
    new Request("https://example.com/items", { method: "HEAD" }),
    context,
  );
  assert.equal(response.headers.get("x-route"), "head");
});

test("OPTIONS responds automatically and explicit routes can override it", async () => {
  const automatic = createRouter()
    .get("/items", () => new Response("get"))
    .post("/items", () => new Response("post"));
  const automaticResponse = await automatic.fetch(
    new Request("https://example.com/items", { method: "OPTIONS" }),
    context,
  );
  assert.equal(automaticResponse.status, 204);
  assert.equal(automaticResponse.headers.get("allow"), "GET, HEAD, POST, OPTIONS");

  const explicit = createRouter()
    .get("/items", () => new Response("get"))
    .options(
      "/items",
      () => new Response(null, { status: 200, headers: { "x-options": "explicit" } }),
    );
  const explicitResponse = await explicit.fetch(
    new Request("https://example.com/items", { method: "OPTIONS" }),
    context,
  );
  assert.equal(explicitResponse.status, 200);
  assert.equal(explicitResponse.headers.get("x-options"), "explicit");
});

test("malformed encoded path parameters return 400", async () => {
  const router = createRouter().get("/items/:id", () => new Response("ok"));
  const response = await router.fetch(new Request("https://example.com/items/%ZZ"), context);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid URL path encoding" });
});

test("readJson and readForm normalize invalid input into HTTP errors", async () => {
  const router = createRouter();
  router.post("/json", async ({ request }) => Response.json(await readJson(request)));
  router.post("/form", async ({ request }) => {
    const form = await readForm(request);
    return Response.json({ title: form.text("title", { required: true }) });
  });
  assert.equal(
    (
      await router.fetch(
        new Request("https://example.com/json", { method: "POST", body: "{" }),
        context,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await router.fetch(
        new Request("https://example.com/form", { method: "POST", body: new FormData() }),
        context,
      )
    ).status,
    400,
  );
});

test("body helpers enforce request size limits", async () => {
  const router = createRouter();
  router.post("/json", async ({ request }) =>
    Response.json(await readJson(request, { maxSize: 4 })),
  );
  router.post("/form", async ({ request }) =>
    Response.json(await readForm(request, { maxSize: 4 })),
  );

  const json = await router.fetch(
    new Request("https://example.com/json", { method: "POST", body: '"large"' }),
    context,
  );
  assert.equal(json.status, 413);
  const form = await router.fetch(
    new Request("https://example.com/form", { method: "POST", body: new FormData() }),
    context,
  );
  assert.equal(form.status, 413);
});

test("mount delegates a path subtree with the prefix removed", async () => {
  const child = createRouter()
    .get("/items/:id", ({ params, url }) =>
      Response.json({ id: params.id, pathname: url.pathname }),
    )
    .post("/echo", async ({ request }) => new Response(await request.text()));
  const parent = createRouter().mount("/api", child);

  const response = await parent.fetch(new Request("https://example.com/api/items/123"), context);
  assert.deepEqual(await response.json(), { id: "123", pathname: "/items/123" });
  const echo = await parent.fetch(
    new Request("https://example.com/api/echo", { method: "POST", body: "mounted" }),
    context,
  );
  assert.equal(await echo.text(), "mounted");
});

test("mount validates child App capabilities before dispatch", async () => {
  const parent = createRouter();
  const child = defineApp({
    requires: { db: true },
    fetch: () => new Response("child"),
  });
  parent.mount("/api", child);
  await assert.rejects(
    () => parent.fetch(new Request("https://example.com/api"), context),
    /Required capability is unavailable: db/,
  );
});

test("cookie helpers read request cookies", () => {
  const request = new Request("https://example.com", {
    headers: { cookie: "session=hello%20world; theme=dark; token=a=b; session=ignored" },
  });
  assert.deepEqual(parseCookies(request), { session: "hello world", theme: "dark", token: "a=b" });
  assert.equal(getCookie(request, "session"), "hello world");
  assert.equal(getCookie(request, "missing"), null);
});

test("cookie helpers serialize and delete response cookies", () => {
  assert.equal(
    serializeCookie("session", "hello world", {
      path: "/",
      maxAge: 3600,
      httpOnly: true,
      secure: true,
      sameSite: "lax",
    }),
    "session=hello%20world; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax",
  );
  assert.equal(
    deleteCookie("session", { path: "/", httpOnly: true }),
    "session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly",
  );
});

test("cookie serialization rejects unsafe attributes", () => {
  assert.throws(() => serializeCookie("bad name", "value"), /Invalid cookie name/);
  assert.throws(
    () => serializeCookie("name", "value", { path: "/; Secure" }),
    /Invalid cookie path/,
  );
});
