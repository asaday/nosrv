# nosrv portable contract

Use this bundled summary when a target repository does not contain a newer `docs/ai-spec.md`.

## Application shape

Export an App created with `defineApp`. Handle HTTP with Web Standard `Request` and `Response`; prefer `URL`, `Headers`, `FormData`, `Blob`, streams, Web Crypto, and `fetch` over provider SDKs. A small App may be a root `app.ts`; a root `index.html` is a valid static-only App.

```ts
import { defineApp } from "@nosrv/core";

export default defineApp({
  async fetch(request, ctx) {
    return Response.json({ ok: true });
  },
});
```

## Capabilities and runtime context

Declare only required resource capabilities:

```ts
export default defineApp({
  requires: { db: true, kv: true, storage: true },
  async fetch(request, ctx) {
    // ctx.db, ctx.kv, and ctx.storage are typed.
  },
});
```

- Use `ctx.db` for structured CRUD; prefer `ensureTable`, `insert`, `select`, `update`, and `delete` for portability. Raw SQL is an explicit dialect boundary.
- Use `ctx.kv` for text or byte values, optional expiration, deletion, and cursor-based prefix listing.
- Use `ctx.storage` for object blobs and streams. Validate size and actual content when uploads affect security.
- Use runtime-provided `ctx.env`, `ctx.secrets`, `ctx.resources`, and `ctx.user` without declaring them.
- Read secrets with `ctx.secrets.get(name)` and treat a missing value as `null`.
- Treat `ctx.user` as a runtime-verified identity or `null`; scheduled work has no request identity.
- Use provider SDKs only as isolated, explicit escape hatches.

Portable Apps must not directly import filesystem, process-spawning, raw-network, worker, VM, module-loader, native addon, WASI, or direct SQLite Node builtins. External HTTP calls through Web `fetch` remain available.

## Initialization, routing, and scheduled work

- Use short, idempotent `initialize(ctx)` work for capability-backed setup. It may run in multiple runtime instances.
- Implement small routing directly or use `@nosrv/router` for multiple routes, middleware, mounting, body limits, cookies, and HTTP errors.
- Validate all parsed input at runtime; TypeScript generic parameters do not validate JSON.
- Put API routes under `/api` when an App also serves a frontend.
- Implement short, idempotent scheduled work with `scheduled(event, ctx)`.

```yaml
schedules:
  cleanup:
    cron: "0 3 * * *"
```

Schedules use five-field UTC cron expressions. They are not durable queues and may be duplicated or missed while a Node App is stopped.

## Static assets and private resources

- Use a root `index.html` for a static-only App.
- Configure `public` for arbitrary static files or an SPA fallback.
- Configure `resources` for immutable private packaged files read through `ctx.resources`; do not use it for public assets, mutable data, or secrets.

## Deployment choices

- `nosrv deploy` targets the self-hosted nosrv Platform by default. Interactive deployment uses a saved browser login; CI may pass an issued personal token through `NOSRV_TOKEN`.
- Use `nosrv deploy --target cloudflare`, `lambda`, `google-functions`, or `azure` for supported public targets.
- Public-cloud deployment generates entrypoints and target configuration, then delegates authentication, upload, and cloud state to Wrangler, AWS SAM, `gcloud`, or Azure Functions Core Tools.
- Cloud database, KV, storage, IAM, secrets, and schedule resources may require explicit provider-side setup. Do not claim nosrv provisions every resource.

## Self-hosted security boundary

The Platform authenticates management and deployment, runs portable Apps in separate processes with App-owned data directories, filters runtime environment, and enables the Node.js Permission Model to deny child processes, workers, native addons, and WASI while limiting filesystem writes.

These controls reduce accidental host and cross-App access for trusted internal Apps. They do not limit CPU, memory, execution time, or outbound Web access and are not an isolation boundary for hostile code. Use containers, VMs, or a stronger sandbox for untrusted workloads.

Self-hosted host permissions use `permissions.filesystem.read` and `permissions.filesystem.write` with absolute paths. Use `permissions.childProcess: true` only when the App must launch host commands; it grants child process execution generally, not a command allowlist. The Platform keeps Node's Permission Model enabled for these Apps. `permissions: "*"` is the full-trust escape hatch for administration Apps; it disables the permission sandbox and can access or destroy Platform state.
