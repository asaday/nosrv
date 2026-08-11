import { Buffer } from "node:buffer";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from "aws-lambda";
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
import { DynamoDBKV } from "./dynamodb.js";
import { S3ObjectStorage } from "./s3.js";
import { serveSpaFallback, serveStaticFile } from "nosrv/runtime/static-files";

export type LambdaHttpHandler = (
  event: APIGatewayProxyEventV2,
  context: Context,
) => Promise<APIGatewayProxyStructuredResultV2>;

export interface LambdaScheduledEvent {
  source?: string;
  time?: string;
  resources?: string[];
  detail?: {
    name?: string;
    cron?: string;
  };
}

export type LambdaScheduledHandler = (
  event: LambdaScheduledEvent,
  context: Context,
) => Promise<void>;

export interface LambdaAdapterOptions {
  env?: Record<string, string>;
  resources?: Resources;
  storage?: ObjectStorage;
  s3Bucket?: string;
  kv?: KV;
  dynamodbTable?: string;
  db?: Database;
  hiddenEnvNames?: readonly string[];
  assetsDirectory?: string;
  assetsSpaFallback?: boolean;
  resolveUser?: (event: APIGatewayProxyEventV2) => User | null | Promise<User | null>;
}

function authorizerUser(event: APIGatewayProxyEventV2): User | null {
  const authorizer = Reflect.get(event.requestContext, "authorizer");
  if (typeof authorizer !== "object" || authorizer === null) return null;
  const jwt = Reflect.get(authorizer, "jwt");
  if (typeof jwt !== "object" || jwt === null) return null;
  const claims = Reflect.get(jwt, "claims");
  if (typeof claims !== "object" || claims === null) return null;
  const id = Reflect.get(claims, "sub");
  if (typeof id !== "string" || !id) return null;
  const email = Reflect.get(claims, "email");
  return { id, ...(typeof email === "string" ? { email } : {}) };
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

function eventUrl(event: APIGatewayProxyEventV2): URL {
  const protocol = event.headers["x-forwarded-proto"] ?? "https";
  const host = event.headers.host ?? event.requestContext.domainName;
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  return new URL(`${protocol}://${host}${event.rawPath}${query}`);
}

export function lambdaEventToRequest(event: APIGatewayProxyEventV2): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers)) {
    if (value !== undefined) headers.set(name, value);
  }
  if (event.cookies?.length) headers.set("cookie", event.cookies.join("; "));

  const method = event.requestContext.http.method;
  const hasBody = method !== "GET" && method !== "HEAD" && event.body !== undefined;
  const body = hasBody
    ? event.isBase64Encoded
      ? Buffer.from(event.body ?? "", "base64")
      : event.body
    : undefined;

  return new Request(eventUrl(event), { method, headers, body });
}

function isTextContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const type = contentType.split(";", 1)[0].trim().toLowerCase();
  return (
    type.startsWith("text/") ||
    type === "application/json" ||
    type.endsWith("+json") ||
    type === "application/xml" ||
    type.endsWith("+xml") ||
    type === "application/javascript" ||
    type === "application/x-www-form-urlencoded" ||
    type === "image/svg+xml"
  );
}

export async function responseToLambdaResult(
  response: Response,
): Promise<APIGatewayProxyStructuredResultV2> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") headers[name] = value;
  });

  const cookies = response.headers.getSetCookie();
  const bytes = new Uint8Array(await response.arrayBuffer());
  const isText = isTextContentType(response.headers.get("content-type"));

  return {
    statusCode: response.status,
    headers,
    ...(cookies.length ? { cookies } : {}),
    body: isText ? new TextDecoder().decode(bytes) : Buffer.from(bytes).toString("base64"),
    isBase64Encoded: !isText,
  };
}

export function createLambdaHandler(
  app: NosrvApp,
  options: LambdaAdapterOptions = {},
): LambdaHttpHandler {
  const storage =
    options.storage ?? (options.s3Bucket ? new S3ObjectStorage(options.s3Bucket) : undefined);
  const kv =
    options.kv ?? (options.dynamodbTable ? new DynamoDBKV(options.dynamodbTable) : undefined);
  return async (event) => {
    try {
      const request = lambdaEventToRequest(event);
      if (options.assetsDirectory) {
        const asset = await serveStaticFile(request, options.assetsDirectory);
        if (asset) return await responseToLambdaResult(asset);
      }
      const pending: Promise<unknown>[] = [];
      const allEnvironment = Object.freeze({ ...options.env, ...process.env });
      const user = options.resolveUser ? await options.resolveUser(event) : authorizerUser(event);
      const appContext: AppContext = {
        env: publicEnvironment(allEnvironment, options.hiddenEnvNames),
        log: logger,
        platform: { name: "lambda" },
        waitUntil: (promise) => pending.push(promise),
        ...(storage ? { storage } : {}),
        ...(kv ? { kv } : {}),
        ...(options.db ? { db: options.db } : {}),
        secrets: new EnvironmentSecrets(allEnvironment),
        resources: options.resources ?? new MemoryResources(),
        bindings: Object.freeze({}),
        user,
      };
      validateCapabilities(app, appContext);
      await initializeApp(app, appContext);
      let response = await app.fetch(request, appContext);

      if (!(response instanceof Response)) {
        throw new TypeError("app.fetch() must return a Response");
      }
      if (response.status === 404 && options.assetsDirectory && options.assetsSpaFallback) {
        response = (await serveSpaFallback(request, options.assetsDirectory)) ?? response;
      }

      const result = await responseToLambdaResult(response);
      await Promise.all(pending);
      return result;
    } catch (error) {
      writeLog("error", "Unhandled request error", {
        error: error instanceof Error ? error.message : String(error),
        path: event.rawPath,
      });
      return {
        statusCode: 500,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "Internal Server Error" }),
        isBase64Encoded: false,
      };
    }
  };
}

export function createLambdaScheduledHandler(
  app: NosrvApp,
  schedule: { name: string; cron: string },
  options: LambdaAdapterOptions = {},
): LambdaScheduledHandler {
  if (!app.scheduled) throw new Error("App does not export scheduled()");
  const storage =
    options.storage ?? (options.s3Bucket ? new S3ObjectStorage(options.s3Bucket) : undefined);
  const kv =
    options.kv ?? (options.dynamodbTable ? new DynamoDBKV(options.dynamodbTable) : undefined);
  return async (event) => {
    const pending: Promise<unknown>[] = [];
    const allEnvironment = Object.freeze({ ...options.env, ...process.env });
    const context: AppContext = {
      env: publicEnvironment(allEnvironment, options.hiddenEnvNames),
      log: logger,
      platform: { name: "lambda" },
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
    const scheduledTime = event.time ? Date.parse(event.time) : Date.now();
    const portableEvent: ScheduledEvent = {
      name: event.detail?.name ?? schedule.name,
      cron: event.detail?.cron ?? schedule.cron,
      scheduledTime: Number.isFinite(scheduledTime) ? scheduledTime : Date.now(),
      trigger: "cron",
    };
    await app.scheduled!(portableEvent, context);
    await Promise.all(pending);
  };
}
