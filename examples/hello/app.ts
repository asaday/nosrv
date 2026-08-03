import { defineApp } from "@nosrv/core";

export default defineApp({
  async fetch(request, ctx) {
    const url = new URL(request.url);
    ctx.log.info(`${request.method} ${url.pathname}`);

    return Response.json({
      message: "Hello from nosrv!",
      path: url.pathname,
    });
  },
});
