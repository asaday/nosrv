import { defineApp } from "@nosrv/core";

export default defineApp({
  async fetch(request, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/config") {
      const defaults = await ctx.resources.get("defaults.json");
      return Response.json({
        message: "This App uses the intentionally verbose nosrv.yaml reference.",
        defaults: defaults ? JSON.parse(await defaults.text()) : null,
      });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  },

  scheduled(event, ctx) {
    ctx.log.info("Example scheduled task", { name: event.name });
  },
});
