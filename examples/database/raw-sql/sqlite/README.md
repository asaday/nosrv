# SQLite raw SQL example

This example uses SQLite-specific `AUTOINCREMENT` through the explicit `ctx.db.sql` escape hatch.

```bash
npm run dev
curl -X POST http://127.0.0.1:8787/ -d 'hello sqlite'
curl http://127.0.0.1:8787/
```
