import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  copyPublicDirectory,
  postgresDatabaseConfig,
  resolveEnvironment,
  resolvePublicConfig,
  resolveResourcesDirectory,
  resolveSchedules,
  workerName,
} from "../project.js";
import { bundleDeployment, readOption } from "./shared.js";

function required(value, message) {
  if (typeof value !== "string" || !value) throw new Error(message);
  return value;
}

function azureCron(cron) {
  return `0 ${cron}`;
}

async function generateAzureDeployment(cwd, appPath, config) {
  const output = resolve(cwd, ".nosrv/azure/deploy");
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });

  const publicConfig = resolvePublicConfig(cwd, config.spa === true);
  if (publicConfig) await copyPublicDirectory(publicConfig.directory, resolve(output, "public"));
  const resourcesDirectory = resolveResourcesDirectory(cwd);
  if (resourcesDirectory)
    await copyPublicDirectory(resourcesDirectory, resolve(output, "resources"));

  const provider = config.providers?.azure ?? {};
  const storage = provider.storage;
  const kv = provider.kv;
  const postgres = postgresDatabaseConfig(cwd, config, "azure");
  if (storage && (storage.provider ?? "azure-blob") !== "azure-blob")
    throw new Error(`Unsupported Azure storage provider: ${storage.provider}`);
  if (kv && (kv.provider ?? "cosmos") !== "cosmos")
    throw new Error(`Unsupported Azure KV provider: ${kv.provider}`);
  if (storage) required(storage.container, "Azure Blob storage requires a container name");
  if (kv) {
    required(kv.database, "Azure Cosmos KV requires a database name");
    required(kv.container, "Azure Cosmos KV requires a container name");
  }

  const blobConnectionEnv = storage?.connectionStringEnv ?? "AZURE_STORAGE_CONNECTION_STRING";
  const cosmosConnectionEnv = kv?.connectionStringEnv ?? "AZURE_COSMOS_CONNECTION_STRING";
  const hiddenEnvNames = [
    ...(storage ? [blobConnectionEnv] : []),
    ...(kv ? [cosmosConnectionEnv] : []),
    ...(postgres ? [postgres.urlEnv] : []),
  ];
  const options = [
    resolveEnvironment(config.env)
      ? `env: ${JSON.stringify(resolveEnvironment(config.env))}`
      : undefined,
    storage ? `blobContainer: ${JSON.stringify(storage.container)}` : undefined,
    storage ? `blobConnectionStringEnv: ${JSON.stringify(blobConnectionEnv)}` : undefined,
    kv ? `cosmosDatabase: ${JSON.stringify(kv.database)}` : undefined,
    kv ? `cosmosContainer: ${JSON.stringify(kv.container)}` : undefined,
    kv ? `cosmosConnectionStringEnv: ${JSON.stringify(cosmosConnectionEnv)}` : undefined,
    postgres
      ? `db: new PostgresDatabase(requiredEnvironment(${JSON.stringify(postgres.urlEnv)}), ${JSON.stringify(postgres.appId)})`
      : undefined,
    hiddenEnvNames.length ? `hiddenEnvNames: ${JSON.stringify(hiddenEnvNames)}` : undefined,
    publicConfig ? `assetsDirectory: new URL("./public", import.meta.url).pathname` : undefined,
    publicConfig?.spa ? "assetsSpaFallback: true" : undefined,
    resourcesDirectory
      ? `resources: new FilesystemResources(new URL("./resources", import.meta.url).pathname)`
      : undefined,
  ]
    .filter(Boolean)
    .join(", ");

  const require = createRequire(import.meta.url);
  const adapterPath = require.resolve("@nosrv/adapter-azure-functions");
  const resourceProviderPath = require.resolve("@nosrv/provider-filesystem");
  const postgresProviderPath = require.resolve("@nosrv/provider-postgres");
  const appImport = appPath
    ? `import nosrvApp from ${JSON.stringify(appPath)};`
    : `const nosrvApp = { fetch() { return new Response("Not found", { status: 404 }); } };`;
  const schedules = resolveSchedules(config.schedules);
  const deployment = config.deploy?.azure ?? {};
  const authLevel = deployment.authLevel ?? "anonymous";
  const timerRegistrations = schedules
    .map(
      (schedule) =>
        `app.timer(${JSON.stringify(`nosrv-${schedule.name}`)}, { schedule: ${JSON.stringify(azureCron(schedule.cron))}, handler: createAzureTimerHandler(nosrvApp, { ...adapterOptions, name: ${JSON.stringify(schedule.name)}, cron: ${JSON.stringify(schedule.cron)} }) });`,
    )
    .join("\n");
  const entry = `import { app } from "@azure/functions";
import { createAzureHttpHandler, createAzureTimerHandler } from ${JSON.stringify(adapterPath)};
import { FilesystemResources } from ${JSON.stringify(resourceProviderPath)};
${postgres ? `import { PostgresDatabase } from ${JSON.stringify(postgresProviderPath)};` : ""}
${appImport}
function requiredEnvironment(name) { const value = process.env[name]; if (!value) throw new Error(\`PostgreSQL database requires \${name}\`); return value; }
const adapterOptions = { ${options} };
app.setup({ enableHttpStream: true });
app.http("nosrv", { methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"], authLevel: ${JSON.stringify(authLevel)}, route: "{*path}", handler: createAzureHttpHandler(nosrvApp, adapterOptions) });
${timerRegistrations}
`;
  await bundleDeployment(entry, resolve(output, "index.mjs"), [
    "@azure/functions",
    "@azure/storage-blob",
    "@azure/cosmos",
    ...(postgres ? ["pg"] : []),
  ]);
  await Promise.all([
    writeFile(
      resolve(output, "host.json"),
      `${JSON.stringify({ version: "2.0", extensions: { http: { routePrefix: "" } } }, null, 2)}\n`,
    ),
    writeFile(
      resolve(output, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          type: "module",
          main: "index.mjs",
          engines: { node: ">=22" },
          dependencies: {
            "@azure/functions": "^4.7.0",
            ...(storage ? { "@azure/storage-blob": "^12.28.0" } : {}),
            ...(kv ? { "@azure/cosmos": "^4.5.1" } : {}),
            ...(postgres ? { pg: "^8.16.0" } : {}),
          },
        },
        null,
        2,
      )}\n`,
    ),
    writeFile(resolve(output, ".funcignore"), ".git*\nlocal.settings.json\n", "utf8"),
  ]);
  return output;
}

export async function runAzureDeploy(cwd, appPath, config, args) {
  const output = await generateAzureDeployment(cwd, appPath, config);
  const deployment = config.deploy?.azure ?? {};
  const appName = readOption(args, "--app") ?? deployment.app ?? workerName(cwd, config);
  console.log(`Generated Azure Functions deployment: ${output}`);
  if (args.includes("--dry-run")) return;
  const commandArgs = ["azure", "functionapp", "publish", appName];
  if (deployment.slot) commandArgs.push("--slot", deployment.slot);
  const child = spawn("func", commandArgs, { cwd: output, stdio: "inherit" });
  const code = await new Promise((done, reject) => {
    child.once("error", (error) =>
      reject(
        error.code === "ENOENT"
          ? new Error("Azure Functions Core Tools v4 is required; install func and run az login")
          : error,
      ),
    );
    child.once("exit", (value, signal) => done(signal ? 1 : (value ?? 1)));
  });
  if (code !== 0) process.exitCode = code;
}
