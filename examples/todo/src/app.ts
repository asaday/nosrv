import { defineApp } from "@nosrv/core";
import { createRouter } from "@nosrv/router";
import { prepareDatabase } from "./database.ts";
import { registerTodoRoutes } from "./routes/todos.ts";

export default defineApp({
  requires: { db: true },
  initialize: prepareDatabase,
  fetch: createRouter(registerTodoRoutes),
});
