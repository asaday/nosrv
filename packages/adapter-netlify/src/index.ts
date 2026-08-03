import {
  EnvironmentSecrets,
  publicEnvironment,
  initializeApp,
  validateCapabilities,
  type AppContext,
  type Logger,
  type NosrvApp,
  type Resources,
  type User,
  MemoryResources,
} from "@nosrv/core";

export interface NetlifyContext {
  waitUntil?(promise: Promise<unknown>): void;
}

export interface NetlifyAdapterOptions {
  env?: Record<string, string>;
  resources?: Resources;
  resolveUser?: (request: Request, context: NetlifyContext) => User | null | Promise<User | null>;
}

export type NetlifyHandler = (request: Request, context: NetlifyContext) => Promise<Response>;

function writeLog(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  data?: unknown,
): void {
  console[level](JSON.stringify({ level, message, ...(data === undefined ? {} : { data }) }));
}

const logger: Logger = {
  debug: (message, data) => writeLog("debug", message, data),
  info: (message, data) => writeLog("info", message, data),
  warn: (message, data) => writeLog("warn", message, data),
  error: (message, data) => writeLog("error", message, data),
};

export function createNetlifyHandler(
  app: NosrvApp,
  options: NetlifyAdapterOptions = {},
): NetlifyHandler {
  return async (request, netlifyContext) => {
    const pending: Promise<unknown>[] = [];
    try {
      const allEnvironment = Object.freeze({ ...options.env, ...process.env });
      const context: AppContext = {
        env: publicEnvironment(allEnvironment),
        log: logger,
        platform: { name: "netlify" },
        waitUntil(promise) {
          if (netlifyContext.waitUntil) netlifyContext.waitUntil(promise);
          else pending.push(promise);
        },
        secrets: new EnvironmentSecrets(allEnvironment),
        resources: options.resources ?? new MemoryResources(),
        user: (await options.resolveUser?.(request, netlifyContext)) ?? null,
      };
      validateCapabilities(app, context);
      await initializeApp(app, context);
      const response = await app.fetch(request, context);
      if (!(response instanceof Response))
        throw new TypeError("app.fetch() must return a Response");
      await Promise.all(pending);
      return response;
    } catch (error) {
      writeLog("error", "Unhandled request error", {
        error: error instanceof Error ? error.message : String(error),
        path: new URL(request.url).pathname,
      });
      return Response.json({ error: "Internal Server Error" }, { status: 500 });
    }
  };
}
