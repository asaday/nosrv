import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { embeddedResourcesExpression } from "../artifact.js";
import { resolveCloudPackage } from "./packages.js";
import {
  moduleSpecifier,
  resolveEnvironment,
  resolvePublicConfig,
  resolveResourcesDirectory,
  resolveSchedules,
  stagePublicDirectory,
  workerName,
  writeStaticApp,
} from "../project.js";

async function generateCloudflare(cwd, appPath, config) {
  const outputDirectory = resolve(cwd, ".nosrv/cloudflare");
  await mkdir(outputDirectory, { recursive: true });
  const resolvedAppPath =
    appPath ?? (await writeStaticApp(resolve(outputDirectory, "static-app.mjs")));

  const entryPath = resolve(outputDirectory, "worker.ts");
  const configPath = resolve(outputDirectory, "wrangler.jsonc");
  const publicConfig = await stagePublicDirectory(
    cwd,
    "cloudflare",
    resolvePublicConfig(cwd, config.spa === true),
  );
  const publicDirectory = publicConfig?.directory;
  const resourcesDirectory = resolveResourcesDirectory(cwd);
  const embeddedResources = await embeddedResourcesExpression(resourcesDirectory);
  const cloudflarePackage = resolveCloudPackage(cwd, "cloudflare");
  const wranglerDirectory = dirname(cloudflarePackage.require.resolve("wrangler/package.json"));
  const schemaPath = resolve(wranglerDirectory, "config-schema.json");
  const storage = config.providers?.cloudflare?.storage;
  const kv = config.providers?.cloudflare?.kv;
  const db = config.providers?.cloudflare?.db;
  if (storage && (storage.provider ?? "r2") !== "r2") {
    throw new Error(`Unsupported Cloudflare storage provider: ${storage.provider}`);
  }
  if (kv && (kv.provider ?? "workers-kv") !== "workers-kv") {
    throw new Error(`Unsupported Cloudflare KV provider: ${kv.provider}`);
  }
  if (db && (db.provider ?? "d1") !== "d1")
    throw new Error(`Unsupported Cloudflare database provider: ${db.provider}`);
  const r2Binding = storage ? "NOSRV_STORAGE" : undefined;
  const kvBinding = kv ? "NOSRV_KV" : undefined;
  const d1Binding = db ? "NOSRV_DB" : undefined;
  const schedules = resolveSchedules(config.schedules);
  const adapterOptions = [
    resolveEnvironment(config.env)
      ? "env: " + JSON.stringify(resolveEnvironment(config.env))
      : undefined,
    r2Binding ? `r2Binding: ${JSON.stringify(r2Binding)}` : undefined,
    kvBinding ? `kvBinding: ${JSON.stringify(kvBinding)}` : undefined,
    d1Binding ? `d1Binding: ${JSON.stringify(d1Binding)}` : undefined,
    schedules.length ? `schedules: ${JSON.stringify(schedules)}` : undefined,
    embeddedResources ? `resources: ${embeddedResources}` : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  const adapterPath = cloudflarePackage.entryPath;
  const corePath = cloudflarePackage.require.resolve("@nosrv/core");
  const entry = `import { createCloudflareHandler } from ${JSON.stringify(adapterPath)};\nimport { MemoryResources } from ${JSON.stringify(corePath)};\nimport app from ${JSON.stringify(moduleSpecifier(outputDirectory, resolvedAppPath))};\n\nexport default createCloudflareHandler(app${adapterOptions ? `, { ${adapterOptions} }` : ""});\n`;
  const wranglerConfig = {
    $schema: schemaPath,
    name: workerName(cwd, config),
    main: "./worker.ts",
    compatibility_date: new Date().toISOString().slice(0, 10),
    compatibility_flags: ["nodejs_compat"],
    observability: {
      enabled: true,
      logs: { head_sampling_rate: 1 },
    },
    ...(publicDirectory
      ? {
          assets: {
            directory: moduleSpecifier(outputDirectory, publicDirectory),
            binding: "NOSRV_ASSETS",
            run_worker_first: ["/api", "/api/*"],
            ...(publicConfig.spa ? { not_found_handling: "single-page-application" } : {}),
          },
        }
      : {}),
    ...(storage
      ? {
          r2_buckets: [
            {
              binding: r2Binding,
              bucket_name: storage.bucket ?? `${workerName(cwd, config)}-storage`,
            },
          ],
        }
      : {}),
    ...(kv
      ? {
          kv_namespaces: [{ binding: kvBinding, id: kv.id ?? "local-nosrv-kv" }],
        }
      : {}),
    ...(db
      ? {
          d1_databases: [
            {
              binding: d1Binding,
              database_name: db.database ?? `${workerName(cwd, config)}-db`,
              database_id: db.id ?? "local-nosrv-db",
            },
          ],
        }
      : {}),
    ...(schedules.length
      ? { triggers: { crons: schedules.map((schedule) => schedule.cron) } }
      : {}),
  };

  await Promise.all([
    writeFile(entryPath, entry, "utf8"),
    writeFile(configPath, `${JSON.stringify(wranglerConfig, null, 2)}\n`, "utf8"),
  ]);
  return { configPath, wranglerDirectory };
}

export async function runWranglerDev(cwd, appPath, config, { hostname, port }) {
  const generated = await generateCloudflare(cwd, appPath, config);
  const wranglerBin = resolve(generated.wranglerDirectory, "bin/wrangler.js");
  const args = [
    wranglerBin,
    "dev",
    "--config",
    generated.configPath,
    "--ip",
    hostname,
    "--port",
    String(port),
  ];

  console.log("nosrv Cloudflare development server");
  console.log(`App: ${appPath ?? "(static only)"}`);
  console.log(`Generated: ${dirname(generated.configPath)}`);

  const child = spawn(process.execPath, args, { cwd, stdio: "inherit" });
  const forwardSignal = (signal) => child.kill(signal);
  process.once("SIGINT", forwardSignal);
  process.once("SIGTERM", forwardSignal);

  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit(signal ? 1 : (code ?? 1)));
  });
  process.removeListener("SIGINT", forwardSignal);
  process.removeListener("SIGTERM", forwardSignal);
  if (exitCode !== 0) process.exitCode = exitCode;
}

function withoutTargetOption(args) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--target" || args[index] === "-t" || args[index] === "-target") {
      index += 1;
      continue;
    }
    result.push(args[index]);
  }
  return result;
}

export async function runWranglerDeploy(cwd, appPath, config, args) {
  const generated = await generateCloudflare(cwd, appPath, config);
  const wranglerBin = resolve(generated.wranglerDirectory, "bin/wrangler.js");
  const deployArgs = [
    wranglerBin,
    "deploy",
    "--config",
    generated.configPath,
    ...withoutTargetOption(args),
  ];

  console.log("nosrv Cloudflare deployment");
  console.log(`App: ${appPath ?? "(static only)"}`);
  console.log(`Generated: ${dirname(generated.configPath)}`);

  const child = spawn(process.execPath, deployArgs, { cwd, stdio: "inherit" });
  const forwardSignal = (signal) => child.kill(signal);
  process.once("SIGINT", forwardSignal);
  process.once("SIGTERM", forwardSignal);
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit(signal ? 1 : (code ?? 1)));
  });
  process.removeListener("SIGINT", forwardSignal);
  process.removeListener("SIGTERM", forwardSignal);
  if (exitCode !== 0) process.exitCode = exitCode;
}
