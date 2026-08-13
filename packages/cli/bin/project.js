import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isAppName, normalizeAppSchedules, normalizeAppTimezone } from "@nosrv/core";
import { parse } from "yaml";

export function projectName(directory) {
  return (
    basename(directory)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-|-$/g, "") || "nosrv-app"
  );
}

function assertAllowedKeys(value, allowed, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`Unsupported ${path} key: ${unknown[0]}`);
  return value;
}

function validateProviderGroup(value, path, groups) {
  const provider = assertAllowedKeys(value, Object.keys(groups), path);
  for (const [name, keys] of Object.entries(groups)) {
    if (provider[name] !== undefined) {
      assertAllowedKeys(provider[name], keys, `${path}.${name}`);
    }
  }
}

export function validateConfig(config) {
  assertAllowedKeys(
    config,
    [
      "name",
      "app",
      "route",
      "meta",
      "spa",
      "env",
      "dev",
      "permissions",
      "schedules",
      "timezone",
      "providers",
      "deploy",
    ],
    "nosrv.yaml",
  );
  if (config.meta !== undefined) assertAllowedKeys(config.meta, ["description", "icon"], "meta");
  if (config.dev !== undefined) assertAllowedKeys(config.dev, ["port", "host"], "dev");
  if (config.schedules !== undefined) {
    if (!Array.isArray(config.schedules)) throw new Error("schedules must be an array");
    config.schedules.forEach((schedule, index) =>
      assertAllowedKeys(schedule, ["name", "cron"], `schedules[${index}]`),
    );
  }
  if (config.providers !== undefined) {
    const providers = assertAllowedKeys(
      config.providers,
      ["node", "cloudflare", "lambda", "google-functions", "azure"],
      "providers",
    );
    if (providers.node !== undefined)
      validateProviderGroup(providers.node, "providers.node", {
        db: ["provider", "file", "urlEnv", "appId"],
        kv: ["provider", "file"],
        storage: ["provider", "directory"],
      });
    if (providers.cloudflare !== undefined)
      validateProviderGroup(providers.cloudflare, "providers.cloudflare", {
        db: ["provider", "database", "id"],
        kv: ["provider", "id"],
        storage: ["provider", "bucket"],
      });
    if (providers.lambda !== undefined)
      validateProviderGroup(providers.lambda, "providers.lambda", {
        db: ["provider", "urlEnv", "appId"],
        kv: ["provider", "table"],
        storage: ["provider", "bucket"],
      });
    if (providers["google-functions"] !== undefined)
      validateProviderGroup(providers["google-functions"], "providers.google-functions", {
        db: ["provider", "urlEnv", "appId"],
        kv: ["provider", "collection"],
        storage: ["provider", "bucket"],
      });
    if (providers.azure !== undefined)
      validateProviderGroup(providers.azure, "providers.azure", {
        db: ["provider", "urlEnv", "appId"],
        kv: ["provider", "database", "container", "connectionStringEnv"],
        storage: ["provider", "container", "connectionStringEnv"],
      });
  }
  if (config.deploy !== undefined) {
    const deploy = assertAllowedKeys(
      config.deploy,
      ["google-functions", "lambda", "azure"],
      "deploy",
    );
    if (deploy["google-functions"] !== undefined)
      assertAllowedKeys(
        deploy["google-functions"],
        ["name", "region", "runtime", "allowUnauthenticated"],
        "deploy.google-functions",
      );
    if (deploy.lambda !== undefined) {
      const lambda = assertAllowedKeys(
        deploy.lambda,
        ["runtime", "timeout", "http", "region"],
        "deploy.lambda",
      );
      if (lambda.http !== undefined) assertAllowedKeys(lambda.http, ["auth"], "deploy.lambda.http");
    }
    if (deploy.azure !== undefined)
      assertAllowedKeys(deploy.azure, ["app", "slot", "authLevel"], "deploy.azure");
  }
}

export async function loadConfig(cwd, options = {}) {
  const configPath = resolve(cwd, "nosrv.yaml");
  if (!existsSync(configPath)) return {};
  const config = parse(await readFile(configPath, "utf8"));
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("nosrv.yaml must contain a YAML object");
  }
  validateConfig(config);
  if (config.spa !== undefined && typeof config.spa !== "boolean") {
    throw new Error('"spa" in nosrv.yaml must be true or false');
  }
  resolveMeta(config.meta);
  resolveTimezone(config.timezone);
  return config;
}

export function resolveApp(cwd, configuredApp, options = {}) {
  const implicitStatic =
    options.allowStatic && !configuredApp && existsSync(resolve(cwd, "index.html"));
  const candidates = configuredApp
    ? [configuredApp]
    : implicitStatic
      ? ["src/app.ts", "src/app.js"]
      : ["src/app.ts", "src/app.js", "app.ts", "app.js"];
  const match = candidates.map((candidate) => resolve(cwd, candidate)).find(existsSync);
  if (!match) {
    if (
      options.allowStatic &&
      (existsSync(resolve(cwd, "public")) || existsSync(resolve(cwd, "index.html")))
    )
      return undefined;
    throw new Error(`No app found. Create app.ts or src/app.ts, or set \"app\" in nosrv.yaml.`);
  }
  return match;
}

export function resolvePublicConfig(cwd, spa = false) {
  const publicDirectory = resolve(cwd, "public");
  const rootIndex = resolve(cwd, "index.html");
  const directory = existsSync(publicDirectory)
    ? publicDirectory
    : existsSync(rootIndex)
      ? cwd
      : undefined;
  if (!directory) {
    if (spa) throw new Error('"spa" requires public/index.html or a root index.html');
    return undefined;
  }
  if (spa && !existsSync(resolve(directory, "index.html"))) {
    throw new Error('"spa" requires an index.html in the public directory');
  }
  return { directory, spa, implicit: directory === cwd };
}

export function resolveResourcesDirectory(cwd) {
  const directory = resolve(cwd, "resources");
  return existsSync(directory) ? directory : undefined;
}

export function resolveSchedules(configuredSchedules) {
  return normalizeAppSchedules(configuredSchedules);
}

export function resolveTimezone(configuredTimezone) {
  return normalizeAppTimezone(configuredTimezone);
}

export function resolvePermissions(configuredPermissions) {
  if (configuredPermissions === undefined) return undefined;
  if (configuredPermissions === "*") return "*";
  if (
    !configuredPermissions ||
    typeof configuredPermissions !== "object" ||
    Array.isArray(configuredPermissions)
  ) {
    throw new Error('"permissions" in nosrv.yaml must be "*" or an object');
  }
  const unknown = Object.keys(configuredPermissions).filter(
    (name) => name !== "filesystem" && name !== "childProcess",
  );
  if (unknown.length) throw new Error(`Unsupported App permission: ${unknown[0]}`);
  const childProcess = configuredPermissions.childProcess;
  if (childProcess !== undefined && childProcess !== true) {
    throw new Error('"permissions.childProcess" in nosrv.yaml must be true');
  }
  const filesystem = configuredPermissions.filesystem;
  if (
    filesystem !== undefined &&
    (!filesystem || typeof filesystem !== "object" || Array.isArray(filesystem))
  ) {
    throw new Error('"permissions.filesystem" in nosrv.yaml must be an object');
  }
  const unknownFilesystem = Object.keys(filesystem ?? {}).filter(
    (name) => name !== "read" && name !== "write",
  );
  if (unknownFilesystem.length)
    throw new Error(`Unsupported filesystem permission: ${unknownFilesystem[0]}`);
  const paths = {};
  for (const access of ["read", "write"]) {
    const configured = filesystem?.[access] ?? [];
    if (!Array.isArray(configured))
      throw new Error(`"permissions.filesystem.${access}" must be an array`);
    paths[access] = [
      ...new Set(
        configured.map((path, index) => {
          if (typeof path !== "string" || !path || !isAbsolute(path) || path.includes("\0")) {
            throw new Error(`permissions.filesystem.${access}[${index}] must be an absolute path`);
          }
          return resolve(path);
        }),
      ),
    ];
  }
  if (!paths.read.length && !paths.write.length && !childProcess) {
    throw new Error('"permissions" must declare at least one capability');
  }
  return {
    ...(paths.read.length || paths.write.length ? { filesystem: paths } : {}),
    ...(childProcess ? { childProcess: true } : {}),
  };
}

export function resolveEnvironment(configuredEnvironment) {
  if (configuredEnvironment === undefined) return undefined;
  if (
    !configuredEnvironment ||
    typeof configuredEnvironment !== "object" ||
    Array.isArray(configuredEnvironment)
  ) {
    throw new Error("env in nosrv.yaml must be an object");
  }
  const environment = {};
  for (const [name, value] of Object.entries(configuredEnvironment)) {
    const validName =
      name.length > 0 &&
      !name
        .split("")
        .some((character, index) =>
          index === 0 ? !/[A-Za-z_]/.test(character) : !/[A-Za-z0-9_]/.test(character),
        );
    if (!validName || name.startsWith("NOSRV_")) {
      throw new Error("Invalid or reserved environment name: " + name);
    }
    if (typeof value !== "string") throw new Error("env." + name + " must be a string");
    environment[name] = value;
  }
  return Object.keys(environment).length ? environment : undefined;
}

export function resolveMeta(configuredMeta) {
  if (configuredMeta === undefined) return undefined;
  if (!configuredMeta || typeof configuredMeta !== "object" || Array.isArray(configuredMeta)) {
    throw new Error('"meta" in nosrv.yaml must be an object');
  }
  const meta = {};
  for (const name of ["description", "icon"]) {
    const value = configuredMeta[name];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string") throw new Error(`"meta.${name}" in nosrv.yaml must be a string`);
    if (!value.trim()) continue;
    meta[name] = value.trim();
  }
  if (
    meta.icon &&
    (meta.icon.includes("://") ||
      (meta.icon.startsWith("/") &&
        !/^\/(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^?#\\]+\.png$/i.test(meta.icon)))
  ) {
    throw new Error('"meta.icon" must be an emoji or an absolute App-local .png path');
  }
  return Object.keys(meta).length ? meta : undefined;
}

function staticCopyFilter(source, publicRoot, options = {}) {
  const path = resolve(source);
  if (
    (options.excludedPaths ?? []).some(
      (excluded) => path === excluded || path.startsWith(`${excluded}${sep}`),
    )
  )
    return false;
  const parts = relative(publicRoot, path).split(sep);
  const [name] = parts;
  if (!name) return true;
  if ((options.excludedTopLevelNames ?? []).includes(name)) return false;
  if (parts.some((part) => [".git", ".nosrv", "node_modules"].includes(part))) return false;
  const basename = parts.at(-1);
  if (basename === ".gitignore" || basename === "package-lock.json") return false;
  if (basename === ".env" || basename?.startsWith(".env.")) return false;
  if (options.implicit && ["resources", "src"].includes(name)) return false;
  if (options.implicit && name === "nosrv.yaml") return false;
  return true;
}

export async function writeStaticApp(path) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `export default { fetch() { return new Response("Not found", { status: 404 }); } };\n`,
    "utf8",
  );
  return path;
}

export async function copyPublicDirectory(source, destination, options = {}) {
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const entrySource = resolve(source, entry.name);
    if (!staticCopyFilter(entrySource, source, options)) continue;
    await cp(entrySource, resolve(destination, entry.name), {
      recursive: entry.isDirectory(),
      filter: (path) => staticCopyFilter(path, source, options),
    });
  }
}

export async function stagePublicDirectory(
  cwd,
  target,
  publicConfig,
  outputRoot = resolve(cwd, ".nosrv"),
) {
  if (!publicConfig?.implicit) return publicConfig;
  const directory = resolve(outputRoot, target, "public");
  await rm(directory, { recursive: true, force: true });
  await copyPublicDirectory(publicConfig.directory, directory);
  return { ...publicConfig, directory };
}

export function generatedDirectory(cwd) {
  return process.env.NOSRV_GENERATED_DIR
    ? resolve(process.env.NOSRV_GENERATED_DIR)
    : resolve(cwd, ".nosrv");
}

export function moduleSpecifier(fromDirectory, appPath) {
  let path = relative(fromDirectory, appPath).split(sep).join("/");
  if (!path.startsWith(".")) path = `./${path}`;
  return path.replace(/\.tsx?$/, ".js");
}

export function workerName(cwd, config) {
  if (config.name !== undefined) {
    if (!isAppName(config.name)) {
      throw new Error(
        '"name" must contain lowercase letters, numbers, or hyphens and be at most 63 characters',
      );
    }
    return config.name;
  }
  const candidate = basename(cwd);
  return (
    String(candidate)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-|-$/g, "") || "nosrv-app"
  );
}

export function postgresDatabaseConfig(cwd, config, target) {
  const database = config.providers?.[target]?.db;
  if (!database) return undefined;
  if ((database.provider ?? "postgres") !== "postgres")
    throw new Error(`Unsupported ${target} database provider: ${database.provider}`);
  const urlEnv = database.urlEnv ?? "DATABASE_URL";
  const appId = database.appId ?? workerName(cwd, config);
  if (typeof urlEnv !== "string" || !urlEnv)
    throw new Error(`${target} PostgreSQL database urlEnv must be a non-empty environment name`);
  if (typeof appId !== "string" || !appId)
    throw new Error(`${target} PostgreSQL database appId must be a non-empty string`);
  return { urlEnv, appId };
}
