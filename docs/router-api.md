# nosrv Router API

`@nosrv/router` is an optional Fetch API-native routing layer for nosrv Apps. It organizes multiple HTTP routes, middleware, request body parsing, cookies, and composed Apps without replacing the Web Standard `Request` and `Response` contract.

The exported TypeScript interfaces in [`packages/router/src/index.ts`](../packages/router/src/index.ts) are the source of truth for this API.

## Quick start

```ts
import { defineApp } from "@nosrv/core";
import { createRouter, HttpError, readJson } from "@nosrv/router";

const requires = { db: true } as const;
const router = createRouter<typeof requires>();

router.get("/api/items/:id", async ({ ctx, params }) => {
  const item = (
    await ctx.db.select("items", {
      where: { id: params.id },
      limit: 1,
    })
  )[0];
  if (!item) throw new HttpError(404, "Item not found");
  return Response.json({ item });
});

router.post("/api/items", async ({ request, ctx }) => {
  const input = await readJson<{ title?: unknown }>(request, {
    maxSize: 64 * 1024,
  });
  if (typeof input.title !== "string") {
    throw new HttpError(400, "title is required");
  }
  const id = crypto.randomUUID();
  await ctx.db.insert("items", { id, title: input.title });
  return Response.json({ id }, { status: 201 });
});

export default defineApp({
  requires,
  fetch: router,
});
```

A router is both directly callable and available through `router.fetch(request, ctx)`. It can therefore be assigned directly to the App's `fetch` hook.

## Creating a router

```ts
function createRouter<const R extends CapabilityRequirements = {}>(
  configure?: (router: Router<R>) => void,
): Router<R>;
```

Create an empty router and register routes afterward:

```ts
const router = createRouter();
router.get("/", () => new Response("Hello"));
```

Or register routes in a configuration function:

```ts
const router = createRouter((router) => {
  router.get("/health", () => Response.json({ ok: true }));
});
```

When a typed registration function is passed to `createRouter`, its capability requirements can be inferred. Otherwise, share a `requires` constant between `createRouter` and `defineApp` so `ctx` is typed consistently.

```ts
const requires = { storage: true } as const;
const router = createRouter<typeof requires>();

router.get("/files/:key", async ({ ctx, params }) => {
  const object = await ctx.storage.get(params.key);
  return object ? new Response(object.body) : new Response("Not found", { status: 404 });
});

export default defineApp({ requires, fetch: router });
```

See the [`ctx` API reference](./context-api.md) for capability methods and portability guarantees.

## Route methods

```ts
router.get(path, ...handlers);
router.head(path, ...handlers);
router.options(path, ...handlers);
router.post(path, ...handlers);
router.put(path, ...handlers);
router.patch(path, ...handlers);
router.delete(path, ...handlers);
router.all(path, ...handlers);
```

Every registration method returns the router, so calls may be chained. At least one handler is required.

`router.all()` matches every HTTP method. Otherwise, matching requires both the route path and registered method, except for the automatic `HEAD` behavior described below.

### Route paths

Routes match URL pathnames. Query strings do not participate in path matching.

```ts
router.get("/users/:id", ({ params, query }) => {
  return Response.json({
    id: params.id,
    verbose: query.has("verbose"),
  });
});
```

- A trailing slash is optional: `/users/42` and `/users/42/` match the same route.
- `:name` captures one non-empty path segment.
- Captured parameters are decoded with `decodeURIComponent`.
- Invalid URL encoding in a captured parameter produces `400 Invalid URL path encoding`.
- A path segment equal to `*` matches the remaining path text.
- Static path characters are matched literally.

Path parameter names are inferred from string literal route paths:

```ts
router.get("/teams/:teamId/users/:userId", ({ params }) => {
  params.teamId; // string
  params.userId; // string
  return new Response("OK");
});
```

## Route context

Each route handler receives:

```ts
interface RouteContext<R, Path extends string = string> {
  request: Request;
  ctx: AppContextFor<R>;
  params: RouteParams<Path>;
  url: URL;
  query: URLSearchParams;
}
```

| Property  | Description                     |
| --------- | ------------------------------- |
| `request` | Original Web Standard request   |
| `ctx`     | Typed nosrv App context         |
| `params`  | Decoded `:name` path parameters |
| `url`     | Parsed request URL              |
| `query`   | The URL's `URLSearchParams`     |

Handlers return a `Response`, return nothing to continue dispatch, or call `next()` to process the rest of the chain explicitly.

```ts
type Next = () => Promise<Response>;

type RouteHandler = (
  context: RouteContext,
  next: Next,
) => void | Response | Promise<void | Response>;
```

## Registration order and handler chains

Routes, middleware, and mounts run in registration order. The first layer that returns a response ends dispatch.

```ts
router.get("/public", publicHandler);
router.use(requireUser);
router.get("/account", accountHandler);
```

In this example `/public` is registered before authentication middleware, while `/account` passes through it.

A route may contain multiple middleware-style handlers:

```ts
router.post("/api/items", requireUser, validateItem, async ({ ctx }) =>
  Response.json({ created: true }),
);
```

Handlers follow these rules:

- Returning a `Response` ends the current chain.
- Calling `await next()` runs the next handler or routing layer and allows the current handler to process its response.
- Returning nothing without calling `next()` automatically continues.
- Calling `next()` more than once throws an error.
- If multiple routes match, registration order determines which one can respond first.

```ts
router.use(async ({ ctx }, next) => {
  const started = performance.now();
  const response = await next();
  ctx.log.info("Request complete", {
    status: response.status,
    durationMs: performance.now() - started,
  });
  return response;
});
```

## Middleware

Register middleware globally or for one path subtree:

```ts
router.use(...handlers);
router.use(path, ...handlers);
```

```ts
router.use("/api/admin", async ({ ctx }, next) => {
  if (!ctx.user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return next();
});
```

- An omitted path is equivalent to `/`.
- Middleware paths must start with `/`.
- A trailing slash in the configured prefix is removed.
- A prefix matches itself and its path subtree. `/api` matches `/api` and `/api/items`, but not `/apiary`.
- Middleware receives an empty `params` object because it is matched by prefix rather than a route pattern.

## Mounting Apps and routers

```ts
router.mount(path, app);
```

Mount delegates one path subtree to another nosrv App or router.

```ts
const status = createRouter();
status.get("/", () => Response.json({ ok: true }));

router.mount("/api/status", status);
```

A request to `/api/status/` reaches the mounted router as `/`. Query parameters, method, headers, and request body are preserved.

- Mount paths must start with `/` and may not be the router root.
- A trailing slash in the configured prefix is removed.
- The prefix matches only complete path segments.
- The router validates the mounted App's declared capabilities before dispatch.
- The mounted App's `initialize(ctx)` hook completes before its first request.
- A mounted App response ends dispatch; it does not fall through to later parent layers.

Mounting composes Apps inside one runtime process. It is different from the nosrv Platform Gateway, which proxies requests between processes.

## Automatic HTTP responses

### `404 Not Found`

When no registered route path matches, the router returns:

```http
HTTP/1.1 404 Not Found
Content-Type: application/json

{"error":"Not Found"}
```

### `405 Method Not Allowed`

When the path matches but the method does not, the router returns JSON with status `405` and an `Allow` header listing registered methods.

```http
HTTP/1.1 405 Method Not Allowed
Allow: GET, HEAD, OPTIONS
Content-Type: application/json

{"error":"Method Not Allowed"}
```

### `HEAD`

When no explicit `HEAD` or `all` route matches, `HEAD` falls back to the matching `GET` route. The response keeps the status, status text, and headers but removes the body.

An explicit `HEAD` route takes precedence over the `GET` fallback.

### `OPTIONS`

When no explicit `OPTIONS` or `all` route handles a matching path, the router returns `204` with an `Allow` header. An explicitly registered `OPTIONS` route takes precedence.

## HTTP errors

```ts
class HttpError extends Error {
  readonly status: number;
  readonly details?: unknown;

  constructor(status: number, message: string, details?: unknown);
}
```

Throw `HttpError` from a handler or helper to return a JSON error response:

```ts
throw new HttpError(422, "Validation failed", {
  field: "title",
  reason: "too short",
});
```

```json
{
  "error": "Validation failed",
  "details": {
    "field": "title",
    "reason": "too short"
  }
}
```

Unexpected errors are not converted into router responses; they propagate to the runtime's error handling.

## Response helpers

### `json()`

```ts
json(data: unknown, init?: number | ResponseInit): Response;
```

`json(data, 201)` is shorthand for `Response.json(data, { status: 201 })`.

### `html()`

```ts
html(body: string, init?: ResponseInit): Response;
```

Creates a response and sets `content-type: text/html; charset=utf-8`, replacing any supplied content type.

### `noContent()`

```ts
noContent(): Response;
```

Returns an empty response with status `204`.

These helpers are optional. Native `Response`, `Response.json`, and other Web APIs remain available.

## Request body helpers

All buffered body readers accept:

```ts
interface BodyReadOptions {
  maxSize?: number;
}
```

`maxSize` is a non-negative safe integer measured in bytes. When the declared `Content-Length` or streamed body exceeds it, the helper throws `HttpError(413, "Request body is too large")`.

Apply explicit limits to untrusted request bodies.

### `readBody()`

```ts
readBody(request: Request, options?: BodyReadOptions): Promise<Uint8Array>;
```

Buffers the request body. A request without a body returns an empty `Uint8Array`.

### `limitBody()`

```ts
limitBody(
  body: ReadableStream<Uint8Array>,
  options: { maxSize: number },
): ReadableStream<Uint8Array>;
```

Wraps a request body in a byte-counting stream. Use it when a bounded body should remain streaming, for example when writing directly to `ctx.storage`.

```ts
if (!request.body) throw new HttpError(400, "Body is required");
const body = limitBody(request.body, { maxSize: 10 * 1024 * 1024 });
await ctx.storage.put(key, body, {
  contentType: request.headers.get("content-type") ?? undefined,
});
```

### `readJson()`

```ts
readJson<T = unknown>(request: Request, options?: BodyReadOptions): Promise<T>;
```

Buffers and parses a JSON body. Invalid JSON produces `400 Invalid JSON body`.

The generic type is a TypeScript assertion only; it does not validate runtime input.

```ts
const input = await readJson<{ count?: unknown }>(request, { maxSize: 16 * 1024 });
if (typeof input.count !== "number") {
  throw new HttpError(400, "count must be a number");
}
```

### `readForm()` and `FormValues`

```ts
readForm(request: Request, options?: BodyReadOptions): Promise<FormValues>;
```

Buffers and parses form data using the request's content type. Invalid form data produces `400 Invalid form body`.

```ts
const form = await readForm(request, { maxSize: 5 * 1024 * 1024 });
const title = form.text("title", { required: true });
const photo = form.file("photo", {
  required: true,
  accept: ["image/jpeg", "image/png"],
  maxSize: 4 * 1024 * 1024,
});
```

#### `FormValues.text()`

```ts
text(name: string, options?: { required?: boolean }): string | null;
```

- Missing and empty values return `null`, unless `required` is true.
- A required missing value produces `400 <name> is required`.
- A file value where text is expected produces `400 <name> must be text`.

#### `FormValues.file()`

```ts
interface FormFileOptions {
  required?: boolean;
  accept?: readonly string[];
  maxSize?: number;
}

file(name: string, options: FormFileOptions & { required: true }): File;
file(name: string, options?: FormFileOptions): File | null;
```

- Missing and empty files return `null`, unless `required` is true.
- Files over `maxSize` produce status `413`.
- Unsupported declared MIME types produce status `415`.
- `accept` supports exact MIME types and wildcards such as `image/*`.
- MIME types are client declarations, not proof of content. Validate file bytes when authenticity matters.

`readForm` buffers the complete body before parsing it. For large raw uploads, prefer `limitBody` and streaming object storage.

## Cookie helpers

The router provides serialization and parsing helpers, not session storage or authentication.

### Reading cookies

```ts
parseCookies(request: Request): Readonly<Record<string, string>>;
getCookie(request: Request, name: string): string | null;
```

```ts
const session = getCookie(request, "session");
```

Cookie values are URI-decoded when possible. For duplicate cookie names, the first value is retained.

### Serializing cookies

```ts
interface CookieOptions {
  domain?: string;
  path?: string;
  expires?: Date;
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "strict" | "lax" | "none";
}

serializeCookie(name: string, value: string, options?: CookieOptions): string;
```

```ts
const headers = new Headers();
headers.append(
  "set-cookie",
  serializeCookie("session", token, {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 3600,
  }),
);
```

Names and attributes containing unsafe separators or newlines are rejected. Values are URI-encoded.

### Deleting cookies

```ts
deleteCookie(
  name: string,
  options?: Omit<CookieOptions, "expires" | "maxAge">,
): string;
```

Returns a cookie string with an epoch expiration and `Max-Age=0`. Use the same `path` and `domain` as the original cookie.

## Router scope

`@nosrv/router` intentionally provides only HTTP dispatch and small Web API helpers.

It does not provide:

- an HTTP server or runtime adapter;
- database, KV, storage, secrets, or identity providers;
- sessions or an authentication system;
- schema validation;
- an ORM;
- provider deployment or infrastructure management.

Those concerns remain in the nosrv App contract, deployment target, or application code. See the [AI Application Specification](./ai-spec.md), [`ctx` API reference](./context-api.md), and [Router example](../examples/router/README.md).
