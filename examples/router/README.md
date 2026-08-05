# Router example

The Router API exported by `@nosrv/core` provides the small routing layer commonly used from Express: method routes, path-scoped middleware with `next()`, handler chains, path parameters, query strings, JSON/form helpers, cookies, and automatic 404/405 responses. Routes, middleware, and mounts run in registration order. Handlers still receive Web Standard `Request` and return `Response`, so the application remains portable across nosrv targets.

```bash
npm run dev
```

Try the routes:

```bash
curl 'http://127.0.0.1:8787/api/hello?name=Ada'
curl http://127.0.0.1:8787/api/users/42
curl -i -X POST http://127.0.0.1:8787/api/messages \
  -H 'content-type: application/json' \
  -d '{"text":"hello"}'
curl -i -X DELETE http://127.0.0.1:8787/api/messages/42
```

This is intentionally not a full Express clone. Server startup, provider integration, and capabilities remain nosrv responsibilities; the router only keeps multi-route HTTP applications tidy.
