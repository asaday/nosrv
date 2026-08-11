import { existsSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Cron } from "croner";
import {
  generatedDirectory,
  loadConfig,
  resolveApp,
  resolveEnvironment,
  resolvePermissions,
  resolvePublicConfig,
  resolveResourcesDirectory,
  resolveSchedules,
  resolveTimezone,
  stagePublicDirectory,
  workerName,
  writeStaticApp,
} from "./project.js";
import { registerTypeScript } from "./register-typescript.js";
import { runWranglerDev } from "./targets/cloudflare.js";
import { runGoogleFunctionsDev } from "./targets/google-functions.js";
import { runLambdaDev } from "./targets/lambda.js";

function readOption(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}
function readTarget(args, fallback = "node") {
  return readOption(args, "--target") ?? readOption(args, "-t") ?? fallback;
}

function authorizedToken(request, expected) {
  const supplied = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const actual = Buffer.from(supplied);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

export async function dev(args, options = {}) {
  const cwd = process.cwd();
  const generatedRoot = generatedDirectory(cwd);
  const config = await loadConfig(cwd, options);
  const target = readTarget(args);
  const permissions = resolvePermissions(config.permissions);
  if (permissions && target !== "node" && target !== "local") {
    throw new Error(
      "Apps with host permissions can only run on Node.js or nosrv Platform, not " + target,
    );
  }
  const publicConfig = await stagePublicDirectory(
    cwd,
    "static-dev",
    resolvePublicConfig(cwd, config.spa === true),
    generatedRoot,
  );
  const appPath = resolveApp(cwd, config.app, {
    allowStatic: true,
  });
  const publicDirectory = publicConfig?.directory;
  const resourcesDirectory = resolveResourcesDirectory(cwd);
  const portText = readOption(args, "--port") ?? config.dev?.port ?? "8787";
  const port = Number(portText);
  const hostname = readOption(args, "--host") ?? config.dev?.host ?? "127.0.0.1";

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${portText}`);
  }

  const envPath = resolve(cwd, ".env");
  if (existsSync(envPath) && typeof process.loadEnvFile === "function")
    process.loadEnvFile(envPath);

  if (target === "cloudflare") {
    await runWranglerDev(cwd, appPath, config, { hostname, port });
    return;
  }
  if (target === "google-functions") {
    await runGoogleFunctionsDev(cwd, appPath, config, { hostname, port });
    return;
  }
  if (target === "lambda") {
    await runLambdaDev(cwd, appPath, config, { hostname, port });
    return;
  }
  if (target !== "node" && target !== "local") {
    throw new Error(`Unsupported development target: ${target}`);
  }

  const resolvedAppPath =
    appPath ?? (await writeStaticApp(resolve(generatedRoot, "static-app.mjs")));
  if (process.env.NOSRV_BUNDLED_APP !== "true") await registerTypeScript(cwd, resolvedAppPath);
  const { listen, resolveSignedPlatformUser } = await import("nosrv/runtime/node");
  const module = await import(pathToFileURL(resolvedAppPath).href);
  const app = module.default?.fetch ? module.default : module.default?.default;
  if (!app || typeof app.fetch !== "function") {
    throw new Error(`${resolvedAppPath} must default-export an app created with defineApp()`);
  }

  const nodeStorage = config.providers?.node?.storage;
  const platformDataDirectory = process.env.NOSRV_DATA_DIR
    ? resolve(process.env.NOSRV_DATA_DIR)
    : undefined;
  const platformAppId = process.env.NOSRV_PLATFORM_APP_ID;
  const platformKVBackend = process.env.NOSRV_PLATFORM_KV_BACKEND ?? "sqlite";
  const platformDBBackend = process.env.NOSRV_PLATFORM_DB_BACKEND ?? "sqlite";
  const platformStorageBackend = process.env.NOSRV_PLATFORM_STORAGE_BACKEND ?? "filesystem";
  const nodeKV = config.providers?.node?.kv;
  let kv;
  if (app.requires?.kv) {
    if (platformDataDirectory && platformKVBackend === "redis") {
      const url = process.env.NOSRV_PLATFORM_REDIS_URL;
      if (!url || !platformAppId)
        throw new Error(
          "Redis Platform KV requires NOSRV_PLATFORM_REDIS_URL and NOSRV_PLATFORM_APP_ID",
        );
      const { RedisKV } = await import("@nosrv/redis");
      kv = new RedisKV(url, `nosrv:${platformAppId}:`);
    } else if (platformDataDirectory && platformKVBackend !== "sqlite") {
      throw new Error(`Unsupported Platform KV backend: ${platformKVBackend}`);
    } else if (nodeKV?.provider === "sqlite" || !nodeKV?.provider) {
      const { SQLiteKV } = await import("nosrv/runtime/sqlite");
      kv = new SQLiteKV(
        platformDataDirectory
          ? resolve(platformDataDirectory, "kv.sqlite")
          : resolve(cwd, nodeKV?.file ?? ".nosrv/kv.sqlite"),
      );
    } else {
      throw new Error(`Unsupported Node.js KV provider: ${nodeKV.provider}`);
    }
  }
  let storage;
  if (platformDataDirectory && app.requires?.storage && platformStorageBackend === "s3") {
    const bucket = process.env.NOSRV_PLATFORM_STORAGE_BUCKET;
    if (!bucket) throw new Error("S3 Platform storage requires NOSRV_PLATFORM_STORAGE_BUCKET");
    const { S3ObjectStorage } = await import("@nosrv/aws");
    if (!platformAppId) throw new Error("S3 Platform storage requires NOSRV_PLATFORM_APP_ID");
    storage = new S3ObjectStorage(bucket, undefined, `apps/${platformAppId}/`);
  } else if (platformDataDirectory && app.requires?.storage && platformStorageBackend === "gcs") {
    const bucket = process.env.NOSRV_PLATFORM_STORAGE_BUCKET;
    if (!bucket) throw new Error("GCS Platform storage requires NOSRV_PLATFORM_STORAGE_BUCKET");
    const { GCSObjectStorage } = await import("@nosrv/google-cloud");
    if (!platformAppId) throw new Error("GCS Platform storage requires NOSRV_PLATFORM_APP_ID");
    storage = new GCSObjectStorage(bucket, undefined, `apps/${platformAppId}/`);
  } else if (
    platformDataDirectory &&
    app.requires?.storage &&
    platformStorageBackend !== "filesystem"
  ) {
    throw new Error(`Unsupported Platform storage backend: ${platformStorageBackend}`);
  } else if (nodeStorage?.provider === "memory") {
    const { MemoryObjectStorage } = await import("nosrv/runtime/memory");
    storage = new MemoryObjectStorage();
  } else if (
    (nodeStorage || app.requires?.storage) &&
    (nodeStorage?.provider ?? "filesystem") === "filesystem"
  ) {
    const { FilesystemObjectStorage } = await import("nosrv/runtime/filesystem");
    storage = new FilesystemObjectStorage(
      platformDataDirectory
        ? resolve(platformDataDirectory, "storage")
        : resolve(cwd, nodeStorage.directory ?? ".nosrv/storage"),
    );
  } else if (nodeStorage?.provider) {
    throw new Error(`Unsupported Node.js storage provider: ${nodeStorage.provider}`);
  }

  const nodeDatabase = config.providers?.node?.db;
  let databaseUrlEnv;
  let db;
  if (app.requires?.db && platformDataDirectory && platformDBBackend === "postgres") {
    const url = process.env.NOSRV_PLATFORM_POSTGRES_URL;
    if (!url || !platformAppId)
      throw new Error(
        "PostgreSQL Platform DB requires NOSRV_PLATFORM_POSTGRES_URL and NOSRV_PLATFORM_APP_ID",
      );
    const { PostgresDatabase } = await import("@nosrv/postgres");
    db = new PostgresDatabase(url, platformAppId);
  } else if (app.requires?.db && platformDataDirectory && platformDBBackend !== "sqlite") {
    throw new Error(`Unsupported Platform DB backend: ${platformDBBackend}`);
  } else if (nodeDatabase?.provider === "sqlite" || (!nodeDatabase?.provider && app.requires?.db)) {
    const { SQLiteDatabase } = await import("nosrv/runtime/sqlite");
    db = new SQLiteDatabase(
      platformDataDirectory
        ? resolve(platformDataDirectory, "database.sqlite")
        : resolve(cwd, nodeDatabase?.file ?? ".nosrv/database.sqlite"),
    );
  } else if (nodeDatabase?.provider === "postgres") {
    databaseUrlEnv = nodeDatabase.urlEnv ?? "DATABASE_URL";
    if (typeof databaseUrlEnv !== "string" || !databaseUrlEnv)
      throw new Error("Node.js PostgreSQL database urlEnv must be a non-empty environment name");
    const url = process.env[databaseUrlEnv];
    if (!url) throw new Error(`Node.js PostgreSQL database requires ${databaseUrlEnv}`);
    const appId = nodeDatabase.appId ?? workerName(cwd, config);
    if (typeof appId !== "string" || !appId)
      throw new Error("Node.js PostgreSQL database appId must be a non-empty string");
    const { PostgresDatabase } = await import("@nosrv/postgres");
    db = new PostgresDatabase(url, appId);
  } else if (nodeDatabase?.provider) {
    throw new Error(`Unsupported Node.js database provider: ${nodeDatabase.provider}`);
  }

  const configuredEnvironment = resolveEnvironment(config.env);
  const bindingsConfiguration = process.env.NOSRV_PLATFORM_BINDINGS_JSON
    ? JSON.parse(process.env.NOSRV_PLATFORM_BINDINGS_JSON)
    : {};
  const bindings = {};
  if (Object.keys(bindingsConfiguration).length) {
    const { McpBinding } = await import("nosrv/runtime/mcp");
    for (const [name, binding] of Object.entries(bindingsConfiguration)) {
      bindings[name] = new McpBinding(binding);
    }
  }
  const runtimeOptions = {
    hostname,
    port,
    env: { ...(configuredEnvironment ?? {}), ...process.env },
    hiddenEnvNames: [
      "NOSRV_PLATFORM_REDIS_URL",
      "NOSRV_PLATFORM_POSTGRES_URL",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
      "AWS_CONTAINER_CREDENTIALS_FULL_URI",
      "AWS_CONTAINER_AUTHORIZATION_TOKEN",
      "AWS_ENDPOINT_URL",
      "AWS_S3_FORCE_PATH_STYLE",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "NOSRV_SCHEDULE_CLAIM_TOKEN",
      "NOSRV_SCHEDULE_RUN_TOKEN",
      ...(databaseUrlEnv ? [databaseUrlEnv] : []),
      ...(process.env.NOSRV_IDENTITY_SECRET ? ["NOSRV_IDENTITY_SECRET"] : []),
      ...(process.env.NOSRV_APP_SECRETS_JSON ? ["NOSRV_APP_SECRETS_JSON"] : []),
      ...(process.env.NOSRV_PLATFORM_BINDINGS_JSON ? ["NOSRV_PLATFORM_BINDINGS_JSON"] : []),
    ],
    ...(process.env.NOSRV_APP_SECRETS_JSON
      ? {
          secrets: new (await import("@nosrv/core")).EnvironmentSecrets(
            JSON.parse(process.env.NOSRV_APP_SECRETS_JSON),
          ),
        }
      : {}),
    ...(kv ? { kv } : {}),
    ...(storage ? { storage } : {}),
    ...(db ? { db } : {}),
    bindings,
    ...(resourcesDirectory
      ? {
          resources: new (await import("nosrv/runtime/filesystem")).FilesystemResources(
            resourcesDirectory,
          ),
        }
      : {}),
    ...(process.env.NOSRV_IDENTITY_SECRET
      ? {
          resolveUser: (request) =>
            resolveSignedPlatformUser(request, process.env.NOSRV_IDENTITY_SECRET),
        }
      : {}),
    ...(publicDirectory
      ? {
          assetsDirectory: publicDirectory,
          assetsCacheControl: "no-cache",
          assetsSpaFallback: publicConfig.spa,
        }
      : {}),
  };
  const schedules = resolveSchedules(config.schedules);
  const timezone = resolveTimezone(config.timezone);
  const schedulesDisabled = args.includes("--disable-schedules");
  if (schedules.length && typeof app.scheduled !== "function") {
    throw new Error("nosrv.yaml declares schedules but the app does not export scheduled()");
  }
  if (!schedules.length && typeof app.scheduled === "function") {
    console.warn("App exports scheduled() but nosrv.yaml declares no schedules");
  }
  const { createScheduledRunner } = schedules.length
    ? await import("nosrv/runtime/node")
    : { createScheduledRunner: undefined };
  const runScheduled = createScheduledRunner?.(app, runtimeOptions);
  const runningSchedules = new Set();
  const executeSchedule = async (schedule, trigger, scheduledTime) => {
    if (runningSchedules.has(schedule.name)) {
      throw new Error(`Schedule is already running: ${schedule.name}`);
    }
    runningSchedules.add(schedule.name);
    console.log(`Schedule started: ${schedule.name} (${trigger})`);
    try {
      await runScheduled({
        name: schedule.name,
        cron: schedule.cron,
        scheduledTime,
        trigger,
      });
      console.log(`Schedule completed: ${schedule.name} (${Date.now() - scheduledTime}ms)`);
    } finally {
      runningSchedules.delete(schedule.name);
    }
  };
  const scheduleRunToken = process.env.NOSRV_SCHEDULE_RUN_TOKEN;
  const servedApp = scheduleRunToken
    ? {
        ...app,
        async fetch(request, context) {
          const match = new URL(request.url).pathname.match(
            /^\/_nosrv\/runtime\/schedules\/([^/]+)\/run$/,
          );
          if (!match) return app.fetch(request, context);
          if (request.method !== "POST") {
            return Response.json({ error: "Method not allowed" }, { status: 405 });
          }
          if (!authorizedToken(request, scheduleRunToken)) {
            return Response.json({ error: "Runtime authentication required" }, { status: 401 });
          }
          const name = decodeURIComponent(match[1]);
          const schedule = schedules.find((candidate) => candidate.name === name);
          if (!schedule) return Response.json({ error: "Schedule not found" }, { status: 404 });
          const scheduledTime = Date.now();
          try {
            await executeSchedule(schedule, "manual", scheduledTime);
            return Response.json({
              name: schedule.name,
              cron: schedule.cron,
              scheduledTime,
              trigger: "manual",
              status: "completed",
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`Schedule failed: ${schedule.name}`, error);
            return Response.json(
              { error: message },
              { status: message.startsWith("Schedule is already running:") ? 409 : 500 },
            );
          }
        },
      }
    : app;
  const running = await listen(servedApp, runtimeOptions);
  const cronJobs = [];
  if (schedules.length && !schedulesDisabled) {
    for (const schedule of schedules) {
      const job = new Cron(
        schedule.cron,
        { ...(timezone ? { timezone } : {}), protect: true },
        async () => {
          if (runningSchedules.has(schedule.name)) {
            console.warn(`Schedule skipped because its previous run is active: ${schedule.name}`);
            return;
          }
          let started = Date.now();
          if (process.env.NOSRV_SCHEDULE_CLAIM_URL) {
            const token = process.env.NOSRV_SCHEDULE_CLAIM_TOKEN;
            const appId = process.env.NOSRV_PLATFORM_APP_ID;
            const instanceId = process.env.NOSRV_PLATFORM_INSTANCE_ID;
            if (!token || !appId || !instanceId) {
              console.error("Platform schedule claiming is not fully configured");
              return;
            }
            try {
              const response = await fetch(process.env.NOSRV_SCHEDULE_CLAIM_URL, {
                method: "POST",
                headers: {
                  authorization: `Bearer ${token}`,
                  "content-type": "application/json",
                },
                body: JSON.stringify({ appId, scheduleName: schedule.name, instanceId }),
              });
              if (!response.ok)
                throw new Error(`Schedule claim failed with HTTP ${response.status}`);
              const claim = await response.json();
              if (!claim.claimed) {
                console.log(`Schedule claimed by another instance: ${schedule.name}`);
                return;
              }
              started = claim.scheduledTime;
            } catch (error) {
              console.error(`Schedule claim failed: ${schedule.name}`, error);
              return;
            }
          }
          try {
            await executeSchedule(schedule, "cron", started);
          } catch (error) {
            console.error(`Schedule failed: ${schedule.name}`, error);
          }
        },
      );
      cronJobs.push(job);
    }
  }
  console.log(`nosrv dev server`);
  console.log(`App: ${appPath ?? "(static only)"}`);
  console.log(`Local: http://${running.hostname}:${running.port}`);
  if (schedules.length && schedulesDisabled) {
    console.log("Schedules: automatic execution disabled");
  } else if (schedules.length)
    console.log(
      `Schedules: ${schedules.map((schedule) => `${schedule.name} (${schedule.cron} ${timezone ?? "runtime local"})`).join(", ")}`,
    );

  const shutdown = () => {
    cronJobs.forEach((job) => job.stop());
    running.server.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
