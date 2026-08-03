# D1 raw SQL example

This example uses D1/SQLite-specific automatic IDs and `datetime('now')` through `ctx.db.sql`.

```bash
npm run dev
curl -X POST http://127.0.0.1:8787/ -d 'hello d1'
curl http://127.0.0.1:8787/
```
