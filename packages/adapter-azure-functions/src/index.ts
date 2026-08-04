import type {
  HttpHandler,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
  Timer,
  TimerHandler,
} from "@azure/functions";
import {
  EnvironmentSecrets,
  initializeApp,
  MemoryResources,
  publicEnvironment,
  validateCapabilities,
  type AppContext,
  type Database,
  type KV,
  type Logger,
  type NosrvApp,
  type ObjectStorage,
  type Resources,
  type ScheduledEvent,
  type User,
} from "@nosrv/core";
import { AzureBlobObjectStorage } from "@nosrv/provider-azure-blob";
import { CosmosKV } from "@nosrv/provider-cosmos";
import { serveSpaFallback, serveStaticFile } from "@nosrv/provider-static-files";

export interface AzureFunctionsAdapterOptions {
  env?: Record<string, string>;
  resources?: Resources;
  storage?: ObjectStorage;
  blobContainer?: string;
  blobConnectionStringEnv?: string;
  kv?: KV;
  cosmosDatabase?: string;
  cosmosContainer?: string;
  cosmosConnectionStringEnv?: string;
  db?: Database;
  hiddenEnvNames?: readonly string[];
  assetsDirectory?: string;
  assetsSpaFallback?: boolean;
  resolveUser?: (
    request: Request,
    context: InvocationContext,
  ) => User | null | Promise<User | null>;
}

export interface AzureTimerHandlerOptions extends AzureFunctionsAdapterOptions {
  name: string;
  cron: string;
}

function logger(context: InvocationContext): Logger {
  return {
    debug: (message, data) => context.debug(message, data),
    info: (message, data) => context.info(message, data),
    warn: (message, data) => context.warn(message, data),
    error: (message, data) => context.error(message, data),
  };
}

async function azureRequestToWeb(request: HttpRequest): Promise<Request> {
  const method = request.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(request.url, {
    method,
    headers: request.headers,
    body: hasBody ? new Uint8Array(await request.arrayBuffer()) : undefined,
  });
}

function environment(options: AzureFunctionsAdapterOptions): Readonly<Record<string, string>> {
  return Object.freeze({ ...options.env, ...process.env }) as Readonly<Record<string, string>>;
}

function resources(
  options: AzureFunctionsAdapterOptions,
  values: Readonly<Record<string, string>>,
) {
  const storage =
    options.storage ??
    (options.blobContainer && options.blobConnectionStringEnv
      ? new AzureBlobObjectStorage(
          options.blobContainer,
          requiredEnvironment(values, options.blobConnectionStringEnv, "Azure Blob Storage"),
        )
      : undefined);
  const kv =
    options.kv ??
    (options.cosmosDatabase && options.cosmosContainer && options.cosmosConnectionStringEnv
      ? new CosmosKV(
          requiredEnvironment(values, options.cosmosConnectionStringEnv, "Cosmos DB"),
          options.cosmosDatabase,
          options.cosmosContainer,
        )
      : undefined);
  return { storage, kv };
}

function requiredEnvironment(
  values: Readonly<Record<string, string>>,
  name: string,
  service: string,
): string {
  const value = values[name];
  if (!value) throw new Error(`${service} requires ${name}`);
  return value;
}

async function appContext(
  request: Request | null,
  invocation: InvocationContext,
  options: AzureFunctionsAdapterOptions,
  pending: Promise<unknown>[],
): Promise<AppContext> {
  const values = environment(options);
  const configured = resources(options, values);
  return {
    env: publicEnvironment(values, options.hiddenEnvNames),
    log: logger(invocation),
    platform: { name: "azure-functions" },
    waitUntil: (promise) => pending.push(promise),
    ...(configured.storage ? { storage: configured.storage } : {}),
    ...(configured.kv ? { kv: configured.kv } : {}),
    ...(options.db ? { db: options.db } : {}),
    secrets: new EnvironmentSecrets(values),
    resources: options.resources ?? new MemoryResources(),
    user: request ? ((await options.resolveUser?.(request, invocation)) ?? null) : null,
  };
}

async function responseInit(response: Response): Promise<HttpResponseInit> {
  const cookies = response.headers.getSetCookie();
  const headers: [string, string][] = [];
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") headers.push([name, value]);
  });
  for (const cookie of cookies) headers.push(["set-cookie", cookie]);
  return {
    status: response.status,
    headers,
    ...(response.body ? { body: new Uint8Array(await response.arrayBuffer()) } : {}),
  };
}

export function createAzureHttpHandler(
  app: NosrvApp,
  options: AzureFunctionsAdapterOptions = {},
): HttpHandler {
  return async (incoming, invocation) => {
    const pending: Promise<unknown>[] = [];
    try {
      const request = await azureRequestToWeb(incoming);
      if (options.assetsDirectory) {
        const asset = await serveStaticFile(request, options.assetsDirectory);
        if (asset) return responseInit(asset);
      }
      const context = await appContext(request, invocation, options, pending);
      validateCapabilities(app, context);
      await initializeApp(app, context);
      let response = await app.fetch(request, context);
      if (!(response instanceof Response))
        throw new TypeError("app.fetch() must return a Response");
      if (response.status === 404 && options.assetsDirectory && options.assetsSpaFallback) {
        response = (await serveSpaFallback(request, options.assetsDirectory)) ?? response;
      }
      await Promise.all(pending);
      return responseInit(response);
    } catch (error) {
      invocation.error("Unhandled request error", error);
      return { status: 500, jsonBody: { error: "Internal Server Error" } };
    }
  };
}

export function createAzureTimerHandler(
  app: NosrvApp,
  options: AzureTimerHandlerOptions,
): TimerHandler {
  if (!app.scheduled) throw new Error("App does not export scheduled()");
  return async (timer: Timer, invocation: InvocationContext) => {
    const pending: Promise<unknown>[] = [];
    const context = await appContext(null, invocation, options, pending);
    validateCapabilities(app, context);
    await initializeApp(app, context);
    const scheduleStatus = timer.scheduleStatus;
    const scheduled = scheduleStatus?.last
      ? Date.parse(scheduleStatus.last)
      : scheduleStatus?.next
        ? Date.parse(scheduleStatus.next)
        : Date.now();
    const event: ScheduledEvent = {
      name: options.name,
      cron: options.cron,
      scheduledTime: Number.isFinite(scheduled) ? scheduled : Date.now(),
      trigger: "cron",
    };
    await app.scheduled!(event, context);
    await Promise.all(pending);
  };
}
