# nosrv

**Small Apps should not become separate operations.**

A small Web App can be easy to build and easy to run. Operating it still requires decisions about its route, process, persistent data, secrets, identity, permissions, logs, updates, rollback, and eventual removal. None of these decisions is difficult on its own.

The problem is that they do not disappear after deployment. When every App brings its own container or process setup, data layout, access model, and operating procedure, those differences accumulate with the Apps:

- operators must remember how each App is started, inspected, updated, restored, and stopped;
- data, secrets, logs, and backups end up in App-specific places;
- the App author's implementation choices become production access and security policy;
- combining Apps avoids repeated setup but also combines dependencies, permissions, failures, and release cycles.

Docker, systemd, PaaS, and public FaaS can each run an individual App well. The missing layer is a common way to accept many small Apps while keeping them separate. nosrv moves that boundary to the receiving platform instead of asking every App author to design it again.

nosrv is a self-host-first application platform for small Web services, internal tools, static frontends, and scheduled automations:

- **Keep Apps separate.** Each App is deployed as a versioned Artifact and runs as its own supervised process with App-owned data areas.
- **Standardize the outside.** The Platform manages routes, processes, persistent capabilities, schedules, secrets, logs, versions, rollback, and removal through one operating model.
- **Constrain the inside.** Apps use Web Standard `Request` and `Response`, declare only the database, KV, and storage capabilities they need, and receive environment, secrets, and verified identity through runtime-controlled context.
- **Keep an exit.** The same contract can run on standalone Node.js or deploy to supported public FaaS targets without rewriting the HTTP application around a provider SDK.

Self-hosting is the normal operating model; public FaaS support keeps the application contract honest. It demonstrates that `defineApp` and `ctx` describe a portable boundary rather than hidden Platform behavior, while giving an App a practical migration path when its scale, ownership, or deployment requirements change.

This is not a promise that every provider is identical. SQL dialects, storage semantics, scaling behavior, identity, and cloud resource provisioning still belong to each target. nosrv reduces the application code coupled to those choices and delegates cloud authentication and deployment state to each provider's official CLI.

Portable Apps run with restricted Node.js permissions on the self-hosted Platform instead of broad host access. Explicit host permissions remain available for trusted administration Apps. These are practical guardrails for trusted applications, not a sandbox for hostile code; use containers, VMs, or stronger isolation for untrusted workloads.

A **nosrv App** is usually a small TypeScript entrypoint with optional static files and `nosrv.yaml`. It exports a Web Standard HTTP handler, may export short scheduled work, and keeps provider choices outside its business logic. This repository includes that contract, the development and deployment CLI, and adapters for several execution targets.

## Self-host it

The self-hosted Platform and Studio are maintained in the separate `nosrv-platform` repository. This repository contains the portable App contract, CLI, runtimes, adapters, providers, examples, and npm release tooling.

Maintainers can follow the [npm release procedure](docs/releasing.md) to version, verify, and publish the synchronized package set.

## When to use nosrv

Use it when:

- AI is producing more small Web services and scheduled automations than the team wants to configure and operate individually;
- multiple trusted internal applications should share one lightweight deployment and management environment;
- application execution and persistent data should stay on operator-controlled infrastructure;
- a small TypeScript web application should not be tied to one execution environment;
- the application may move between local Node.js, a public FaaS provider, and a self-hosted Platform;
- the application should be easy to start now and straightforward to move into a container or more specialized infrastructure later;
- application code needs portable database, KV, storage, secrets, or user access;
- an AI coding agent benefits from a small explicit application contract.

Do not use it when:

- the application requires long-running processes, SSR, or container orchestration;
- most business logic depends on provider-specific services or semantics;
- a mature production framework and deployment ecosystem is required today.

## Current support

| Feature              | Local Node.js        | Self-hosted Platform                | Cloudflare Workers    | AWS Lambda                     | Google Functions    | Azure Functions          |
| -------------------- | -------------------- | ----------------------------------- | --------------------- | ------------------------------ | ------------------- | ------------------------ |
| HTTP runtime         | ✅                   | ✅                                  | ✅                    | ✅                             | ✅                  | ✅                       |
| Static files / SPA   | Filesystem           | Packaged assets                     | Workers Static Assets | Packaged assets                | Packaged assets     | Packaged assets          |
| Database             | SQLite or PostgreSQL | SQLite per app or shared PostgreSQL | D1                    | PostgreSQL                     | PostgreSQL          | PostgreSQL               |
| KV                   | SQLite               | SQLite per app or shared Redis      | Workers KV            | DynamoDB                       | Firestore           | Cosmos DB                |
| Object storage       | Filesystem           | Filesystem per app or shared S3/GCS | R2                    | S3                             | GCS                 | Blob Storage             |
| Secrets              | Environment / `.env` | Encrypted per-App or shared secrets | Wrangler bindings     | Environment                    | Environment         | App settings / Key Vault |
| Verified user hook   | Resolver             | Local/OIDC session                  | Resolver              | API Gateway claims or resolver | Resolver            | Adapter resolver         |
| CLI development      | ✅                   | Docker or local Node                | ✅                    | HTTP API v2 emulator           | Functions Framework | —                        |
| Automated deployment | —                    | ✅ authenticated upload             | ✅ Wrangler           | ✅ AWS SAM                     | ✅ gcloud           | ✅ Functions Core Tools  |

The application model is the center of nosrv. Local Node.js, public-cloud adapters, and the self-hosted Platform are execution environments for that model. Public-cloud deployment generates target configuration and delegates authentication, upload, and infrastructure state to Wrangler, `gcloud`, AWS SAM, or Azure Functions Core Tools.

See [`docs/deployment.md`](docs/deployment.md) for the implemented deployment flows and delegation boundaries.

nosrv applications may run as standalone Node.js servers or be deployed to a self-hosted **nosrv Platform** that manages multiple applications. In the Platform architecture, a **Runtime Host** starts and supervises application processes; it is not called a runner. See the [nosrv Platform documentation](https://github.com/asaday/nosrv-platform/blob/main/docs/platform.md) for the shared terminology and architecture.

## Quick start

From this repository:

```bash
npm install
cd examples/hello
npx nosrv dev
```

Open <http://127.0.0.1:8787> or run:

```bash
curl http://127.0.0.1:8787/hello
```

Create a project with the published CLI:

```bash
npx nosrv create my-app
cd my-app
npm install
npx nosrv dev
npx nosrv deploy --target cloudflare
```

Pin a version for repeatable use:

```bash
npx nosrv@0.1.1 create my-app
```

The generated project contains an `AGENTS.md` with the essential portability rules.

## Application contract

For a small, single-file App, create `app.ts` in the project root:

```ts
import { defineApp } from "@nosrv/core";

export default defineApp({
  async fetch(request, ctx) {
    ctx.log.info("Request received");
    return new Response("Hello from nosrv!");
  },
});
```

An optional `nosrv.yaml` selects the entrypoint and local address:

```yaml
app: ./app.ts

dev:
  host: 127.0.0.1
  port: 8787
```

CLI options override configuration:

```bash
npx nosrv dev --host 0.0.0.0 --port 3000
```

See [`examples/full-config/nosrv.yaml`](examples/full-config/nosrv.yaml) for an intentionally verbose, runnable reference containing representative application, provider, schedule, and deployment settings. Normal Apps should keep only values that differ from the defaults.

No configuration is required for either `app.ts` or `src/app.ts`. Keep a small App at the root, and move it under `src/` as its source tree grows. A sibling `public/` directory is discovered automatically in both layouts:

```text
app.ts
```

```text
src/
└── app.ts
public/
```

## Portable context and capabilities

`ctx.env`, `ctx.secrets`, `ctx.resources`, and `ctx.user` are always available. The runtime or deployment target decides which environment values and secrets exist; non-secret string defaults may be declared under `env` in `nosrv.yaml`, and `ctx.secrets.get(name)` returns `null` when a value is not configured. Files under the conventional `resources/` directory are packaged as immutable private resources; `ctx.resources.get(path)` returns a file as a `Blob` or `null` without publishing it as a browser asset. `ctx.user` contains a runtime-verified `User` or `null`; use `auth.mode` in `nosrv.yaml` when a deployment must reject anonymous requests. Scheduled handlers receive `ctx.user` as `null`.

See the [`ctx` API reference](docs/context-api.md) for the complete context, capability methods, return types, examples, and portability boundaries.

Database, KV, and object storage are resource capabilities. Declare only the services the App requires; the corresponding typed service then becomes available on `ctx`:

Portable KV provides `get`, `set`, `delete`, and cursor-based `list`. Values may be text or bytes. `set` can use a relative `expirationTtl` or absolute Unix-second `expiration`, with a portable minimum of 60 seconds. `list` supports `prefix`, `limit`, and an opaque provider cursor; key ordering is not portable across providers.

```ts
export default defineApp({
  requires: { storage: true },
  async fetch(request, ctx) {
    const token = await ctx.secrets.get("API_TOKEN");
    await ctx.storage.put("hello.txt", "Hello", { contentType: "text/plain" });
    return Response.json({ saved: true, configured: token !== null });
  },
});
```

Use `initialize(ctx)` for short, idempotent setup that needs capabilities, such as `ctx.db.ensureTable()`. Each runtime instance completes it before its first application request or scheduled invocation; cloud scaling can run it in more than one instance.

Provider selection stays in `nosrv.yaml`, outside application logic:

Each target supplies its standard provider when `provider` is omitted. Specify `provider` only when selecting a non-default supported option; an explicit value always takes precedence and unsupported values are rejected.

```yaml
providers:
  node:
    storage:
      provider: filesystem
      directory: .nosrv/storage

  cloudflare:
    storage:
      bucket: my-r2-bucket

  lambda:
    storage:
      bucket: my-s3-bucket

  google-functions:
    storage:
      bucket: my-gcs-bucket
```

R2 bindings are generated for Cloudflare development. S3 uses the AWS SDK credential chain, and GCS uses Google Application Default Credentials.

### Database

`ctx.db` provides portable CRUD, field projection and pagination, grouped conditions, count and existence checks, bulk inserts, indexes, upserts, schema compatibility checks, composite unique constraints, and transactions for common relational work:

```ts
export default defineApp({
  requires: { db: true },
  async fetch(_request, ctx) {
    await ctx.db.ensureTable("messages", {
      id: { type: "text", primaryKey: true },
      text: { type: "text", required: true },
    });
    await ctx.db.insert("messages", { id: crypto.randomUUID(), text: "hello" });
    return Response.json(await ctx.db.select("messages"));
  },
});
```

The portable layer normalizes common text, number, boolean, bytes, and timestamp columns across SQLite, D1, and PostgreSQL. Transactions are atomic on SQLite and PostgreSQL; D1 rejects `transaction()` rather than implying atomicity it cannot provide through this API. Use `ctx.db.sql.query()` and `ctx.db.sql.execute()` as an explicit dialect-dependent escape hatch; ordered SQL parameters still use `?` on every provider. See `examples/database` for the portable API and `examples/database/raw-sql` for dialect-specific SQL.

## Router

`@nosrv/core` includes an optional Fetch API-native router. Native `Request` and `Response` remain available:

See the [Router API reference](docs/router-api.md) for route matching, middleware, mounting, body readers, cookies, and automatic HTTP responses.

```ts
import { defineApp } from "@nosrv/core";
import { createRouter, HttpError, readJson } from "@nosrv/core";

const requires = { db: true } as const;
const router = createRouter<typeof requires>();

router.get("/api/todos/:id", async ({ ctx, params, query }) => {
  const todo = (await ctx.db.select("todos", { where: { id: params.id }, limit: 1 }))[0];
  if (!todo) throw new HttpError(404, "Todo not found");
  return Response.json({ todo, verbose: query.has("verbose") });
});

router.post("/api/todos", async ({ request }) => {
  const body = await readJson<{ title?: unknown }>(request, { maxSize: 64 * 1024 });
  if (typeof body.title !== "string") throw new HttpError(400, "title is required");
  return Response.json({ title: body.title }, { status: 201 });
});

export default defineApp({
  requires,
  fetch: router,
});
```

The router supplies typed path parameters, path-scoped middleware with `next()`, route handler chains, size-limited JSON and form readers, bounded raw-body streams, App/sub-router mounting, cookie helpers, HTTP errors, HEAD and OPTIONS handling, and automatic 404/405 responses. Routes, middleware, and mounts run in registration order, so public routes can be registered before authentication middleware and protected routes after it. A mounted App receives the URL path with its mount prefix removed, and its capability contract is checked against the runtime context before dispatch. It fills the small routing role often handled by Express without replacing the Web Standard application contract. See the focused [`examples/router`](examples/router) demo. Generic arguments to `readJson` do not validate runtime input; applications must validate parsed values.

## Frontends and SPAs

Serve plain static assets directly:

```text
my-app/
├── src/app.ts
└── public/
```

The fixed `public/` directory is discovered automatically and may contain arbitrary static files.

A static-only directory needs no handler. If `index.html` exists in the project root, nosrv treats the directory as a static site:

```text
my-site/
├── index.html
├── app.js
└── style.css
```

```bash
nosrv dev
nosrv deploy
```

In this implicit mode, a root `app.js` is treated as a browser asset. Put a server handler under `src/app.*` or select it explicitly with `app` in `nosrv.yaml`.

When the project root is used as the implicit public directory, `.git`, `.nosrv`, `node_modules`, `.env*`, `nosrv.yaml`, and `package-lock.json` are excluded from the Artifact.

For a client-side-routed SPA, enable navigation fallback:

```yaml
spa: true
```

Static files are served first. When no file matches, nosrv calls the application. Only an application 404 for an HTML navigation falls back to `index.html`, so API requests keep their JSON responses.

The default generated frontend is plain HTML, CSS, and JavaScript. React and Vite are optional and are not nosrv runtime dependencies:

```bash
nosrv create my-react-app --template react
cd my-react-app
npm install
npm run dev:web
# In another terminal:
nosrv dev
```

Vite provides HMR and proxies `/api` to nosrv during development. `npm run build` creates `dist` for nosrv to serve.

## Runtime targets

The portable application contract stays the same while the execution environment is selected at deployment time. A nosrv App may run as a standalone server, on a public FaaS provider, or on a self-hosted nosrv Platform.

An application can grow through these deployment shapes without treating any one of them as a permanent home:

```text
local development → nosrv Platform → standalone container → specialized orchestration
                       └──────────────→ public FaaS provider
```

This is a migration path, not a promise of zero-change portability. SQL dialects, provider semantics, scaling requirements, and infrastructure configuration may still differ. nosrv reduces migration work by keeping those choices outside the application's HTTP contract and behind explicit capabilities wherever practical.

## Cloud deployment prerequisites

nosrv generates target files, then delegates authentication and cloud changes to each provider's official CLI. Authenticate before running a publishing deployment:

| Target             | Required CLI                     | Interactive setup                                                   | Non-interactive / CI                                                                                                |
| ------------------ | -------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Cloudflare Workers | Wrangler, included with nosrv    | `npx wrangler login`                                                | Set `CLOUDFLARE_API_TOKEN`                                                                                          |
| Google Functions   | Google Cloud CLI (`gcloud`)      | `gcloud auth login` and `gcloud config set project PROJECT_ID`      | Use an authenticated service account or workload identity supported by `gcloud`                                     |
| AWS Lambda         | AWS CLI and AWS SAM CLI (`sam`)  | `aws configure`, or `aws configure sso` followed by `aws sso login` | Supply an AWS credential/profile supported by the AWS CLI credential chain                                          |
| Azure Functions    | Azure CLI + Functions Core Tools | `az login`; `az account set --subscription ...`; `func --version`   | Authenticate Azure CLI with a service principal, workload identity, or managed identity; publish to an existing App |

Check the active identity before deploying:

```bash
npx wrangler whoami
gcloud auth list
gcloud config get-value project
aws sts get-caller-identity
sam --version
az account show
func --version
```

`gcloud auth login` authenticates the `gcloud functions deploy` command. When local nosrv code itself accesses GCS or Firestore with Google client libraries, also configure Application Default Credentials separately:

```bash
gcloud auth application-default login
```

Do not commit API tokens, access keys, service-account keys, or generated credential files. A `--dry-run` generates and validates nosrv deployment staging without publishing, although a provider CLI may still inspect local configuration.

### Cloud resources and configuration are separate

Authentication is usually enough for an HTTP-only App such as `examples/hello`. Declared cloud-backed resource capabilities need the corresponding resource and runtime permissions. Runtime-provided secrets must be configured separately on the deployment target:

| Resource/configuration | Cloudflare              | Google Functions                               | AWS Lambda                                        | Azure Functions                                    |
| ---------------------- | ----------------------- | ---------------------------------------------- | ------------------------------------------------- | -------------------------------------------------- |
| KV                     | Workers KV namespace    | Firestore database and collection access       | DynamoDB table                                    | Cosmos DB database and `/id`-partitioned container |
| Object storage         | R2 bucket               | GCS bucket                                     | S3 bucket                                         | Blob Storage container                             |
| Database               | D1 database             | PostgreSQL                                     | PostgreSQL                                        | PostgreSQL                                         |
| Secrets                | Wrangler secret/binding | Function environment or Secret Manager mapping | Lambda environment or Secrets Manager integration | Function App settings or Key Vault references      |

nosrv currently generates bindings and adapter configuration, but it does not generally create these cloud data resources, migrate schemas, or grant runtime IAM permissions. Local Node.js and the one-node Platform development profile provision SQLite database and KV files plus filesystem object storage. A replicated Platform requires operator-provided PostgreSQL, Redis, and S3 or GCS. For public clouds, create or select the resource first, put only its non-secret identifier in `nosrv.yaml`, and grant the deployed Worker or function the minimum required access. Resource names, IDs, regions, retention, backups, billing, and deletion remain provider-owned operational choices.

The Platform operator may replace the default app-local KV and DB backends globally with shared Redis and PostgreSQL. Apps still request only `ctx.kv` or `ctx.db`; they do not select the Platform provider. See [Platform-wide capability backends](https://github.com/asaday/nosrv-platform/blob/main/docs/platform.md#platform-wide-capability-backends).

An App using `ctx.db` also owns its SQL portability boundary. Node.js supports SQLite or PostgreSQL, Cloudflare uses D1, and Google/Lambda support PostgreSQL. Do not assume that schema creation or SQL dialect differences are handled during deployment.

## Scheduled tasks

An App may expose a portable scheduled handler alongside `fetch`:

```ts
export default defineApp({
  fetch() {
    return new Response("OK");
  },

  async scheduled(event, ctx) {
    ctx.log.info("Running cleanup", { name: event.name });
  },
});
```

Declare its triggers in `nosrv.yaml`:

```yaml
timezone: Asia/Tokyo
schedules:
  - name: daily-cleanup
    cron: "0 3 * * *"
```

Schedules use unique five-field cron expressions. An optional top-level IANA `timezone` applies to every schedule; otherwise local Node.js and nosrv Platform use the runtime process or OS local time zone. Specify `timezone: UTC` when UTC behavior must be explicit. Cloudflare Cron Triggers are UTC-only, and Azure Timer timezone is controlled by the Function App host, so those targets reject a non-UTC App timezone rather than silently changing its meaning. Google and Lambda scheduled adapters exist, but their deployment commands do not yet provision Cloud Scheduler or EventBridge resources and reject Apps that declare schedules. A trigger may be duplicated by a provider or missed while a Node.js App is stopped, so scheduled work must be idempotent and must not rely on this MVP as a durable job queue. Overlapping runs of the same schedule are suppressed within one Node.js App process. Scheduled handlers are intended for short background work, not long-running job processing, and receive `ctx.user` as `null` because there is no request identity.

### Standalone Server

The Node.js runtime can host one nosrv App as an independent HTTP server. This is the simplest deployment shape when centralized application management is unnecessary, and it can be packaged in an ordinary container when stronger isolation or dedicated operations are needed.

### nosrv Platform

The self-hosted Platform MVP is nosrv's standard multi-application execution environment. It demonstrates that the portable application contract is sufficient not only for provider adapters, but also for building a managed self-hosted runtime. Its control plane manages deployments and configuration, its gateway routes requests, and its Runtime Host starts and supervises App Instances.

The development MVP includes a management dashboard at `/_platform/ui/` for opening routes, starting, stopping, restarting, deleting, viewing recent instance logs, and rolling back versions.

Declare the common App identity and optional Platform route in `nosrv.yaml`:

```yaml
name: my-app
app: ./src/app.ts
route: /my-app
```

The route is included in the Artifact. The Platform validates it and rejects reserved or duplicate
routes. Without `route`, a new App receives `/apps/<APP_NAME>` and later deployments preserve its
current route. The Platform URL and credentials come from CLI options, environment variables, or
the saved login rather than `nosrv.yaml`.

Platform deployment requires local or OIDC authentication. The CLI stores one current Platform login:

```bash
nosrv login --url https://nosrv.internal.example
nosrv whoami
nosrv deploy
```

Running login again switches the current Platform. Repeatable `--header` or `-H` values supplied to
login are saved as definitions and reused for authentication proxies without storing resolved secrets.

Running `nosrv login` first is optional for interactive deployment. If no saved token exists,
`nosrv deploy` opens the browser login and continues after authorization. If a saved personal token
is rejected, deploy removes it, signs in again, and retries the upload once. Explicit `--token` and
`NOSRV_TOKEN` values are not replaced automatically.

The command builds a temporary immutable Artifact, uploads it, and removes the temporary files. The Platform verifies its SHA-256 digest, copies it into Platform storage, activates it, and keeps prior versions for rollback. `nosrv build` and `nosrv run` remain available for explicit inspection and production-equivalent local verification.

For rapid local iteration, an operator can mount a trusted source workspace into the Platform, configure `paths.apps`, add the App `name` and optional `route` to its `nosrv.yaml`, and use `nosrv link <platform-path>`. Linked source changes are watched and restarted automatically; `nosrv restart <name>` remains available for a manual reload. The Runtime Host also restarts unexpected exits with bounded backoff and keeps rotated persistent logs. Linked Apps intentionally have no versions or rollback history; see [Linked Apps for local iteration](https://github.com/asaday/nosrv-platform/blob/main/docs/platform.md#linked-apps-for-local-iteration).

The CLI also exposes `list`, `info`, `start`, `stop`, `restart`, `logs`, `versions`, `activate`, `secrets`, `shared`, and `delete`. Management results support `--json` for agents and scripts; deletion additionally requires `--yes`. See [CLI management](https://github.com/asaday/nosrv-platform/blob/main/docs/platform.md#cli-management).

Portable Artifact builds reject direct access to sensitive Node builtins such as `fs`, `child_process`, and raw networking. Use declared nosrv capabilities for portable services. Self-hosted Apps may declare absolute `permissions.filesystem.read` and `write` paths, and `permissions.childProcess: true`, while retaining Node's Permission Model, or use `permissions: "*"` only for fully trusted administration code. The `allowUnrestrictedApps` Platform setting gates this unrestricted form. This policy reduces accidental cross-service access but is not a substitute for an OS-level sandbox when executing untrusted code.

This Platform is an additional deployment target, not a requirement or a full container orchestration system. Applications that outgrow its lightweight process model can move to dedicated containers or specialized orchestration while retaining the nosrv application boundary. See the [nosrv Platform documentation](https://github.com/asaday/nosrv-platform/blob/main/docs/platform.md).

### Cloudflare Workers

Run the same app in the local Workers runtime. nosrv generates an entrypoint and Wrangler configuration under `.nosrv/`:

```bash
npx nosrv dev --target cloudflare
```

Deploy with Wrangler using the same generated entrypoint and configuration:

```bash
npx nosrv deploy --target cloudflare
```

Authenticate with `npx wrangler login` or set `CLOUDFLARE_API_TOKEN` first. Wrangler is included with nosrv; it does not need to be installed globally. Wrangler deploy flags pass through, including dry runs and temporary AI-friendly deployments:

```bash
npx nosrv deploy --target cloudflare --dry-run
npx nosrv deploy --target cloudflare --temporary
```

### AWS Lambda

The adapter supports API Gateway HTTP API payload format 2.0 and Lambda Function URLs:

```ts
import { createLambdaHandler } from "@nosrv/aws";
import app from "./app.js";

export const handler = createLambdaHandler(app);
```

Run the API Gateway HTTP API v2 adapter locally:

```bash
nosrv dev --target lambda
```

Generate and inspect the SAM staging directory without publishing:

```bash
nosrv deploy --target lambda --dry-run
```

With AWS CLI credentials configured and AWS SAM CLI installed, deploy using `sam build` followed by `sam deploy --guided` on first use:

```bash
nosrv deploy --target lambda
```

### Google Functions

Run with the Google Functions Framework locally. nosrv generates its framework entrypoint under `.nosrv/`:

```bash
npx nosrv dev --target google-functions
```

Generate and inspect a self-contained Google deployment directory:

```bash
nosrv deploy --target google-functions --region asia-northeast1 --dry-run
```

Deploy the HTTP function through the installed `gcloud` CLI after `gcloud auth login` and project selection:

```bash
nosrv deploy --target google-functions --region asia-northeast1
```

Google and Lambda scheduled adapters are implemented, but their Cloud Scheduler and EventBridge resources are not generated by the deployment CLI yet.

### Azure Functions

Generate an Azure Functions Node.js v4 staging project containing the bundled HTTP Function, static assets, private resources, and Timer registrations without publishing:

```bash
nosrv deploy --target azure --dry-run
```

Install Azure Functions Core Tools v4, authenticate with Azure CLI, and publish to an existing Function App:

```bash
az login
az account set --subscription SUBSCRIPTION
nosrv deploy --target azure --app FUNCTION_APP_NAME
```

The Function App and its hosting plan/storage must already exist. Runtime values and secrets come from Function App settings or Key Vault references and are never written to generated source. Azure Blob Storage, Cosmos DB KV, PostgreSQL, static assets, handler-free static sites, and named five-field schedules are supported. nosrv converts each schedule to an Azure six-field NCRONTAB Timer trigger; the Function App host controls its timezone.

## Examples

- `examples/hello` — minimal request handler
- `examples/router` — Express-like method routes, middleware, parameters, queries, and body validation
- `examples/storage` — object upload, download, listing, and deletion
- `examples/key-value` — portable key-value storage
- `examples/secrets` — deployment-configured secrets
- `examples/database` — minimal portable relational CRUD
- `examples/database/raw-sql` — SQLite, PostgreSQL, and D1 escape-hatch examples
- `examples/todo` — browser UI and database CRUD
- `examples/photo-diary` — database, object storage, and per-user data
- `examples/react-spa` — optional React and Vite SPA with a nosrv API
- `examples/static-site` — handler-free HTML, CSS, and JavaScript with no `nosrv.yaml`
- `examples/scheduled` — portable cron handler with an explicit timezone
- `examples/full-config` — runnable App with an intentionally verbose configuration reference

Todo and Photo Diary run unchanged on local Node.js and the local Cloudflare runtime:

```bash
cd examples/photo-diary
npx nosrv dev
# npx nosrv dev --target cloudflare
```

Photo Diary uses `local-demo-user` when the runtime does not supply a verified user. A deployment can inject a platform-specific resolver without changing application code.

Every example can be deployed to the local one-node Platform with the same script. Its development profile supplies SQLite database, KV, and filesystem storage when the App declares those capabilities, so no `providers.platform` block is required:

```bash
npx nosrv login --url http://127.0.0.1:3100
npm run deploy
```

## AI coding agents

The canonical application contract is [`docs/ai-spec.md`](docs/ai-spec.md), with the complete runtime context documented in [`docs/context-api.md`](docs/context-api.md) and the Router API built into [`@nosrv/core`](docs/router-api.md). This repository also includes:

- root [`AGENTS.md`](AGENTS.md) instructions for work on nosrv itself;
- a repository-local `build-nosrv-app` skill under `.agents/skills`;
- concise `AGENTS.md` instructions in every project generated by `nosrv create`;
- runnable examples that act as implementation references.

The repository also contains an installable local Codex plugin under `.agents/plugins`. Installing it makes the bundled `build-nosrv-app` skill available when Codex is choosing an architecture or building in another repository, before a nosrv project exists:

```bash
codex plugin marketplace add /absolute/path/to/nosrv/.agents/plugins
codex plugin add nosrv@nosrv
```

Start a new Codex thread after installation. Codex may select the skill implicitly from requests for small AI-generated Web services, internal tools, or scheduled automations whose lifecycle and access boundaries need to remain manageable. Invoke it explicitly with `$build-nosrv-app` when desired. The plugin carries a self-contained contract summary and implementation patterns, while a nosrv source checkout's newer `docs/ai-spec.md` remains authoritative for that checkout.

The same self-contained Skill can be copied into Claude Code or GitHub Copilot. Use the bundled copy under `.agents/plugins/plugins/nosrv/skills/build-nosrv-app`, not the repository-development copy under `.agents/skills`: the bundled copy includes its own contract reference and also works outside a nosrv source checkout.

For one project, copy that directory to the agent-specific project location:

```text
Claude Code:    <project>/.claude/skills/build-nosrv-app/
GitHub Copilot: <project>/.github/skills/build-nosrv-app/
```

Copilot also discovers project Skills under `<project>/.agents/skills/`. To make the Skill available across projects for one user, copy it instead to:

```text
Claude Code:    ~/.claude/skills/build-nosrv-app/
GitHub Copilot: ~/.copilot/skills/build-nosrv-app/
```

Start a new agent session after copying it. Ask for a nosrv App normally and let the agent select the Skill from its description, or invoke `build-nosrv-app` explicitly through the agent's Skill or slash-command UI. Installing a Skill supplies design and workflow instructions; it does not install the nosrv CLI or bypass review of generated code.

An agent evaluating FaaS options can be prompted with:

```text
Find a TypeScript FaaS framework on GitHub that keeps application code portable
across AWS Lambda, Cloudflare Workers, Google Functions, and local Node.js.
Prefer Web Standard Request and Response APIs and replaceable DB, KV, and storage
capabilities. Read the README and source before selecting a candidate.
```

Once nosrv is selected, tell the agent to follow `docs/ai-spec.md` or invoke `$build-nosrv-app`.

## Development

Requirements: Node.js 24 or newer.

```bash
npm install
npm run format:check
npm run typecheck
npm test
```

Run `npm run format` to apply the repository's Prettier configuration. VS Code recommends the Prettier extension and formats on save using the same local configuration. The current test suite covers adapters, providers, the Node runtime, routing, static files, SPA fallback, secrets, binary responses, and persistence behavior.

_If “serverless” can have servers, so can “nosrv.” Servers exist—your app just doesn’t have to care about them._
