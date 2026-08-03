# Todo App example

A small full-stack App with a plain HTML frontend, `@nosrv/router`, runtime input validation, and portable relational CRUD. The same application operations and schema run on SQLite, D1, and PostgreSQL without handwritten SQL.

```bash
npm run dev
```

Open <http://127.0.0.1:8787/>. Local data persists in `.nosrv/todo.sqlite`. The Cloudflare configuration requires a provisioned D1 database with the configured name and ID.

Use `npm run dev:cloudflare` for local D1 emulation. `npm run dev:google` and `npm run dev:lambda` run the same CRUD operations against the PostgreSQL database selected by `DATABASE_URL`.

```bash
nosrv login --url http://127.0.0.1:3100
npm run deploy
```
