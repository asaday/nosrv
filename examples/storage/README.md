# Object storage example

This App streams request and response bodies through the portable `storage` capability. It supports listing, uploading, downloading, and deleting objects.

```bash
npm run dev
curl -X PUT http://127.0.0.1:8787/hello.txt -H 'content-type: text/plain' -d 'hello'
curl http://127.0.0.1:8787/hello.txt
curl http://127.0.0.1:8787/
curl -X DELETE http://127.0.0.1:8787/hello.txt
```

Node.js uses `.nosrv/storage`. Provider-specific development entrypoints are available as `npm run dev:cloudflare`, `npm run dev:google`, and `npm run dev:lambda`. Wrangler provides local R2 emulation. Google and Lambda development use the configured GCS and S3 buckets, so they require credentials and provisioned buckets. Upload streams are limited to 10 MiB with `limitBody()` before being passed to storage.

```bash
nosrv login --url http://127.0.0.1:3100
npm run deploy
```
