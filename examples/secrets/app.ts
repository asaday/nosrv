import { defineApp } from "@nosrv/core";

export default defineApp({
  async fetch(_request, ctx) {
    const secretConfigured = (await ctx.secrets.get("GREETING_SECRET")) !== null;
    const environmentConfigured = ctx.env.GREETING_SECRET !== undefined;

    return Response.json({ secretConfigured, environmentConfigured });
  },
});
