# nosrv API patterns

## Choose data access deliberately

- Use `ctx.kv` for simple key-addressed values and caches.
- Use `ctx.storage` for blobs, uploads, and files.
- Use structured `ctx.db` CRUD for relational application data when portability matters.
- Use `ctx.db.sql` only as an isolated, parameterized, dialect-specific escape hatch when structured CRUD cannot express a real requirement.

Do not replace ordinary structured CRUD with raw SQL or an ORM by default. Use `initialize()` with `ensureTable` and `ensureIndex` for short idempotent setup; they do not replace schema migrations.

## Direct application

```ts
import { defineApp } from "@nosrv/core";

export default defineApp({
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/hello") return Response.json({ message: "hello" });
    return Response.json({ error: "Not found" }, { status: 404 });
  },
});
```

## Router with a declared capability

```ts
import { defineApp } from "@nosrv/core";
import { createRouter, HttpError, readJson } from "@nosrv/router";

const requires = { db: true } as const;
const router = createRouter<typeof requires>();

router.get("/api/items/:id", async ({ ctx, params }) => {
  const rows = await ctx.db.select("items", { where: { id: params.id }, limit: 1 });
  if (!rows[0]) throw new HttpError(404, "Item not found");
  return Response.json(rows[0]);
});

router.post("/api/items", async ({ request, ctx }) => {
  const input = await readJson<{ title?: unknown }>(request, { maxSize: 64 * 1024 });
  if (typeof input.title !== "string" || !input.title.trim()) {
    throw new HttpError(400, "title is required");
  }
  await ctx.db.insert("items", { id: crypto.randomUUID(), title: input.title.trim() });
  return Response.json({ ok: true }, { status: 201 });
});

export default defineApp({ requires, fetch: router });
```

## Storage upload

```ts
const form = await request.formData();
const file = form.get("file");
if (!(file instanceof File) || file.size === 0) {
  return Response.json({ error: "file is required" }, { status: 400 });
}
if (file.size > 10 * 1024 * 1024) {
  return Response.json({ error: "file is too large" }, { status: 413 });
}
await ctx.storage.put(`uploads/${crypto.randomUUID()}`, file.stream(), {
  contentType: file.type,
});
```

Validate magic bytes or parse the content when the claimed media type affects security.

## Scheduled task

```ts
export default defineApp({
  requires: { db: true },
  async fetch() {
    return new Response("ok");
  },
  async scheduled(event, ctx) {
    await ctx.db.delete("expired_items", { where: { state: "expired" } });
  },
});
```

```yaml
schedules:
  cleanup:
    cron: "0 3 * * *"
```
