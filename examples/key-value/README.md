# Key-value example

This App declares persistent key-value storage and uses it through `ctx.kv`.

```bash
npm run dev
curl -X PUT http://127.0.0.1:8787/greeting -d 'hello'
curl http://127.0.0.1:8787/greeting
curl 'http://127.0.0.1:8787/?prefix=greet&limit=100'
curl -X PUT 'http://127.0.0.1:8787/session?ttl=3600' -d 'temporary'
curl -X DELETE http://127.0.0.1:8787/greeting
```

`GET /` lists keys and returns an opaque `cursor` while more pages remain. Pass that cursor back with the same prefix to continue. `PUT` accepts an optional `ttl` of at least 60 seconds.

Local KV persists under `.nosrv/`. Cloudflare, Lambda, and Google providers reference external KV services; create those resources and configure their credentials before cloud deployment.

Provider-specific development entrypoints are available as `npm run dev:cloudflare`, `npm run dev:google`, and `npm run dev:lambda`. Wrangler provides local Workers KV emulation. Google and Lambda development use the configured Firestore collection and DynamoDB table, so they require credentials and those cloud resources.

```bash
nosrv login --url http://127.0.0.1:3100
npm run deploy
```
