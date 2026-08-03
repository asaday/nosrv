import { defineApp } from "@nosrv/core";
import { createRouter, limitBody } from "@nosrv/router";

const requires = { storage: true } as const;
const router = createRouter<typeof requires>();

router.all("/*", async ({ request, ctx }) => {
  const url = new URL(request.url);
  const key = decodeURIComponent(url.pathname.slice(1));

  if (request.method === "GET" && url.pathname === "/") {
    const result = await ctx.storage.list();
    return Response.json(result);
  }

  if (!key) return new Response("Object key is required", { status: 400 });

  if (request.method === "PUT") {
    if (!request.body) return new Response("Body is required", { status: 400 });
    const result = await ctx.storage.put(
      key,
      limitBody(request.body, { maxSize: 10 * 1024 * 1024 }),
      {
        contentType: request.headers.get("content-type") ?? undefined,
      },
    );
    return Response.json(result, { status: 201 });
  }

  if (request.method === "GET") {
    const object = await ctx.storage.get(key);
    if (!object) return new Response("Not found", { status: 404 });
    return new Response(object.body, {
      headers: {
        "content-type": object.metadata.contentType ?? "application/octet-stream",
        ...(object.metadata.etag ? { etag: object.metadata.etag } : {}),
      },
    });
  }

  if (request.method === "DELETE") {
    await ctx.storage.delete(key);
    return new Response(null, { status: 204 });
  }

  return new Response("Method not allowed", { status: 405 });
});

export default defineApp({
  requires,
  fetch: router,
});
