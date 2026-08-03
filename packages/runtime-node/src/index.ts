import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import {
  validateCapabilities,
  initializeApp,
  EnvironmentSecrets,
  publicEnvironment,
  type AppContext,
  type Database,
  type KV,
  type Logger,
  type ObjectStorage,
  type Resources,
  type NosrvApp,
  type ScheduledEvent,
  type Secrets,
  type User,
} from "@nosrv/core";
import { FilesystemObjectStorage } from "@nosrv/provider-filesystem";
import { MemoryResources } from "@nosrv/core";
import { SQLiteDatabase, SQLiteKV } from "@nosrv/provider-sqlite";
import { serveSpaFallback, serveStaticFile } from "@nosrv/provider-static-files";

export interface NodeRuntimeOptions {
  hostname?: string;
  port?: number;
  env?: Record<string, string | undefined>;
  hiddenEnvNames?: readonly string[];
  logger?: Logger;
  kv?: KV;
  storage?: ObjectStorage;
  db?: Database;
  resources?: Resources;
  assetsDirectory?: string;
  assetsCacheControl?: string;
  assetsSpaFallback?: boolean;
  secrets?: Secrets;
  resolveUser?: (request: Request) => User | null | Promise<User | null>;
}

const consoleLogger: Logger = {
  debug: (message, data) => console.debug(message, data ?? ""),
  info: (message, data) => console.info(message, data ?? ""),
  warn: (message, data) => console.warn(message, data ?? ""),
  error: (message, data) => console.error(message, data ?? ""),
};

export function resolveSignedPlatformUser(request: Request, secret: string): User | null {
  const encoded = request.headers.get("x-nosrv-user");
  const signature = request.headers.get("x-nosrv-user-signature");
  if (!encoded || !signature) return null;
  const expected = createHmac("sha256", secret).update(encoded).digest("base64url");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return null;
  }
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const id = Reflect.get(value, "id");
    const email = Reflect.get(value, "email");
    const name = Reflect.get(value, "name");
    const thumbnail = Reflect.get(value, "thumbnail");
    if (typeof id !== "string" || !id) return null;
    if (email !== undefined && typeof email !== "string") return null;
    if (name !== undefined && typeof name !== "string") return null;
    if (thumbnail !== undefined && typeof thumbnail !== "string") return null;
    return {
      id,
      ...(email ? { email } : {}),
      ...(name ? { name } : {}),
      ...(thumbnail ? { thumbnail } : {}),
    };
  } catch {
    return null;
  }
}

interface ContextResources {
  logger: Logger;
  allEnvironment: Readonly<Record<string, string | undefined>>;
  env: Readonly<Record<string, string | undefined>>;
  kv?: KV;
  storage?: ObjectStorage;
  db?: Database;
  secrets: Secrets;
  resources: Resources;
}

function contextResources(app: NosrvApp, options: NodeRuntimeOptions): ContextResources {
  const logger = options.logger ?? consoleLogger;
  const allEnvironment = Object.freeze({ ...(options.env ?? process.env) });
  return {
    logger,
    allEnvironment,
    env: publicEnvironment(allEnvironment, options.hiddenEnvNames),
    ...(app.requires?.kv ? { kv: options.kv ?? new SQLiteKV() } : {}),
    ...(app.requires?.storage
      ? {
          storage:
            options.storage ??
            new FilesystemObjectStorage(resolve(process.cwd(), ".nosrv/storage")),
        }
      : {}),
    ...(app.requires?.db ? { db: options.db ?? new SQLiteDatabase() } : {}),
    secrets: options.secrets ?? new EnvironmentSecrets(allEnvironment),
    resources: options.resources ?? new MemoryResources(),
  };
}

async function appContext(
  app: NosrvApp,
  options: NodeRuntimeOptions,
  resources: ContextResources,
  request?: Request,
): Promise<AppContext> {
  const context: AppContext = {
    env: resources.env,
    log: resources.logger,
    platform: { name: "node" },
    waitUntil(promise) {
      void promise.catch((error) => resources.logger.error("Background task failed", error));
    },
    ...(resources.kv ? { kv: resources.kv } : {}),
    ...(resources.storage ? { storage: resources.storage } : {}),
    ...(resources.db ? { db: resources.db } : {}),
    secrets: resources.secrets,
    resources: resources.resources,
    user: request ? ((await options.resolveUser?.(request)) ?? null) : null,
  };
  validateCapabilities(app, context);
  return context;
}

function requestHasBody(method: string | undefined): boolean {
  return method !== "GET" && method !== "HEAD";
}

export function toWebRequest(request: IncomingMessage): Request {
  const host = request.headers.host ?? "localhost";
  const url = new URL(request.url ?? "/", `http://${host}`);
  const headers = new Headers();

  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }

  return new Request(url, {
    method: request.method,
    headers,
    body: requestHasBody(request.method) ? request : undefined,
    duplex: requestHasBody(request.method) ? "half" : undefined,
  } as RequestInit);
}

export async function sendWebResponse(response: Response, target: ServerResponse): Promise<void> {
  target.statusCode = response.status;
  target.statusMessage = response.statusText;
  response.headers.forEach((value, name) => target.setHeader(name, value));

  if (!response.body) {
    target.end();
    return;
  }

  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!target.write(value)) {
        await new Promise<void>((resolve) => target.once("drain", resolve));
      }
    }
  } finally {
    if (!target.writableEnded && !target.destroyed) target.end();
  }
}

export function createNodeServer(app: NosrvApp, options: NodeRuntimeOptions = {}): Server {
  const resources = contextResources(app, options);

  return createServer(async (incoming, outgoing) => {
    try {
      const request = toWebRequest(incoming);
      if (options.assetsDirectory) {
        const asset = await serveStaticFile(request, options.assetsDirectory, {
          ...(options.assetsCacheControl ? { cacheControl: options.assetsCacheControl } : {}),
        });
        if (asset) {
          await sendWebResponse(asset, outgoing);
          return;
        }
      }
      const context = await appContext(app, options, resources, request);
      await initializeApp(app, context);
      let response = await app.fetch(request, context);
      if (!(response instanceof Response)) {
        throw new TypeError("app.fetch() must return a Response");
      }
      if (response.status === 404 && options.assetsDirectory && options.assetsSpaFallback) {
        response =
          (await serveSpaFallback(request, options.assetsDirectory, {
            ...(options.assetsCacheControl ? { cacheControl: options.assetsCacheControl } : {}),
          })) ?? response;
      }
      await sendWebResponse(response, outgoing);
    } catch (error) {
      resources.logger.error("Unhandled request error", error);
      if (!outgoing.headersSent) {
        outgoing.statusCode = 500;
        outgoing.setHeader("content-type", "text/plain; charset=utf-8");
      }
      if (!outgoing.writableEnded && !outgoing.destroyed) {
        outgoing.end("Internal Server Error");
      }
    }
  });
}

export function createScheduledRunner(
  app: NosrvApp,
  options: NodeRuntimeOptions = {},
): (event: ScheduledEvent) => Promise<void> {
  if (!app.scheduled) throw new Error("App does not export scheduled()");
  const resources = contextResources(app, options);
  return async (event) => {
    const context = await appContext(app, options, resources);
    await initializeApp(app, context);
    await app.scheduled!(event, context);
  };
}

export async function listen(
  app: NosrvApp,
  options: NodeRuntimeOptions = {},
): Promise<{ server: Server; hostname: string; port: number }> {
  const hostname = options.hostname ?? "127.0.0.1";
  const requestedPort = options.port ?? 8787;
  const server = createNodeServer(app, options);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, hostname, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : requestedPort;
  return { server, hostname, port };
}
