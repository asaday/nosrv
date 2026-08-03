import {
  initializeApp,
  validateCapabilities,
  type AppContextFor,
  type CapabilityRequirements,
  type NosrvApp,
} from "@nosrv/core";

type ParamNames<Path extends string> = Path extends `${string}:${infer Param}/${infer Rest}`
  ? Param | ParamNames<`/${Rest}`>
  : Path extends `${string}:${infer Param}`
    ? Param
    : never;
export type RouteParams<Path extends string> = { [Key in ParamNames<Path>]: string };

export interface RouteContext<R extends CapabilityRequirements, Path extends string = string> {
  request: Request;
  ctx: AppContextFor<R>;
  params: RouteParams<Path>;
  url: URL;
  query: URLSearchParams;
}

export type Next = () => Promise<Response>;
export type RouteHandler<R extends CapabilityRequirements, Path extends string> = (
  context: RouteContext<R, Path>,
  next: Next,
) => void | Response | Promise<void | Response>;
export type Middleware<R extends CapabilityRequirements> = (
  context: RouteContext<R>,
  next: Next,
) => void | Response | Promise<void | Response>;

export class HttpError extends Error {
  readonly status: number;
  readonly details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.details = details;
  }
}

export function json(data: unknown, init?: number | ResponseInit): Response {
  return Response.json(data, typeof init === "number" ? { status: init } : init);
}
export function html(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  return new Response(body, { ...init, headers });
}
export function noContent(): Response {
  return new Response(null, { status: 204 });
}

export function parseCookies(request: Request): Readonly<Record<string, string>> {
  const cookies = Object.create(null) as Record<string, string>;
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (!name || Object.hasOwn(cookies, name)) continue;
    const value = part.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return { ...cookies };
}

export function getCookie(request: Request, name: string): string | null {
  return parseCookies(request)[name] ?? null;
}

export interface CookieOptions {
  domain?: string;
  path?: string;
  expires?: Date;
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "strict" | "lax" | "none";
}

function assertCookiePart(value: string, label: string): void {
  if (!value || /[;\r\n]/.test(value)) throw new TypeError(`Invalid cookie ${label}`);
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) throw new TypeError("Invalid cookie name");
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.domain !== undefined) {
    assertCookiePart(options.domain, "domain");
    parts.push(`Domain=${options.domain}`);
  }
  if (options.path !== undefined) {
    assertCookiePart(options.path, "path");
    parts.push(`Path=${options.path}`);
  }
  if (options.expires !== undefined) {
    if (Number.isNaN(options.expires.getTime())) throw new TypeError("Invalid cookie expiration");
    parts.push(`Expires=${options.expires.toUTCString()}`);
  }
  if (options.maxAge !== undefined) {
    if (!Number.isFinite(options.maxAge)) throw new TypeError("Invalid cookie maxAge");
    parts.push(`Max-Age=${Math.trunc(options.maxAge)}`);
  }
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.sameSite)
    parts.push(`SameSite=${options.sameSite[0].toUpperCase()}${options.sameSite.slice(1)}`);
  return parts.join("; ");
}

export function deleteCookie(
  name: string,
  options: Omit<CookieOptions, "expires" | "maxAge"> = {},
): string {
  return serializeCookie(name, "", { ...options, expires: new Date(0), maxAge: 0 });
}

export interface BodyReadOptions {
  maxSize?: number;
}

function assertMaxSize(maxSize: number | undefined): void {
  if (maxSize !== undefined && (!Number.isSafeInteger(maxSize) || maxSize < 0)) {
    throw new TypeError("maxSize must be a non-negative safe integer");
  }
}

export function limitBody(
  body: ReadableStream<Uint8Array>,
  options: Required<BodyReadOptions>,
): ReadableStream<Uint8Array> {
  assertMaxSize(options.maxSize);
  const reader = body.getReader();
  let size = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        size += value.byteLength;
        if (size > options.maxSize) {
          await reader.cancel("Request body is too large");
          controller.error(new HttpError(413, "Request body is too large"));
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

export async function readBody(
  request: Request,
  options: BodyReadOptions = {},
): Promise<Uint8Array> {
  assertMaxSize(options.maxSize);
  const contentLength = Number(request.headers.get("content-length"));
  if (
    options.maxSize !== undefined &&
    Number.isFinite(contentLength) &&
    contentLength > options.maxSize
  ) {
    throw new HttpError(413, "Request body is too large");
  }
  if (!request.body) return new Uint8Array();
  const body =
    options.maxSize === undefined
      ? request.body
      : limitBody(request.body, { maxSize: options.maxSize });
  return new Uint8Array(await new Response(body).arrayBuffer());
}

export async function readJson<T = unknown>(
  request: Request,
  options: BodyReadOptions = {},
): Promise<T> {
  try {
    const body = await readBody(request, options);
    return JSON.parse(new TextDecoder().decode(body)) as T;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Invalid JSON body");
  }
}

export interface FormFileOptions {
  required?: boolean;
  accept?: readonly string[];
  maxSize?: number;
}
export class FormValues {
  private readonly data: FormData;

  constructor(data: FormData) {
    this.data = data;
  }
  text(name: string, options: { required?: boolean } = {}): string | null {
    const value = this.data.get(name);
    if (value === null || value === "") {
      if (options.required) throw new HttpError(400, `${name} is required`);
      return null;
    }
    if (typeof value !== "string") throw new HttpError(400, `${name} must be text`);
    return value;
  }
  file(name: string, options: FormFileOptions & { required: true }): File;
  file(name: string, options?: FormFileOptions): File | null;
  file(name: string, options: FormFileOptions = {}): File | null {
    const value = this.data.get(name);
    if (!(value instanceof File) || value.size === 0) {
      if (options.required) throw new HttpError(400, `${name} is required`);
      return null;
    }
    if (options.maxSize !== undefined && value.size > options.maxSize)
      throw new HttpError(413, `${name} is too large`);
    if (
      options.accept?.length &&
      !options.accept.some((type) =>
        type.endsWith("/*") ? value.type.startsWith(type.slice(0, -1)) : value.type === type,
      )
    )
      throw new HttpError(415, `${name} has an unsupported media type`);
    return value;
  }
}
export async function readForm(
  request: Request,
  options: BodyReadOptions = {},
): Promise<FormValues> {
  try {
    const body = await readBody(request, options);
    const bytes = body.buffer.slice(
      body.byteOffset,
      body.byteOffset + body.byteLength,
    ) as ArrayBuffer;
    const buffered = new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: bytes,
    });
    return new FormValues(await buffered.formData());
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Invalid form body");
  }
}

interface Route<R extends CapabilityRequirements> {
  method: string;
  pattern: RegExp;
  names: string[];
  handlers: RouteHandler<R, string>[];
  path: string;
}
interface Mount {
  prefix: string;
  app: NosrvApp;
}
type Layer<R extends CapabilityRequirements> =
  | { type: "route"; route: Route<R> }
  | { type: "middleware"; prefix: string; handlers: Middleware<R>[] }
  | { type: "mount"; mount: Mount };
function compilePath(path: string): { pattern: RegExp; names: string[] } {
  const names: string[] = [];
  const segments = path.split("/").map((segment) => {
    if (segment === "*") return ".*";
    if (segment.startsWith(":")) {
      const name = segment.slice(1);
      if (!name) throw new Error(`Invalid route path: ${path}`);
      names.push(name);
      return "([^/]+)";
    }
    return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return { pattern: new RegExp(`^${segments.join("/")}/?$`), names };
}

export interface Router<R extends CapabilityRequirements> {
  (request: Request, context: AppContextFor<R>): Promise<Response>;
  fetch(request: Request, context: AppContextFor<R>): Promise<Response>;
  use(...handlers: [Middleware<R>, ...Middleware<R>[]]): this;
  use(path: string, ...handlers: [Middleware<R>, ...Middleware<R>[]]): this;
  mount(path: string, app: NosrvApp): this;
  get<const Path extends string>(
    path: Path,
    ...handlers: [RouteHandler<R, Path>, ...RouteHandler<R, Path>[]]
  ): this;
  head<const Path extends string>(
    path: Path,
    ...handlers: [RouteHandler<R, Path>, ...RouteHandler<R, Path>[]]
  ): this;
  options<const Path extends string>(
    path: Path,
    ...handlers: [RouteHandler<R, Path>, ...RouteHandler<R, Path>[]]
  ): this;
  post<const Path extends string>(
    path: Path,
    ...handlers: [RouteHandler<R, Path>, ...RouteHandler<R, Path>[]]
  ): this;
  put<const Path extends string>(
    path: Path,
    ...handlers: [RouteHandler<R, Path>, ...RouteHandler<R, Path>[]]
  ): this;
  patch<const Path extends string>(
    path: Path,
    ...handlers: [RouteHandler<R, Path>, ...RouteHandler<R, Path>[]]
  ): this;
  delete<const Path extends string>(
    path: Path,
    ...handlers: [RouteHandler<R, Path>, ...RouteHandler<R, Path>[]]
  ): this;
  all<const Path extends string>(
    path: Path,
    ...handlers: [RouteHandler<R, Path>, ...RouteHandler<R, Path>[]]
  ): this;
}

function mountPrefix(path: string): string {
  if (!path.startsWith("/")) throw new TypeError("Mount path must start with /");
  const prefix = path.replace(/\/+$/, "");
  if (!prefix) throw new TypeError("Mount path must not be the router root");
  return prefix;
}

function middlewarePrefix(path: string): string {
  if (!path.startsWith("/")) throw new TypeError("Middleware path must start with /");
  return path === "/" ? path : path.replace(/\/+$/, "");
}

function matchesPrefix(pathname: string, prefix: string): boolean {
  return prefix === "/" || pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function createRouter<const R extends CapabilityRequirements = {}>(
  configure?: (router: Router<R>) => void,
): Router<R> {
  const layers: Layer<R>[] = [];
  const register = (method: string, path: string, handlers: RouteHandler<R, string>[]) => {
    const compiled = compilePath(path);
    layers.push({ type: "route", route: { method, path, handlers, ...compiled } });
    return router;
  };
  const router = ((request, context) => router.fetch(request, context)) as Router<R>;
  const methods: Pick<Router<R>, keyof Router<R>> = {
    use: (
      ...args: [Middleware<R>, ...Middleware<R>[]] | [string, Middleware<R>, ...Middleware<R>[]]
    ) => {
      const path = typeof args[0] === "string" ? args[0] : "/";
      const handlers = (typeof args[0] === "string" ? args.slice(1) : args) as Middleware<R>[];
      layers.push({ type: "middleware", prefix: middlewarePrefix(path), handlers });
      return router;
    },
    mount: (path, app) => {
      layers.push({ type: "mount", mount: { prefix: mountPrefix(path), app } });
      return router;
    },
    get: (path, ...handlers) => register("GET", path, handlers as RouteHandler<R, string>[]),
    head: (path, ...handlers) => register("HEAD", path, handlers as RouteHandler<R, string>[]),
    options: (path, ...handlers) =>
      register("OPTIONS", path, handlers as RouteHandler<R, string>[]),
    post: (path, ...handlers) => register("POST", path, handlers as RouteHandler<R, string>[]),
    put: (path, ...handlers) => register("PUT", path, handlers as RouteHandler<R, string>[]),
    patch: (path, ...handlers) => register("PATCH", path, handlers as RouteHandler<R, string>[]),
    delete: (path, ...handlers) => register("DELETE", path, handlers as RouteHandler<R, string>[]),
    all: (path, ...handlers) => register("*", path, handlers as RouteHandler<R, string>[]),
    async fetch(request, context) {
      try {
        const url = new URL(request.url);
        const base = {
          request,
          ctx: context as AppContextFor<R>,
          params: {} as RouteParams<string>,
          url,
          query: url.searchParams,
        };
        const withoutBody = (response: Response): Response =>
          request.method === "HEAD"
            ? new Response(null, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
              })
            : response;
        const pathMatches = layers.flatMap((layer) => {
          if (layer.type !== "route") return [];
          const { route } = layer;
          const match = route.pattern.exec(url.pathname);
          return match ? [{ route, match }] : [];
        });
        const hasExplicitHead =
          request.method === "HEAD" &&
          pathMatches.some(({ route }) => route.method === "HEAD" || route.method === "*");
        const fallback = (): Response => {
          if (!pathMatches.length) return json({ error: "Not Found" }, 404);
          const methods = [
            ...new Set(
              pathMatches.map(({ route }) => route.method).filter((method) => method !== "*"),
            ),
          ];
          if (methods.includes("GET") && !methods.includes("HEAD"))
            methods.splice(methods.indexOf("GET") + 1, 0, "HEAD");
          if (!methods.includes("OPTIONS")) methods.push("OPTIONS");
          const headers = { allow: methods.join(", ") };
          if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
          return json({ error: "Method Not Allowed" }, { status: 405, headers });
        };
        const runHandlers = async <Path extends string>(
          handlers: readonly RouteHandler<R, Path>[],
          routeContext: RouteContext<R, Path>,
          continuation: Next,
          index = 0,
        ): Promise<Response> => {
          const handler = handlers[index];
          if (!handler) return continuation();
          let nextPromise: Promise<Response> | undefined;
          const next: Next = () => {
            if (nextPromise) throw new Error("next() called more than once");
            nextPromise = runHandlers(handlers, routeContext, continuation, index + 1);
            return nextPromise;
          };
          const response = await handler(routeContext, next);
          if (response instanceof Response) return response;
          return nextPromise ? await nextPromise : next();
        };
        const dispatch = async (index = 0): Promise<Response> => {
          const layer = layers[index];
          if (!layer) return fallback();
          const next = () => dispatch(index + 1);
          if (layer.type === "middleware") {
            if (!matchesPrefix(url.pathname, layer.prefix)) return next();
            return runHandlers(layer.handlers, base, next);
          }
          if (layer.type === "mount") {
            const { prefix, app } = layer.mount;
            if (!matchesPrefix(url.pathname, prefix)) return next();
            const mountedUrl = new URL(url);
            mountedUrl.pathname = url.pathname.slice(prefix.length) || "/";
            validateCapabilities(app, context);
            await initializeApp(app, context);
            return app.fetch(new Request(mountedUrl, request), context);
          }
          const { route } = layer;
          const match = route.pattern.exec(url.pathname);
          if (!match) return next();
          const methodMatches =
            route.method === "*" ||
            route.method === request.method ||
            (request.method === "HEAD" && !hasExplicitHead && route.method === "GET");
          if (!methodMatches) return next();
          let params: RouteParams<string>;
          try {
            params = Object.fromEntries(
              route.names.map((name, paramIndex) => [
                name,
                decodeURIComponent(match[paramIndex + 1]),
              ]),
            ) as RouteParams<string>;
          } catch {
            throw new HttpError(400, "Invalid URL path encoding");
          }
          return runHandlers(route.handlers, { ...base, params }, next);
        };
        return withoutBody(await dispatch());
      } catch (error) {
        if (error instanceof HttpError)
          return json(
            {
              error: error.message,
              ...(error.details === undefined ? {} : { details: error.details }),
            },
            error.status,
          );
        throw error;
      }
    },
  };
  Object.assign(router, methods);
  configure?.(router);
  return router;
}
