import { defineApp } from "@nosrv/core";
import { createRouter } from "@nosrv/router";
import { prepareDatabase } from "./database.ts";
import { registerEntryRoutes } from "./routes/entries.ts";

export default defineApp({
  requires: { db: true, storage: true },
  initialize: prepareDatabase,
  fetch: createRouter(registerEntryRoutes),
});
