# nosrv AI Application Specification

This document is the canonical contract for AI-generated nosrv applications.

## Goal

Build small HTTP applications whose business logic can run unchanged on supported FaaS runtimes. Prefer portable Web APIs and nosrv capabilities over provider SDKs.

## Application contract

Export one app created with `defineApp`:

```ts
import { defineApp } from "@nosrv/core";

export default defineApp({
  async fetch(request, ctx) {
    return new Response("Hello from nosrv!");
  },
});
```

- Treat `request` as a Web Standard `Request`.
- Return a Web Standard `Response`.
- Use `URL`, `Headers`, `FormData`, `Blob`, streams, and Web Crypto when possible.
- Keep API endpoints under `/api` when the application also serves a frontend.

## Capabilities

Declare every required service and access it through `ctx`:

```ts
export default defineApp({
  requires: {
    db: true,
    storage: true,
  },
  async fetch(request, ctx) {
    // ctx.db and ctx.storage are typed here.
    // ctx.env, ctx.secrets, and ctx.user are always available.
  },
});
```

Available declared portable capabilities are `kv`, `storage`, and `db`. Read-only packaged resources are always available through `ctx.resources`, like `ctx.env`, `ctx.secrets`, and `ctx.user`.

Platform-managed integrations are declared by logical name in App code:

```ts
export default defineApp({
  requires: { tools: ["drive"] },
  async fetch(_request, ctx) {
    return Response.json(await ctx.tools.drive("search_files", { query: "report" }));
  },
});
```

The Platform resolves the logical tool group name to its provider, connection, credentials, and permitted operations. Tool group names must match a capability offered by the target Platform. MCP is currently a self-hosted Platform and Node runtime capability. Do not repeat tool declarations in `nosrv.yaml`; that file is reserved for deployment metadata that cannot be expressed by the App definition.

Before implementing Slack, Google Drive, Salesforce, or internal-service access, inspect the target Platform instead of guessing its tool contract:

```bash
nosrv tools list --json
```

Use only the returned logical group names, operation names, descriptions, and input schemas. The command is read-only and does not return provider URLs or credentials. Declare selected groups in `requires.tools`; do not copy the Platform catalog or connection configuration into `nosrv.yaml`.

See the [`ctx` API reference](./context-api.md) for the complete method signatures, return types, examples, and portability boundaries.

- The runtime or deployment target decides which values are available through `ctx.env` and `ctx.secrets`; App code does not declare their names.
- Do not import a cloud-provider database, KV, storage, or secrets SDK into portable application code.
- Read secrets with `ctx.secrets.get(name)`; it returns `null` when the deployment has not configured the value.
- Portable KV supports text and byte values through `get`, `set`, and `delete`. `set` accepts either `expirationTtl` in seconds or an absolute Unix-second `expiration`; the two options are mutually exclusive and expiration must be at least 60 seconds in the future.
- Enumerate KV keys with `list({ prefix, limit, cursor })`. A result contains keys, optional Unix-second expiration times, a completion flag, and an opaque provider cursor. Do not inspect cursors or assume a common key order across providers.
- Read a configured private resource with `await ctx.resources.get(path)`; it returns an immutable `Blob` or `null`. Resource paths are relative, use `/` separators, and may not contain `.` or `..` segments.
- `ctx.user` is always available. It contains a runtime-verified identity or `null` for an anonymous request and scheduled work.
- Use `ctx.waitUntil()` only for work the selected runtime may complete after the response.
- Use a provider-specific SDK only as an explicit escape hatch isolated behind a platform-specific module.
- Portable Artifacts reject direct imports of filesystem, process-spawning, raw-network, worker, VM, module-loader, and direct SQLite Node builtins. Use declared capabilities instead.
- The self-hosted Platform also starts portable Apps with the Node.js Permission Model. It grants read access to the App and nosrv runtime files plus read/write access to that App's data directory, while leaving child processes, workers, native addons, and WASI disabled. Network access remains available so the App can serve requests and use portable network-backed capabilities. Public-cloud targets apply their own runtime and IAM controls instead.
- Host filesystem access is declared with `permissions.filesystem.read` and `permissions.filesystem.write`; child process execution is declared with `permissions.childProcess: true`; `permissions: "*"` is reserved for fully trusted administration Apps.

## Initialization

Use the optional `initialize(ctx)` hook for short setup that needs runtime capabilities:

```ts
export default defineApp({
  requires: { db: true },
  async initialize(ctx) {
    await ctx.db.ensureTable("items", {
      id: { type: "text", primaryKey: true },
      title: { type: "text", required: true },
    });
  },
  async fetch(request, ctx) {
    return Response.json(await ctx.db.select("items"));
  },
});
```

- A runtime instance completes initialization before its first `fetch` or `scheduled` invocation. Concurrent first invocations share the same initialization promise.
- A failed initialization is retried by the next invocation.
- Cloud runtimes may start multiple isolates, containers, or processes, so initialization must be short and idempotent. It is not a globally once-only migration mechanism.

## Routing and HTTP

Small applications may implement `fetch` directly. Use the Router API exported from `@nosrv/core` when multiple routes, parameters, middleware, or body helpers improve clarity.

See the [Router API reference](./router-api.md) for the complete route, middleware, mounting, body, response, and cookie helper contracts.

```ts
import { defineApp } from "@nosrv/core";
import { createRouter, readJson } from "@nosrv/core";

const requires = { db: true } as const;
const router = createRouter<typeof requires>();

router.post("/api/items", async ({ request, ctx }) => {
  const input = await readJson<{ title?: unknown }>(request, { maxSize: 64 * 1024 });
  if (typeof input.title !== "string") {
    return Response.json({ error: "title is required" }, { status: 400 });
  }
  await ctx.db.insert("items", { id: crypto.randomUUID(), title: input.title });
  return Response.json({ ok: true }, { status: 201 });
});

export default defineApp({
  requires,
  fetch: router,
});
```

`defineApp` owns the App contract, including capabilities, initialization, and scheduled work. A router only implements HTTP dispatch for `fetch`; using a shared `requires` constant keeps route contexts typed without repeating the declaration. Keep the explicit `fetch` function when request-wide behavior must run before or after router dispatch.

When routes live in a typed registration function, `createRouter(registerRoutes)` infers its capability context from that function. A router is itself a fetch handler, so the App can use `fetch: router` directly.

- Validate runtime input explicitly; TypeScript generic arguments do not validate JSON.
- Use parameterized database queries.
- Apply upload size limits and validate actual file content when format authenticity matters. MIME types are declarations, not proof.
- `readJson` and `readForm` accept `maxSize`; use `limitBody` when streaming a bounded raw body into storage.
- Use `router.mount(prefix, app)` to compose an App or sub-router. Mounted Apps receive the path with the prefix removed, and the runtime validates their declared capabilities before dispatch.
- Routes, middleware, and mounts run in registration order. Put public routes before an authentication middleware and protected routes after it; the first matching route or mount that returns a response ends dispatch.
- Use `router.use(path?, ...middleware)` to scope middleware to a path subtree. Middleware may `await next()` to process the downstream response; route methods also accept multiple middleware-style handlers.
- Use `ctx.db.ensureTable`, `ensureIndex`, `insert`, `insertMany`, `upsert`, `select`, `count`, `exists`, `update`, `delete`, and `transaction` for portable relational work. Use `select({ fields: [...] })` to project only the required columns and `limit` plus `offset` or ordered comparison conditions for pagination. Portable columns are `text`, `number`, `integer`, `boolean`, `bytes`, and `timestamp`; timestamp values are ISO 8601 strings.
- Structured conditions support equality plus `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `in`, and `notIn`. Use non-empty `$and` and `$or` arrays for grouped conditions. Portable mutations reject empty `where` objects. Table and column identifiers are validated rather than interpolated unchecked.
- `ensureTable` creates missing tables and rejects incompatible existing column, type, required, primary-key, or unique-constraint definitions; it does not perform migrations. `ensureIndex` creates a named index and rejects a conflicting definition. Transactions are atomic on SQLite and PostgreSQL; D1 rejects them because this API does not expose D1 Sessions or Durable Objects.
- Use `ctx.db.currentTimestamp()` when distributed coordination needs the database server's shared clock instead of an individual runtime instance's clock.
- Use `ctx.db.sql.query()` and `ctx.db.sql.execute()` only as an explicit SQL escape hatch. Ordered parameters use `?` on every provider, but SQL syntax, schema portability, and result normalization are then App responsibilities.
- Cookie helpers serialize and parse HTTP cookies; session storage and authentication remain application or service concerns.

## Scheduled tasks

Add `scheduled(event, ctx)` when an application needs cron-triggered work:

```ts
export default defineApp({
  fetch() {
    return new Response("OK");
  },
  async scheduled(event, ctx) {
    ctx.log.info("Scheduled task", { name: event.name });
  },
});
```

Declare named five-field cron expressions in `nosrv.yaml`:

```yaml
timezone: Asia/Tokyo # Optional; applies to every schedule.
schedules:
  - name: daily-cleanup
    cron: "0 3 * * *"
```

- Make work idempotent: providers may duplicate a trigger, and the Node.js MVP may miss one while an App is stopped.
- `timezone` accepts an IANA time-zone identifier. When omitted, Node.js and nosrv Platform use the runtime process or OS local time zone. Specify `UTC` when UTC behavior must be portable and explicit. Some public-cloud schedulers cannot apply an App-specific time zone.
- Portable schedules use five standard cron fields with numeric values, `*`, lists, ranges, and steps; English month and weekday names are also accepted. Schedule names and normalized cron expressions must be unique within an App.
- Keep scheduled work short; do not use it as a long-running worker.
- `ctx.user` is `null` in a scheduled handler because there is no request identity.
- Use the same declared capabilities as HTTP handlers.

## Configuration

Use `nosrv.yaml` for the entrypoint, local server, SPA behavior, and target-specific providers:

```yaml
name: my-app
app: ./src/app.ts
route: /my-app

dev:
  host: 127.0.0.1
  port: 8787
```

`name` is the common deployment name. Optional `route` is the App's requested path on nosrv
Platform and is preserved in the Artifact. The Platform normalizes and validates it, rejects the
root, reserved control-plane paths, and collisions with another App. When omitted, a new App uses
`/apps/<APP_NAME>`; redeploying an existing App preserves its current route. Platform destination
URLs and credentials are operator environment state and do not belong in `nosrv.yaml`.

Files in the fixed `resources/` directory are packaged with the App but never served as public assets. Use it for private JSON, templates, dictionaries, and other deployment-time data:

```ts
const resource = await ctx.resources.get("prompts/system.txt");
if (!resource) return new Response("Missing resource", { status: 500 });
const prompt = await resource.text();
```

Use `ctx.storage`, `ctx.kv`, or `ctx.db` instead when data must change at runtime, and use `ctx.secrets` for credentials or other secret values.

Add optional human-facing metadata when an App will appear in a catalog or Platform UI:

```yaml
meta:
  description: Save photos with short diary entries.
  icon: 📷
```

`meta.icon` may be an emoji or an absolute App-local PNG path such as `/icon.png`. Put image files in the App's public directory. Metadata is preserved in Artifacts; it does not affect the deployment name or route.

Host-specific access is declared with top-level `permissions`. Filesystem access is self-hosted-only and every path must be absolute:

```yaml
permissions:
  filesystem:
    read:
      - /srv/reports
    write:
      - /srv/reports/generated
```

The Platform keeps the Node.js Permission Model enabled, adds only the declared paths, and continues to deny child processes, workers, native addons, WASI, and the inspector. Declaring filesystem access permits bundling `node:fs`, but runtime operations outside the listed paths still fail. Apps with host permissions can run only on Node.js or nosrv Platform and cannot deploy to public-cloud targets.

A fully trusted administration App may request every host permission:

```yaml
permissions: "*"
```

This disables the Node.js Permission Model for that App, exposes the trusted Platform environment, and is equivalent to granting the App the Platform user's host access. The Platform must enable unrestricted Apps with `allowUnrestrictedApps: true` in its configuration. Use it only when narrower permissions cannot express the requirement.

Authentication and access policy belong to the deployment target, not `nosrv.yaml`. Application code always receives `ctx.user` as either a normalized verified identity with an `id` and optional `email`, `name`, and `thumbnail`, or `null`. A self-hosted Platform configured with local authentication or OIDC authenticates App requests and applies Platform-wide and App-specific access policies. Other deployment targets may supply identity through their own verified request integration.

The intentionally verbose [`../examples/full-config/nosrv.yaml`](../examples/full-config/nosrv.yaml) is the runnable configuration reference. Do not copy every setting into an App; keep only values that differ from the defaults or select external resources.

For a client-side-routed SPA:

```yaml
spa: true
```

SPA fallback occurs only for HTML navigation after the application returns 404. API requests keep their normal responses.

Select providers under `providers.<target>` and keep provider details out of application source.

The standard provider for a target may omit its `provider` field. Cloudflare defaults to D1, Workers KV, and R2; Google Functions defaults to PostgreSQL, Firestore, and GCS; Lambda defaults to PostgreSQL, DynamoDB, and S3. Node defaults to SQLite for database and KV and filesystem storage. The self-hosted Platform chooses providers globally: its one-node development defaults use SQLite and filesystem storage, while replicated installations use PostgreSQL, Redis, and either S3 or GCS. When `provider` is present, nosrv honors it and rejects unsupported selections rather than silently falling back.

Standalone Node.js development can select PostgreSQL without putting its connection URL in configuration:

```yaml
providers:
  node:
    db:
      provider: postgres
      urlEnv: DATABASE_URL
      appId: my-app
```

`urlEnv` defaults to `DATABASE_URL`. The selected environment value is treated as runtime-owned configuration and is hidden from `ctx.env`. `appId` selects the isolated PostgreSQL schema and defaults to the App name.

Local `ctx.kv` persists to `.nosrv/kv.sqlite`. nosrv does not expose a disposable in-memory KV provider; code using the runtime as a library may inject another `KV` implementation explicitly.

The Deployment Target is selected outside application code. It may be a Standalone Server, a public FaaS provider, or a self-hosted nosrv Platform. See the [nosrv Platform documentation](https://github.com/asaday/nosrv-platform/blob/main/docs/platform.md) for the shared deployment and platform terminology.

## Frontend selection

- Default to the generated HTML, CSS, and JavaScript template for small applications.
- A directory containing `index.html` can be developed and deployed without `nosrv.yaml` or an application handler; it is treated as a static site.
- In that implicit static mode, nosrv publishes browser-facing root files but excludes private `resources/`, server-oriented `src/`, dependency and generated directories, and `.env` files at every depth. Use an explicit `public/` directory when the intended public boundary is not obvious.
- A root `app.ts` is the smallest handler-based layout. Use `src/app.ts` when an App grows beyond a single source file. Both are discovered automatically, and a sibling `public/` directory needs no `nosrv.yaml`.
- In implicit static mode, a root `app.js` is a browser asset. Put a handler under `src/app.*` or declare `app` explicitly.
- Put public static files such as HTML, JavaScript, CSS, images, PDFs, media, or JSON in the fixed `public/` directory.
- Put immutable private files in the fixed `resources/` directory and read them through `ctx.resources`.
- Add a frontend framework only when UI complexity justifies its build and dependency cost.
- React and Vite are supported as an optional example and template; they are not runtime requirements.
- Keep the frontend replaceable by communicating with the backend through HTTP APIs.
- Use relative browser URLs such as `./app.js` and `api/items`; root-absolute `/app.js` and `/api/items` bypass an App's Platform route prefix.

## Workflow

For a new project:

```bash
nosrv create my-app
cd my-app
npm install
nosrv dev
```

Use `--template react` only when requested or clearly justified.

Before finishing a change:

1. Run the relevant application or provider tests.
2. Run `npm run typecheck` when the workspace provides it.
3. Exercise important HTTP routes, including failure responses.
4. For a frontend build, run its production build and test a direct SPA navigation.
5. Check that application code remains free of accidental provider coupling.

Normally deploy directly; the deploy command performs its target-specific build internally:

```bash
NOSRV_PLATFORM_URL="..." NOSRV_TOKEN="issued-personal-token" nosrv deploy
nosrv deploy --target cloudflare
nosrv deploy --target azure --dry-run
```

Use `nosrv build` and `nosrv run .nosrv/build` only when an Artifact must be inspected, verified, or tested explicitly. Do not edit generated Artifact files.

Deploy a selected Cloudflare target with:

```bash
nosrv deploy --target cloudflare
```

Use `--dry-run` to validate generated deployment artifacts without publishing. Google HTTP deployment delegates to `gcloud`; Lambda HTTP deployment delegates to AWS SAM. Cloud Scheduler and EventBridge provisioning for `scheduled()` are not yet automated.

For those targets, follow [`deployment.md`](deployment.md): nosrv generates staging files and delegates Google deployment to `gcloud` and Lambda infrastructure deployment to AWS SAM rather than reimplementing cloud deployment APIs.

## Non-goals

Do not imitate every feature of a full-stack framework. nosrv does not provide SSR, a component framework, an ORM, session management, or a universal abstraction for every cloud feature.
