# Portable database example

This App demonstrates the recommended portable relational CRUD API without handwritten SQL. The same schema and operations run on SQLite, D1, and PostgreSQL.

```bash
npm run dev
curl -X POST http://127.0.0.1:8787/ -d 'hello'
curl http://127.0.0.1:8787/
curl -X DELETE 'http://127.0.0.1:8787/?id=MESSAGE_ID'
```

Local development persists SQLite data under `.nosrv/`. Use `npm run dev:cloudflare` for local D1 emulation. `npm run dev:google` and `npm run dev:lambda` use the PostgreSQL database selected by `DATABASE_URL`.

Provider-specific SQL escape hatches are intentionally separated under [`raw-sql`](./raw-sql/). Portable generated IDs can be declared with `id: { type: "integer", primaryKey: true, generated: "identity" }`; use raw SQL only when provider-specific behavior such as SQLite `AUTOINCREMENT` is required.

`ensureTable` creates missing tables but does not alter an existing schema. Production schema evolution remains an explicit migration responsibility.

```bash
nosrv login --url http://127.0.0.1:3100
npm run deploy
```
