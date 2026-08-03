import { defineApp } from "@nosrv/core";

export default defineApp({
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/hello") {
      return Response.json({ message: "Hello from nosrv!" });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  },
});
