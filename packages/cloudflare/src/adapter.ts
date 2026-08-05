import {
  EnvironmentSecrets,
  publicEnvironment,
  initializeApp,
  validateCapabilities,
  type AppContext,
  type Logger,
  type NosrvApp,
  type ScheduledEvent,
  type Resources,
  type User,
  MemoryResources,
} from "@nosrv/core";
import { CloudflareKV, type WorkersKVNamespaceLike } from "./kv.js";
import { R2ObjectStorage, type R2BucketLike } from "./r2.js";
import { D1Database, type D1DatabaseLike } from "./d1.js";

export type CloudflareEnvironment = object;

export interface CloudflareHandler<Env extends CloudflareEnvironment> {
  fetch(
    request: Request,
    env: Env,
    execution: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<Response>;
  scheduled?(
    controller: { cron: string; scheduledTime: number },
    env: Env,
    execution: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<void>;
}

export interface CloudflareSchedule {
  name: string;
  cron: string;
}

export interface CloudflareAdapterOptions {
  env?: Record<string, string>;
  resources?: Resources;
  r2Binding?: string;
  kvBinding?: string;
  d1Binding?: string;
  schedules?: readonly CloudflareSchedule[];
  resolveUser?: (
    request: Request,
    env: CloudflareEnvironment,
  ) => User | null | Promise<User | null>;
}

function isR2Bucket(value: unknown): value is R2BucketLike {
  return (
    typeof value === "object" &&
    value !== null &&
    ["get", "put", "delete", "head", "list"].every(
      (name) => name in value && typeof Reflect.get(value, name) === "function",
    )
  );
}

function isKVNamespace(value: unknown): value is WorkersKVNamespaceLike {
  return (
    typeof value === "object" &&
    value !== null &&
    ["get", "put", "delete"].every(
      (name) => name in value && typeof Reflect.get(value, name) === "function",
    )
  );
}

function isD1Database(value: unknown): value is D1DatabaseLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "prepare") === "function"
  );
}

function writeLog(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  data?: unknown,
): void {
  const entry = JSON.stringify({ level, message, ...(data === undefined ? {} : { data }) });
  console[level](entry);
}

const logger: Logger = {
  debug: (message, data) => writeLog("debug", message, data),
  info: (message, data) => writeLog("info", message, data),
  warn: (message, data) => writeLog("warn", message, data),
  error: (message, data) => writeLog("error", message, data),
};

function portableEnvironment(
  env: CloudflareEnvironment,
): Readonly<Record<string, string | undefined>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
  );
}

async function createContext(
  app: NosrvApp,
  env: CloudflareEnvironment,
  execution: { waitUntil(promise: Promise<unknown>): void },
  options: CloudflareAdapterOptions,
  request?: Request,
): Promise<AppContext> {
  const r2Bucket = options.r2Binding ? Reflect.get(env, options.r2Binding) : undefined;
  const kvNamespace = options.kvBinding ? Reflect.get(env, options.kvBinding) : undefined;
  const d1 = options.d1Binding ? Reflect.get(env, options.d1Binding) : undefined;
  const allEnvironment = Object.freeze({ ...options.env, ...portableEnvironment(env) });
  const context: AppContext = {
    env: allEnvironment,
    log: logger,
    platform: { name: "cloudflare" },
    waitUntil: (promise) => execution.waitUntil(promise),
    ...(isR2Bucket(r2Bucket) ? { storage: new R2ObjectStorage(r2Bucket) } : {}),
    ...(isKVNamespace(kvNamespace) ? { kv: new CloudflareKV(kvNamespace) } : {}),
    ...(isD1Database(d1) ? { db: new D1Database(d1) } : {}),
    secrets: new EnvironmentSecrets(allEnvironment),
    resources: options.resources ?? new MemoryResources(),
    user: request ? ((await options.resolveUser?.(request, env)) ?? null) : null,
  };
  validateCapabilities(app, context);
  return context;
}

export function createCloudflareHandler<Env extends CloudflareEnvironment>(
  app: NosrvApp,
  options: CloudflareAdapterOptions = {},
): CloudflareHandler<Env> {
  const handler: CloudflareHandler<Env> = {
    async fetch(request, env, execution) {
      try {
        const context = await createContext(app, env, execution, options, request);
        await initializeApp(app, context);
        const response = await app.fetch(request, context);

        if (!(response instanceof Response)) {
          throw new TypeError("app.fetch() must return a Response");
        }

        return response;
      } catch (error) {
        writeLog("error", "Unhandled request error", {
          error: error instanceof Error ? error.message : String(error),
          path: new URL(request.url).pathname,
        });
        return Response.json({ error: "Internal Server Error" }, { status: 500 });
      }
    },
  };
  if (app.scheduled) {
    handler.scheduled = async (controller, env, execution) => {
      const schedule = options.schedules?.find((candidate) => candidate.cron === controller.cron);
      const event: ScheduledEvent = {
        name: schedule?.name ?? controller.cron,
        cron: controller.cron,
        scheduledTime: controller.scheduledTime,
        trigger: "cron",
      };
      const context = await createContext(app, env, execution, options);
      await initializeApp(app, context);
      await app.scheduled!(event, context);
    };
  }
  return handler;
}
