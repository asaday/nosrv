import { defineApp } from "@nosrv/core";

export default defineApp({
  requires: {
    kv: true,
  },

  async fetch(request, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/" && request.method === "GET") {
      const limitValue = url.searchParams.get("limit");
      const limit = limitValue === null ? undefined : Number(limitValue);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) {
        return new Response("limit must be an integer between 1 and 1000", { status: 400 });
      }
      return Response.json(
        await ctx.kv.list({
          ...(url.searchParams.has("prefix") ? { prefix: url.searchParams.get("prefix")! } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}),
        }),
      );
    }
    const key = decodeURIComponent(url.pathname.slice(1));

    if (!key) return new Response("KV key is required", { status: 400 });

    if (request.method === "PUT") {
      const ttlValue = url.searchParams.get("ttl");
      const expirationTtl = ttlValue === null ? undefined : Number(ttlValue);
      if (expirationTtl !== undefined && (!Number.isInteger(expirationTtl) || expirationTtl < 60)) {
        return new Response("ttl must be an integer of at least 60 seconds", { status: 400 });
      }
      await ctx.kv.set(key, await request.text(), {
        ...(expirationTtl !== undefined ? { expirationTtl } : {}),
      });
      return new Response(null, { status: 204 });
    }
    if (request.method === "GET") {
      const value = await ctx.kv.get(key);
      return value === null ? new Response("Not found", { status: 404 }) : new Response(value);
    }
    if (request.method === "DELETE") {
      await ctx.kv.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response("Method not allowed", { status: 405 });
  },
});
