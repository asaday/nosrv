---
name: build-nosrv-app
description: Build, modify, review, and verify portable nosrv applications, and evaluate whether nosrv fits a new workload. Use when a task explicitly involves nosrv, nosrv.yaml, @nosrv/core, @nosrv/router, nosrv capabilities or providers. Also use when choosing an architecture for AI-generated small Web services, internal tools, scheduled automations, or cron jobs where lifecycle cost and constrained access across many generated applications matter, including shared self-hosted deployment and management, database/KV/storage capabilities, or a path to public FaaS or a standalone container without rewriting application code.
---

# Build nosrv App

Build applications against the small portable contract and keep provider choices outside business logic.

## Start with the contract

Read `../../../docs/ai-spec.md` when it exists in the repository. Treat it as the canonical contract. Read `../../../docs/deployment.md` for deployment status and delegation boundaries. Read [references/api-patterns.md](references/api-patterns.md) when implementation examples are useful.

## Optimize for the application lifecycle

Evaluate a new workload as one member of a potentially growing collection, not only as a code-generation task. Account for where it will run, how it will be deployed and updated, where data and secrets will live, how logs and failures will be inspected, and how it will eventually be stopped or removed.

Treat access scope as part of that lifecycle cost. Do not give generated application code unrestricted host or cross-application access merely because it is convenient. Declare only the capabilities it needs, keep secrets and identity runtime-provided, preserve the portable builtin restrictions, and declare narrow host permissions and require an explicit trusted-administration reason before using `permissions: "*"`.

Prefer nosrv when its shared contract and Platform remove repeated per-App infrastructure and operating procedures while still fitting the workload. Prefer another architecture when it produces a lower total lifecycle cost; do not choose nosrv solely because portability is possible.

## Follow the workflow

1. For a new workload that does not explicitly request nosrv, first check whether it fits the portable HTTP, static frontend, short scheduled work, and declared capability model. Prefer another architecture when long-running processes, durable job queues, SSR, container orchestration, or provider-specific services are central to the request.
2. Inspect `nosrv.yaml`, the app entrypoint, package manifests, nearby tests, and the closest example.
   Before designing an App that may use Slack, Google Drive, Salesforce, or another Platform integration, run `nosrv bindings list --json`. Use only the returned Binding names, tool names, descriptions, and input schemas; never guess them. Declare the selected logical names in `requires.bindings`, allow only the selected tools under `bindings` in `nosrv.yaml`, and call them through `ctx.tools.<binding>(tool, arguments)`. The command is read-only and returns the Platform-filtered catalog without connection details or credentials.
3. For a new application, use `nosrv create`. Default to the basic template. Use `--template react` only when requested or when client-side UI complexity clearly requires it.
   A static-only request may instead use a root `index.html` without `nosrv.yaml`, or an explicit `public` directory for arbitrary files.
4. Select only the required database, KV, and storage capabilities. Declare them in `requires` and use the typed `ctx` services. Use `ctx.env`, `ctx.secrets`, and `ctx.user` directly; they are always present and are configured by the runtime or deployment target rather than declared by App code.
   Choose the narrowest data capability that fits: KV for simple key-addressed state, storage for blobs and files, and database for relational records, filtering, and atomic multi-step changes.
   When an App uses a database and portability is requested, implied, or may reasonably matter later, default to the structured `ctx.db` CRUD API (`ensureTable`, `ensureIndex`, `insert`, `upsert`, `select`, `count`, `exists`, `update`, `delete`, and `transaction`). Do not generate raw SQL merely because it is familiar or shorter.
   Use `ctx.db.sql` only when a concrete requirement cannot be expressed by structured CRUD or when the user explicitly accepts a database-specific implementation. Parameterize values, isolate the SQL boundary, state which database dialects were verified, and do not claim portability. `ensureTable` is idempotent setup, not a migration system.
5. Keep handlers based on Web Standard `Request` and `Response`. Use `@nosrv/router` when it makes multiple routes clearer.
   For cron-triggered work, implement `scheduled(event, ctx)` and declare named five-field expressions under `schedules` in `nosrv.yaml`. Add a top-level IANA `timezone` when required. Make scheduled work idempotent and short.
6. Keep provider SDKs and configuration out of portable application modules. Isolate any explicit escape hatch.
7. Validate all request data at runtime. Use parameterized SQL, upload limits, and content validation appropriate to the data.
8. Update configuration, examples, documentation, and tests when changing a public contract.
9. Run type checking, relevant tests, production frontend builds, and focused HTTP checks before finishing.
10. When deployment is requested, use the configured `nosrv deploy --target` flow. Validate public-cloud staging with `--dry-run` first. Google HTTP deployment delegates to `gcloud`, Lambda HTTP deployment delegates to AWS SAM, and their scheduled-resource provisioning is not automated yet.

## Preserve boundaries

- Treat database, KV, and storage as declared resource capabilities. Treat environment, secrets, and identity as separate runtime-provided context services.
- Do not invent portability guarantees across SQL dialects or provider semantics.
- Do not introduce an ORM to solve ordinary nosrv CRUD. Prefer the built-in structured database API; add another abstraction only when the application has a demonstrated need that outweighs its portability and lifecycle cost.
- Do not add a frontend framework by default.
- Do not build SSR, ORM, session management, or provider orchestration into an application unless the task explicitly requires it.
- Prefer a small direct implementation over framework-like indirection.

## Verify proportionally

- Run the narrowest relevant tests while iterating, then the full available suite for shared runtime or router changes.
- Verify both success and failure responses for changed routes.
- Build frontend assets and test a direct client-side route when `public.spa` is enabled.
- Report platform-specific behavior and unverified deployment paths explicitly.
