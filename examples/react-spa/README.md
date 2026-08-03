# React SPA example

An optional React and Vite frontend backed by a small nosrv HTTP handler. React is not required by nosrv; use this example only when client-side UI complexity justifies a framework and build step.

```bash
npm run dev:web
```

For a production-style nosrv run, build the frontend and serve `dist` with SPA fallback:

```bash
npm run build
npm run dev
```

Direct browser navigation falls back to `dist/index.html`, while missing API requests keep their normal response.

```bash
nosrv login --url http://127.0.0.1:3100
npm run deploy
```
