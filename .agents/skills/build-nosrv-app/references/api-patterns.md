# nosrv API Patterns

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

## Router with capabilities

```ts
import { defineApp } from "@nosrv/core";
import { createRouter, HttpError, readJson } from "@nosrv/router";

const requires = { db: true } as const;
const router = createRouter<typeof requires>();

router.get("/api/items/:id", async ({ ctx, params }) => {
  const item = (
    await ctx.db.select("items", {
      fields: ["id", "title"],
      where: { id: params.id },
      limit: 1,
    })
  )[0];
  if (!item) throw new HttpError(404, "Item not found");
  return Response.json(item);
});

router.post("/api/items", async ({ request, ctx }) => {
  const input = await readJson<{ title?: unknown }>(request);
  if (typeof input.title !== "string" || !input.title.trim()) throw new HttpError(400, "title is required");
  const item = { id: crypto.randomUUID(), title: input.title.trim() };
  await ctx.db.insert("items", item);
  return Response.json(item, { status: 201 });
});

export default defineApp({
  requires,
  async initialize(ctx) {
    await ctx.db.ensureTable("items", {
      id: { type: "text", primaryKey: true },
      title: { type: "text", required: true },
    });
  },
  fetch: router,
});
```

## Storage upload

```ts
const form = await request.formData();
const file = form.get("file");
if (!(file instanceof File) || file.size === 0) return Response.json({ error: "file is required" }, { status: 400 });
if (file.size > 10 * 1024 * 1024) return Response.json({ error: "file is too large" }, { status: 413 });
await ctx.storage.put(`uploads/${crypto.randomUUID()}`, file.stream(), { contentType: file.type });
```

Validate magic bytes or parse the content when the claimed media type affects security.

## Cookies

```ts
import { getCookie, serializeCookie } from "@nosrv/router";

const session = getCookie(request, "session");
const headers = new Headers();
headers.append("set-cookie", serializeCookie("session", token, {
  path: "/",
  httpOnly: true,
  secure: true,
  sameSite: "lax",
}));
```

Cookie helpers do not provide authentication, signing, encryption, or session storage.

## Static frontend and SPA

```yaml
app: ./src/app.ts
public:
  directory: ./dist
  spa: true
```

Keep backend routes under `/api`. The application receives missing routes before an HTML navigation falls back to `index.html`.
