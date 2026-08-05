import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".pdf": "application/pdf",
};

export interface StaticFileOptions {
  cacheControl?: string;
}

export async function serveStaticFile(
  request: Request,
  directory: string,
  options: StaticFileOptions = {},
): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(request.url).pathname);
  } catch {
    return null;
  }
  if (pathname.includes("\0")) return null;
  const root = resolve(directory);
  const relativePath = pathname.replace(/^\/+/, "") || "index.html";
  let path = resolve(root, relativePath);
  if (path !== root && !path.startsWith(`${root}${sep}`)) return null;
  try {
    const info = await stat(path);
    if (info.isDirectory()) path = resolve(path, "index.html");
    const fileInfo = await stat(path);
    if (!fileInfo.isFile()) return null;
    const body = request.method === "HEAD" ? null : await readFile(path);
    return new Response(body, {
      headers: {
        "content-type": contentTypes[extname(path).toLowerCase()] ?? "application/octet-stream",
        "content-length": String(fileInfo.size),
        "cache-control":
          options.cacheControl ?? (extname(path) === ".html" ? "no-cache" : "public, max-age=3600"),
      },
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    )
      return null;
    throw error;
  }
}

export async function serveSpaFallback(
  request: Request,
  directory: string,
  options: StaticFileOptions = {},
): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const acceptsHtml =
    request.headers
      .get("accept")
      ?.split(",")
      .some((value) => value.trim().split(";", 1)[0] === "text/html") ?? false;
  if (request.headers.get("sec-fetch-mode") !== "navigate" && !acceptsHtml) return null;
  const url = new URL(request.url);
  url.pathname = "/index.html";
  url.search = "";
  return serveStaticFile(
    new Request(url, { method: request.method, headers: request.headers }),
    directory,
    options,
  );
}
