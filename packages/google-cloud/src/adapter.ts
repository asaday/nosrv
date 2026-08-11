import type { HttpFunction, Request as GoogleRequest } from "@google-cloud/functions-framework";
import {
  EnvironmentSecrets,
  publicEnvironment,
  initializeApp,
  validateCapabilities,
  type AppContext,
  type Database,
  type KV,
  type Logger,
  type ObjectStorage,
  type NosrvApp,
  type ScheduledEvent,
  type Resources,
  type User,
  MemoryResources,
} from "@nosrv/core";
import { FirestoreKV } from "./firestore.js";
import { GCSObjectStorage } from "./gcs.js";
import { serveSpaFallback, serveStaticFile } from "nosrv/runtime/static-files";

export interface GoogleFunctionsAdapterOptions {
  env?: Record<string, string>;
  resources?: Resources;
  storage?: ObjectStorage;
  gcsBucket?: string;
  kv?: KV;
  firestoreCollection?: string;
  db?: Database;
  hiddenEnvNames?: readonly string[];
  assetsDirectory?: string;
  assetsSpaFallback?: boolean;
  resolveUser?: (request: Request) => User | null | Promise<User | null>;
}

export interface GoogleScheduledHandlerOptions extends GoogleFunctionsAdapterOptions {
  name: string;
  cron: string;
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

function googleRequestToWeb(request: GoogleRequest): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }

  const protocolHeader = request.headers["x-forwarded-proto"];
  const protocol = Array.isArray(protocolHeader)
    ? protocolHeader[0]
    : (protocolHeader ?? request.protocol ?? "https");
  const host = request.headers.host ?? "localhost";
  const path = request.originalUrl || request.url || "/";
  const method = request.method;
  const hasBody = method !== "GET" && method !== "HEAD";

  return new Request(`${protocol}://${host}${path}`, {
    method,
    headers,
    body: hasBody && request.rawBody ? Uint8Array.from(request.rawBody) : undefined,
  });
}

export function createGoogleFunctionsHandler(
  app: NosrvApp,
  options: GoogleFunctionsAdapterOptions = {},
): HttpFunction {
  const storage =
    options.storage ?? (options.gcsBucket ? new GCSObjectStorage(options.gcsBucket) : undefined);
  const kv =
    options.kv ??
    (options.firestoreCollection ? new FirestoreKV(options.firestoreCollection) : undefined);
  return async (incoming, outgoing) => {
    try {
      const pending: Promise<unknown>[] = [];
      const allEnvironment = Object.freeze({ ...options.env, ...process.env });
      const request = googleRequestToWeb(incoming);
      if (options.assetsDirectory) {
        const asset = await serveStaticFile(request, options.assetsDirectory);
        if (asset) {
          outgoing.status(asset.status);
          asset.headers.forEach((value, name) => outgoing.setHeader(name, value));
          outgoing.send(Buffer.from(await asset.arrayBuffer()));
          return;
        }
      }
      const context: AppContext = {
        env: publicEnvironment(allEnvironment, options.hiddenEnvNames),
        log: logger,
        platform: { name: "google-functions" },
        waitUntil: (promise) => pending.push(promise),
        ...(storage ? { storage } : {}),
        ...(kv ? { kv } : {}),
        ...(options.db ? { db: options.db } : {}),
        secrets: new EnvironmentSecrets(allEnvironment),
        resources: options.resources ?? new MemoryResources(),
        bindings: Object.freeze({}),
        user: (await options.resolveUser?.(request)) ?? null,
      };
      validateCapabilities(app, context);
      await initializeApp(app, context);
      let response = await app.fetch(request, context);

      if (!(response instanceof Response)) {
        throw new TypeError("app.fetch() must return a Response");
      }
      if (response.status === 404 && options.assetsDirectory && options.assetsSpaFallback) {
        response = (await serveSpaFallback(request, options.assetsDirectory)) ?? response;
      }

      outgoing.status(response.status);
      response.headers.forEach((value, name) => {
        if (name !== "set-cookie") outgoing.setHeader(name, value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) outgoing.setHeader("set-cookie", cookies);

      if (!response.body) {
        outgoing.end();
        await Promise.all(pending);
        return;
      }
      outgoing.send(Buffer.from(await response.arrayBuffer()));
      await Promise.all(pending);
    } catch (error) {
      writeLog("error", "Unhandled request error", {
        error: error instanceof Error ? error.message : String(error),
        path: incoming.path,
      });
      if (!outgoing.headersSent) {
        outgoing.status(500).json({ error: "Internal Server Error" });
      } else {
        outgoing.end();
      }
    }
  };
}

export function createGoogleScheduledHandler(
  app: NosrvApp,
  options: GoogleScheduledHandlerOptions,
): HttpFunction {
  if (!app.scheduled) throw new Error("App does not export scheduled()");
  const storage =
    options.storage ?? (options.gcsBucket ? new GCSObjectStorage(options.gcsBucket) : undefined);
  const kv =
    options.kv ??
    (options.firestoreCollection ? new FirestoreKV(options.firestoreCollection) : undefined);
  return async (incoming, outgoing) => {
    try {
      const pending: Promise<unknown>[] = [];
      const allEnvironment = Object.freeze({ ...options.env, ...process.env });
      const context: AppContext = {
        env: publicEnvironment(allEnvironment, options.hiddenEnvNames),
        log: logger,
        platform: { name: "google-functions" },
        waitUntil: (promise) => pending.push(promise),
        ...(storage ? { storage } : {}),
        ...(kv ? { kv } : {}),
        ...(options.db ? { db: options.db } : {}),
        secrets: new EnvironmentSecrets(allEnvironment),
        resources: options.resources ?? new MemoryResources(),
        bindings: Object.freeze({}),
        user: null,
      };
      validateCapabilities(app, context);
      await initializeApp(app, context);
      const scheduledTimeHeader = incoming.headers["x-cloudscheduler-scheduletime"];
      const scheduledTime =
        typeof scheduledTimeHeader === "string" ? Date.parse(scheduledTimeHeader) : Date.now();
      const event: ScheduledEvent = {
        name: options.name,
        cron: options.cron,
        scheduledTime: Number.isFinite(scheduledTime) ? scheduledTime : Date.now(),
        trigger: "cron",
      };
      await app.scheduled!(event, context);
      await Promise.all(pending);
      outgoing.status(204).end();
    } catch (error) {
      writeLog("error", "Unhandled scheduled error", {
        error: error instanceof Error ? error.message : String(error),
        schedule: options.name,
      });
      if (!outgoing.headersSent) outgoing.status(500).json({ error: "Internal Server Error" });
      else outgoing.end();
    }
  };
}
