import { defineApp } from "@nosrv/core";
import { createRouter, HttpError, json, noContent, readJson } from "@nosrv/core";

const router = createRouter();

router.use(async ({ request, ctx, url }, next) => {
  const started = performance.now();
  const response = await next();
  ctx.log.info(`${request.method} ${url.pathname}`);
  response.headers.set("server-timing", `app;dur=${performance.now() - started}`);
  return response;
});

router.get("/", () =>
  json({
    message: "nosrv router example",
    routes: [
      "GET /api/hello?name=Ada",
      "GET /api/users/:id",
      "GET /api/status",
      "POST /api/messages",
      "DELETE /api/messages/:id",
    ],
  }),
);

const status = createRouter();
status.get("/", () => json({ ok: true }));
router.mount("/api/status", status);

router.get("/api/hello", ({ query }) => {
  const name = query.get("name")?.trim() || "world";
  return json({ message: `Hello, ${name}!` });
});

router.get("/api/users/:id", ({ params }) => {
  return json({ id: params.id, displayName: `User ${params.id}` });
});

router.post("/api/messages", async ({ request }) => {
  const input = await readJson<{ text?: unknown }>(request, { maxSize: 64 * 1024 });
  if (typeof input.text !== "string" || !input.text.trim()) {
    throw new HttpError(400, "text is required");
  }
  return json({ id: crypto.randomUUID(), text: input.text.trim() }, 201);
});

router.delete("/api/messages/:id", () => noContent());

export default defineApp({
  fetch: router,
});
