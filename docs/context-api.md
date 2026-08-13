# nosrv App Context API

This document is the reference for the `ctx` object supplied to a nosrv App. The exported TypeScript interfaces in [`@nosrv/core`](../packages/core/src/index.ts) are the source of truth; this document explains their portable behavior and intended use.

## Context overview

The same context is available to `initialize`, `fetch`, and `scheduled` handlers. Database, KV, object storage, and named external tool groups become typed capabilities when the App declares them in `requires`.

```ts
interface AppContext {
  env: Readonly<Record<string, string | undefined>>;
  log: Logger;
  platform: PlatformInfo;
  waitUntil(promise: Promise<unknown>): void;

  secrets: Secrets;
  resources: Resources;
  user: User | null;

  db?: Database;
  kv?: KV;
  storage?: ObjectStorage;
  tools: Readonly<Record<string, Tool>>;
}
```

| Property        | Declaration required | Purpose                                     |
| --------------- | -------------------- | ------------------------------------------- |
| `ctx.env`       | No                   | Runtime-provided non-secret environment     |
| `ctx.log`       | No                   | Structured application logging              |
| `ctx.platform`  | No                   | Current runtime identity                    |
| `ctx.waitUntil` | No                   | Runtime-permitted work after a response     |
| `ctx.secrets`   | No                   | Runtime-configured secret values            |
| `ctx.resources` | No                   | Immutable files packaged with the App       |
| `ctx.user`      | No                   | Runtime-verified request identity or `null` |
| `ctx.db`        | `requires.db`        | Portable relational CRUD and raw SQL escape |
| `ctx.kv`        | `requires.kv`        | Portable text and byte key-value storage    |
| `ctx.storage`   | `requires.storage`   | Portable object storage                     |
| `ctx.tools`     | `requires.tools`     | Platform-managed external tool groups       |

Declare only the resource capabilities the App needs:

```ts
import { defineApp } from "@nosrv/core";

export default defineApp({
  requires: {
    db: true,
    storage: true,
    tools: ["slack"],
  },
  async fetch(_request, ctx) {
    // ctx.db, ctx.storage, and ctx.tools.slack are required and typed here.
    // The always-available context properties need no declaration.
    return Response.json({ platform: ctx.platform.name });
  },
});
```

The runtime validates declared capabilities before invoking the App. Provider selection, resource identifiers, external connection details, credentials, and tool policy belong in deployment configuration, not in portable application modules.

## Always-available context

### `ctx.env`

```ts
ctx.env: Readonly<Record<string, string | undefined>>
```

Contains non-secret environment values exposed by the runtime or deployment target. Apps may provide portable non-secret defaults with `env` in `nosrv.yaml`.

```ts
const mode = ctx.env.APP_MODE ?? "development";
```

- `nosrv.yaml` `env` values must be strings. `NOSRV_` names are reserved by the runtime.
- Shell, `.env`, deployment-target, and Platform App settings may override these defaults.
- Values are strings or `undefined`.
- Provider connection values owned by the runtime may be hidden from `ctx.env`.
- Do not use `ctx.env` for credentials; use `ctx.secrets`.

### `ctx.secrets`

```ts
interface Secrets {
  get(name: string): Promise<string | null>;
}
```

Reads a secret configured by the runtime or deployment target. Missing secrets return `null`.

```ts
const token = await ctx.secrets.get("API_TOKEN");
if (!token) {
  return Response.json({ error: "API_TOKEN is not configured" }, { status: 503 });
}
```

- App code does not declare secret names.
- Secret configuration and access control are deployment concerns.
- Never place secret values in `nosrv.yaml`, generated source, logs, or responses.
- On the self-hosted Platform, an administrator configures encrypted per-App values from the management dashboard or management API. App code reads them with `ctx.secrets.get(name)` and cannot enumerate them.

### `ctx.resources`

```ts
interface Resources {
  get(path: string): Promise<Blob | null>;
}
```

Reads an immutable file packaged automatically from the App's fixed `resources/` directory.

```ts
const prompt = await ctx.resources.get("prompts/system.txt");
if (!prompt) return new Response("Missing resource", { status: 500 });
const text = await prompt.text();
```

- Paths are relative and use `/` separators.
- Empty paths, absolute paths, backslashes, empty segments, `.` segments, and `..` segments are invalid.
- Returned `Blob` values are read-only packaged data.
- Use `ctx.db`, `ctx.kv`, or `ctx.storage` for data that changes at runtime.

### `ctx.user`

```ts
interface User {
  id: string;
  email?: string;
  name?: string;
  thumbnail?: string;
}

ctx.user: User | null
```

Contains an identity verified by the runtime or deployment target. Anonymous requests receive `null`.

```ts
if (!ctx.user) {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}
return Response.json({ userId: ctx.user.id });
```

- Do not trust identity headers supplied directly by clients.
- Authentication and access policy are configured at the deployment target, not in `nosrv.yaml`.
- `scheduled` handlers always receive `ctx.user === null`.
- Authentication mechanisms, sessions, and identity verification belong to the runtime or deployment target.

### `ctx.log`

```ts
interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}
```

Writes application logs through the active runtime.

```ts
ctx.log.info("Report created", { reportId, userId: ctx.user?.id });
```

- Prefer a stable message and structured data.
- Do not log secrets, credentials, session values, or unnecessary personal data.
- Log storage, retention, search, and delivery are runtime-specific.

### `ctx.platform`

```ts
interface PlatformInfo {
  readonly name: "node" | "cloudflare" | "lambda" | "google-functions" | (string & {});
}
```

Identifies the active runtime.

```ts
ctx.log.debug("Runtime selected", { platform: ctx.platform.name });
```

Portable business logic should not normally branch on this value. Use it for diagnostics or an explicitly isolated platform-specific escape hatch.

### `ctx.waitUntil()`

```ts
ctx.waitUntil(promise: Promise<unknown>): void
```

Registers work that the selected runtime may continue after the response is returned.

```ts
ctx.waitUntil(sendAnalyticsEvent(event));
return new Response(null, { status: 204 });
```

- Runtime completion guarantees differ; do not use it for required durable work.
- Do not use it as a job queue, transaction mechanism, or substitute for a workflow service.
- Await work that must finish before the operation is considered successful.

## `ctx.db`

Declare `requires: { db: true }` to use the portable relational database API.

```ts
interface DatabaseSelectOptions {
  fields?: readonly string[];
  where?: DatabaseWhere;
  orderBy?: readonly { field: string; direction?: "asc" | "desc" }[];
  limit?: number;
  offset?: number;
}

interface Database {
  readonly sql: DatabaseSql;
  currentTimestamp(): Promise<string>;
  ensureTable(
    name: string,
    columns: DatabaseTable,
    options?: { unique?: readonly (readonly string[])[] },
  ): Promise<void>;
  ensureIndex(
    name: string,
    table: string,
    options: { fields: readonly string[]; unique?: boolean },
  ): Promise<void>;
  insert(name: string, values: DatabaseValues): Promise<DatabaseExecuteResult>;
  insertMany(name: string, rows: readonly DatabaseValues[]): Promise<DatabaseExecuteResult>;
  upsert(
    name: string,
    values: DatabaseValues,
    options: { conflict: readonly string[]; update: readonly string[] },
  ): Promise<DatabaseExecuteResult>;
  select<T extends DatabaseRow = DatabaseRow>(
    name: string,
    options?: DatabaseSelectOptions,
  ): Promise<T[]>;
  count(name: string, options?: { where?: DatabaseWhere }): Promise<number>;
  exists(name: string, options?: { where?: DatabaseWhere }): Promise<boolean>;
  update(
    name: string,
    values: DatabaseValues,
    options: { where: DatabaseWhere },
  ): Promise<DatabaseExecuteResult>;
  delete(name: string, options: { where: DatabaseWhere }): Promise<DatabaseExecuteResult>;
  transaction<T>(callback: (db: Database) => Promise<T>): Promise<T>;
}
```

`currentTimestamp()` returns the database server's current time as an ISO 8601 string. Use it when
multiple runtime instances must compare deadlines against one shared clock, such as a lease. It is
not the creation timestamp of any particular row.

`ensureTable()` creates a missing table and validates an existing table's declared columns, portable
types, required and primary-key flags, and unique constraints. It fails on an incompatible schema;
it does not migrate data or alter existing columns. `ensureIndex()` similarly creates or validates a
named single- or multi-column index:

```ts
await ctx.db.ensureIndex("reports_owner_created", "reports", {
  fields: ["ownerId", "createdAt"],
});
```

### Portable column and value types

Portable columns are `text`, `number`, `integer`, `boolean`, `bytes`, and `timestamp`. `number` represents floating-point values, while `integer` represents whole numbers and can be used for generated identity keys. Timestamp values are ISO 8601 strings.

```ts
type SqlValue = string | number | bigint | boolean | null | Uint8Array;

interface DatabaseColumn {
  type: "text" | "number" | "integer" | "boolean" | "bytes" | "timestamp";
  primaryKey?: boolean;
  generated?: "identity";
  required?: boolean;
  default?: SqlValue;
}
```

### `ensureTable()`

Creates a missing table. It is suitable for short, idempotent initialization; it is not a schema migration system and does not alter an existing table. In particular, adding `generated: "identity"` does not convert an existing primary key; migrate or recreate a table that was previously created with another type.

```ts
export default defineApp({
  requires: { db: true },
  async initialize(ctx) {
    await ctx.db.ensureTable("reports", {
      id: { type: "text", primaryKey: true },
      title: { type: "text", required: true },
      createdAt: { type: "timestamp", required: true },
    });
  },
  async fetch(_request, ctx) {
    return Response.json(await ctx.db.select("reports"));
  },
});
```

Generated integer identity keys are portable across SQLite, D1, and PostgreSQL:

```ts
await ctx.db.ensureTable("events", {
  id: { type: "integer", primaryKey: true, generated: "identity" },
  title: { type: "text", required: true },
});
```

SQLite and D1 use `INTEGER PRIMARY KEY`; PostgreSQL uses `INTEGER GENERATED BY DEFAULT AS IDENTITY`. SQLite identity values may be reused after deleting the highest row because the portable API does not request SQLite-specific `AUTOINCREMENT`.

Declare composite uniqueness when it is part of the table contract:

```ts
await ctx.db.ensureTable(
  "identities",
  {
    id: { type: "integer", primaryKey: true, generated: "identity" },
    issuer: { type: "text", required: true },
    subject: { type: "text", required: true },
  },
  { unique: [["issuer", "subject"]] },
);
```

### `insert()`

```ts
const result = await ctx.db.insert("reports", {
  id: crypto.randomUUID(),
  title: "Daily report",
  createdAt: new Date().toISOString(),
});
```

Generated columns may be omitted, and an empty object produces `INSERT ... DEFAULT VALUES`. Returns the number of affected rows and, when the provider supplies one, a last insert ID. Portable identity inserts return `lastInsertId` on SQLite, D1, and PostgreSQL.

```ts
interface DatabaseExecuteResult {
  rowsAffected: number;
  lastInsertId?: string | number | bigint;
}
```

### `upsert()`

Insert a row or update selected values when a declared primary-key or unique constraint conflicts:

```ts
await ctx.db.upsert(
  "identities",
  { id, issuer, subject, email },
  { conflict: ["issuer", "subject"], update: ["email"] },
);
```

Use an empty `update` array for `DO NOTHING`. Conflict and update fields must be present in `values`.

Insert multiple rows with one or more bounded bulk statements. Every row must contain the same
fields; an empty input succeeds with `rowsAffected: 0`:

```ts
await ctx.db.insertMany("reports", reports);
```

### `select()`

Supports field projection, structured filters, ordering, and a row limit. A scalar is equality shorthand; operator objects support `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, and `in`.

```ts
const reports = await ctx.db.select<{ id: string; title: string }>("reports", {
  fields: ["id", "title"],
  where: { ownerId: ctx.user!.id, createdAt: { gte: start }, status: { in: ["open", "held"] } },
  orderBy: [{ field: "createdAt", direction: "desc" }],
  limit: 50,
  offset: 0,
});
```

`fields` must contain at least one validated column identifier when provided. Omit it to select every
column. `offset` requires `limit`. For large or frequently changing datasets, prefer keyset
pagination expressed with ordered comparison conditions over increasingly large offsets. The
TypeScript row generic does not validate runtime database values.

Conditions at one object level are combined with `AND`. Use non-empty `$and` and `$or` arrays for
grouping; `notIn` complements `in`:

```ts
const where = {
  $and: [{ ownerId }, { $or: [{ status: "open" }, { status: { in: ["held", "queued"] } }] }],
};
```

Count rows or test existence without fetching application rows:

```ts
const total = await ctx.db.count("reports", { where });
const anyFailed = await ctx.db.exists("reports", { where: { status: "failed" } });
```

### `update()` and `delete()`

Portable mutations require a non-empty structured `where` object.

```ts
await ctx.db.update("reports", { title: "Updated" }, { where: { id: reportId } });
await ctx.db.delete("reports", { where: { id: reportId } });
```

Table and column identifiers are validated. Values remain parameterized rather than interpolated into SQL.

### `transaction()`

Run related operations atomically and use `rowsAffected` for conditional ownership or lease acquisition:

```ts
const acquired = await ctx.db.transaction((tx) =>
  tx.update(
    "leases",
    { owner: instanceId, expiresAt: nextExpiry },
    { where: { id: appId, expiresAt: { lte: now } } },
  ),
);
if (acquired.rowsAffected !== 1) throw new Error("Lease is held");
```

SQLite and PostgreSQL transactions are atomic. D1 rejects `transaction()` explicitly; use a D1-native coordination mechanism when atomic multi-statement work is required.

### Raw SQL escape hatch

```ts
interface DatabaseSql {
  query<T extends DatabaseRow = DatabaseRow>(
    sql: string,
    params?: readonly SqlValue[],
  ): Promise<{ rows: T[] }>;
  execute(sql: string, params?: readonly SqlValue[]): Promise<DatabaseExecuteResult>;
}
```

```ts
const result = await ctx.db.sql.query<{ count: number }>(
  "SELECT COUNT(*) AS count FROM reports WHERE owner_id = ?",
  [ownerId],
);
```

- Ordered parameters use `?` on every provider.
- SQL syntax, schema design, and result normalization are the App's responsibility.
- SQL dialect portability is not guaranteed. Isolate raw SQL when the App may change providers.

## `ctx.kv`

Declare `requires: { kv: true }` to use persistent key-value storage.

```ts
interface KV {
  get(key: string, options?: { type?: "text" }): Promise<string | null>;
  get(key: string, options: { type: "bytes" }): Promise<Uint8Array | null>;
  set(
    key: string,
    value: string | Uint8Array,
    options?: { expirationTtl?: number; expiration?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<KVListResult>;
}
```

### Read, write, and delete

```ts
await ctx.kv.set("session:123", "active", { expirationTtl: 3600 });
const state = await ctx.kv.get("session:123");
await ctx.kv.delete("session:123");
```

Read byte values explicitly:

```ts
const bytes = await ctx.kv.get("cache:data", { type: "bytes" });
```

Expiration rules:

- `expirationTtl` is a relative number of seconds.
- `expiration` is an absolute Unix timestamp in seconds.
- The options are mutually exclusive.
- Portable expiration must be an integer at least 60 seconds in the future.

### List keys

```ts
interface KVListResult {
  keys: Array<{ key: string; expiresAt?: number }>;
  complete: boolean;
  cursor?: string;
}
```

```ts
let cursor: string | undefined;
do {
  const page = await ctx.kv.list({ prefix: "session:", limit: 100, cursor });
  for (const item of page.keys) ctx.log.debug("KV key", item);
  cursor = page.complete ? undefined : page.cursor;
} while (cursor);
```

- `limit` must be between 1 and 1000 and defaults to 1000.
- Cursors are opaque; pass them back unchanged.
- Do not assume a common key order across providers.

## `ctx.storage`

Declare `requires: { storage: true }` to use object storage.

```ts
interface ObjectStorage {
  get(key: string): Promise<StorageObject | null>;
  put(
    key: string,
    body: string | Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>,
    options?: StoragePutOptions,
  ): Promise<StoragePutResult>;
  delete(key: string): Promise<void>;
  head(key: string): Promise<StorageMetadata | null>;
  list(options?: StorageListOptions): Promise<StorageListResult>;
}
```

### Store an object

```ts
const result = await ctx.storage.put("reports/123/photo.jpg", request.body!, {
  contentType: "image/jpeg",
  customMetadata: { reportId: "123" },
});
```

Apply a body limit before streaming untrusted uploads into storage. A declared MIME type is not proof of file content; validate content when authenticity matters.

### Read an object

```ts
const object = await ctx.storage.get("reports/123/photo.jpg");
if (!object) return new Response("Not found", { status: 404 });

return new Response(object.body, {
  headers: {
    "content-type": object.metadata.contentType ?? "application/octet-stream",
  },
});
```

```ts
interface StorageMetadata {
  key: string;
  size: number;
  etag?: string;
  contentType?: string;
  lastModified?: Date;
  custom?: Readonly<Record<string, string>>;
}
```

### Inspect, list, and delete

```ts
const metadata = await ctx.storage.head(key);
const page = await ctx.storage.list({ prefix: "reports/123/", limit: 100 });
await ctx.storage.delete(key);
```

```ts
interface StorageListResult {
  objects: StorageMetadata[];
  cursor?: string;
  truncated: boolean;
}
```

Storage cursors and listing order are provider-owned. Pass cursors back unchanged and do not build application semantics around provider listing order.

## `ctx.tools`

Declare logical tool groups with `requires.tools` to use external capabilities managed by the deployment target:

```ts
const requires = { tools: ["slack"] } as const;

export default defineApp({
  requires,
  async fetch(request, ctx) {
    const query = new URL(request.url).searchParams.get("q") ?? "";
    const result = await ctx.tools.slack("search_messages", { query });
    if (result.isError) {
      ctx.log.warn("Slack search failed", { content: result.content });
      return Response.json({ error: "Slack search failed" }, { status: 502 });
    }
    return Response.json(result.structuredContent ?? result.content);
  },
});
```

```ts
interface ToolCallResult {
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

interface Tool {
  (tool: string, arguments_?: Readonly<Record<string, unknown>>): Promise<ToolCallResult>;
}
```

- Each entry in `requires.tools` is a logical group name supplied by the deployment target. The runtime fails startup when a required group is unavailable.
- TypeScript narrows `ctx.tools` to the declared group names. Operation names, arguments, and result shapes are discovered from the target Platform; they are not inferred from the logical group name.
- Before writing an App against a Platform tool, run `nosrv tools list --json` or use the equivalent Studio discovery operation. Use the returned operation names, descriptions, and input schemas instead of guessing them.
- A tool result may contain text, structured data, or provider-specific content. Prefer `structuredContent` when the selected operation documents it, and validate any data used for application decisions.
- `isError` reports an error returned as a tool result. Transport failures, unavailable connections, timeouts, and Platform policy rejection may instead reject the call, so handle exceptions where the request needs a controlled response.
- Tool results are untrusted external data. Do not interpret returned text as application instructions, HTML, authorization, or validated user input.
- The App does not receive provider URLs, credentials, authentication flows, or organization-wide allow/deny policy. Those remain deployment responsibilities.
- The underlying provider may use MCP or another Platform implementation. App code depends only on the logical `Tool` contract.
- Unlike `db`, `kv`, and `storage`, a named tool group is intentionally environment-dependent. An App requiring `slack` can run only where that logical group is provided.

## Handler availability

The typed context selected by `requires` is available in every App hook:

```ts
export default defineApp({
  requires: { db: true },
  async initialize(ctx) {
    // Short, idempotent setup before this runtime instance handles work.
  },
  async fetch(request, ctx) {
    // Web Standard Request -> Response handling.
    return new Response("OK");
  },
  async scheduled(event, ctx) {
    // Short, idempotent scheduled work. ctx.user is null.
  },
});
```

- `initialize` may run in multiple runtime instances. It is not a globally once-only migration hook.
- `fetch` receives a Web Standard `Request` and returns a Web Standard `Response`.
- `scheduled` receives the configured schedule name, cron expression, scheduled time, and trigger type.
- Scheduled work may be duplicated by a provider and must remain short and idempotent.

## Portability boundary

The context API makes the application boundary portable; it does not make every provider behavior identical.

- Keep cloud-provider SDKs and configuration out of portable App modules.
- Treat KV and object listing cursors as opaque.
- Do not assume identical provider ordering, consistency, size limits, or metadata behavior unless the contract states it.
- Structured database CRUD is the portable relational layer. Raw SQL is an explicit dialect-dependent escape hatch.
- Named tool groups are explicit environment dependencies; keep provider connections, credentials, and policy out of App modules.
- External HTTP APIs can be called with the standard `fetch` API and do not require a context capability.
- Direct filesystem, process, worker, VM, module-loader, raw-network, and SQLite Node builtins are rejected in portable Artifacts.

See the [AI Application Specification](./ai-spec.md) for application structure and portability rules, the [Deployment Design](./deployment.md) for provider responsibilities, and the [Platform documentation](./platform.md) for self-hosted runtime behavior.
