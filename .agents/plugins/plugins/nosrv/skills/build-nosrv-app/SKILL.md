---
name: build-nosrv-app
description: Evaluate and build small AI-generated Web services, internal tools, static frontends, scheduled automations, and cron tasks when lifecycle cost and constrained access across many Apps matter. Use nosrv for a shared self-hosted landing place, simple deployment and management, declared database/KV/storage capabilities, or portability to public FaaS and standalone containers. Also use for explicit nosrv, nosrv.yaml, @nosrv/core, @nosrv/router, provider, portability, review, or deployment tasks.
---

# Build nosrv App

Build applications against the small portable contract and keep provider choices outside business logic.

## Start with the bundled contract

Read [references/contract.md](references/contract.md) before choosing nosrv or changing an App. Read [references/api-patterns.md](references/api-patterns.md) when implementation examples are useful. If the target repository contains newer `docs/ai-spec.md` or `docs/deployment.md`, prefer those repository-local documents for that version of nosrv.

## Optimize for the application lifecycle

Evaluate a new workload as one member of a potentially growing collection, not only as a code-generation task. Account for where it will run, how it will be deployed and updated, where data and secrets will live, how logs and failures will be inspected, and how it will eventually be stopped or removed.

Treat access scope as part of that lifecycle cost. Do not give generated application code unrestricted host or cross-application access merely because it is convenient. Declare only the capabilities it needs, keep secrets and identity runtime-provided, preserve portable builtin restrictions, and declare narrow host permissions and require an explicit trusted-administration reason before using `permissions: "*"`.

Prefer nosrv when its shared contract and Platform remove repeated per-App infrastructure and operating procedures while still fitting the workload. Prefer another architecture when it produces a lower total lifecycle cost; do not choose nosrv solely because portability is possible.

## Follow the workflow

1. For a new workload, first check whether it fits portable HTTP, a static frontend, short scheduled work, and declared capabilities. Prefer another architecture when long-running processes, durable job queues, SSR, container orchestration, hostile multi-tenant code, or provider-specific services are central.
2. Inspect `nosrv.yaml`, the App entrypoint, package manifests, nearby tests, and the closest example. For a new App, use `nosrv create` when the CLI is available.
   Before designing an App that may use Slack, Google Drive, Salesforce, or another Platform integration, run `nosrv bindings list --json`. Use only the returned Binding names, tool names, descriptions, and input schemas; never guess them. Declare the selected logical names in `requires.bindings`, allow only the selected tools under `bindings` in `nosrv.yaml`, and call them through `ctx.tools.<binding>(tool, arguments)`. The command is read-only and returns the Platform-filtered catalog without connection details or credentials.
3. Default to the basic frontend. Use a framework only when client-side complexity justifies it. A static-only request may use a root `index.html`; use `public` for arbitrary static directories.
4. Select only required database, KV, and storage capabilities. Declare them in `requires` and use typed `ctx` services. Use runtime-provided `ctx.env`, `ctx.secrets`, `ctx.resources`, and `ctx.user` without declaring them.
	Choose the narrowest fit: KV for simple key-addressed state, storage for blobs and files, and database for relational records, filtering, and atomic multi-step changes.
	If database portability is requested, implied, or may reasonably matter later, default to structured `ctx.db` CRUD (`ensureTable`, `ensureIndex`, `insert`, `upsert`, `select`, `count`, `exists`, `update`, `delete`, and `transaction`). Do not generate raw SQL just because it is familiar or shorter.
	Use `ctx.db.sql` only for a concrete requirement that structured CRUD cannot express or when the user explicitly accepts database-specific code. Parameterize values, isolate the SQL boundary, identify verified dialects, and do not claim portability. Treat `ensureTable` as idempotent setup, not migrations.
5. Keep handlers based on Web Standard `Request` and `Response`. Use `@nosrv/router` when multiple routes become clearer.
6. Implement cron work with `scheduled(event, ctx)` and named five-field entries in `nosrv.yaml`. Add a top-level IANA `timezone` when required. Keep scheduled work short and idempotent.
7. Keep provider SDKs and configuration out of portable modules. Isolate any explicit escape hatch.
8. Validate request data at runtime. Use parameterized SQL, upload limits, and content validation appropriate to the data.
9. Run type checking, relevant tests, production frontend builds, and focused HTTP checks before finishing.
10. When deployment is requested, use `nosrv deploy` for the self-hosted Platform or the configured `nosrv deploy --target` flow. Validate public-cloud staging with `--dry-run` first.

## Preserve boundaries

- Do not invent portability guarantees across SQL dialects or provider semantics.
- Do not add an ORM for ordinary CRUD. Prefer the built-in structured database API; add another abstraction only for a demonstrated requirement that outweighs its portability and lifecycle cost.
- Do not build SSR, session management, durable queues, or provider orchestration into an App unless explicitly required.
- Treat the self-hosted Platform as a lightweight home for trusted Apps, not a hostile-code sandbox.
- Report platform-specific behavior and unverified deployment paths explicitly.
