# Hello example

The smallest handler-based nosrv App. Its root `app.ts` shows the Web Standard `Request` → `Response` contract and structured logging without configuration or capabilities.

```bash
npm run dev
curl http://127.0.0.1:8787/hello
```

Use this as the starting point for a small HTTP service. `npm run dev:cloudflare`, `npm run dev:google`, and `npm run dev:lambda` exercise provider-specific local emulators when their official CLIs are installed.

Deploy to a self-hosted Platform with:

```bash
nosrv login --url http://127.0.0.1:3100
npm run deploy
```
