# Provider-specific raw SQL examples

These examples use `ctx.db.sql`, the explicit escape hatch for SQL outside portable CRUD. Each directory is self-contained because schema syntax, generated IDs, result values, and advanced features differ by dialect.

- [`sqlite`](./sqlite/) — standalone Node.js with SQLite SQL
- [`postgres`](./postgres/) — Node.js, Google Functions, or Lambda with PostgreSQL SQL
- [`d1`](./d1/) — Cloudflare Workers with D1 SQL

Prefer the parent [`database`](../) example unless an App intentionally accepts a database-dialect dependency.
