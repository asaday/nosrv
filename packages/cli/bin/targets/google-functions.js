import { mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  copyPublicDirectory,
  moduleSpecifier,
  postgresDatabaseConfig,
  resolveEnvironment,
  resolvePublicConfig,
  resolveResourcesDirectory,
  resolveSchedules,
  stagePublicDirectory,
  workerName,
  writeStaticApp,
} from "../project.js";
import { resolveCloudPackage, resolvePostgresPackage } from "./packages.js";
import { bundleDeployment, readOption } from "./shared.js";

async function generateGoogleDeployment(cwd, appPath, config) {
  if (!appPath) throw new Error("Google Functions deployment requires an application handler");
  const schedules = resolveSchedules(config.schedules);
  if (schedules.length) {
    throw new Error(
      "Google schedule provisioning is not automated yet; deploy the HTTP function without schedules or configure Cloud Scheduler explicitly",
    );
  }
  const output = resolve(cwd, ".nosrv/google-functions/deploy");
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const publicConfig = resolvePublicConfig(cwd, config.spa === true);
  if (publicConfig) await copyPublicDirectory(publicConfig.directory, resolve(output, "public"));
  const resourcesDirectory = resolveResourcesDirectory(cwd);
  if (resourcesDirectory)
    await copyPublicDirectory(resourcesDirectory, resolve(output, "resources"));
  const provider = config.providers?.["google-functions"] ?? {};
  const postgres = postgresDatabaseConfig(cwd, config, "google-functions");
  const googlePackage = resolveCloudPackage(cwd, "google-functions");
  const postgresPackage = postgres ? resolvePostgresPackage(cwd, "Google Functions") : null;
  if (provider.storage && (provider.storage.provider ?? "gcs") !== "gcs")
    throw new Error(`Unsupported Google Functions storage provider: ${provider.storage.provider}`);
  if (provider.kv && (provider.kv.provider ?? "firestore") !== "firestore")
    throw new Error(`Unsupported Google Functions KV provider: ${provider.kv.provider}`);
  if (provider.storage && !provider.storage.bucket)
    throw new Error("Google Functions GCS storage requires a bucket name");
  const options = [
    resolveEnvironment(config.env)
      ? "env: " + JSON.stringify(resolveEnvironment(config.env))
      : undefined,
    provider.storage ? `gcsBucket: ${JSON.stringify(provider.storage.bucket)}` : undefined,
    provider.kv
      ? `firestoreCollection: ${JSON.stringify(provider.kv.collection ?? "nosrv-kv")}`
      : undefined,
    postgres
      ? `db: new PostgresDatabase(requiredEnvironment(${JSON.stringify(postgres.urlEnv)}), ${JSON.stringify(postgres.appId)})`
      : undefined,
    postgres ? `hiddenEnvNames: [${JSON.stringify(postgres.urlEnv)}]` : undefined,
    publicConfig ? `assetsDirectory: new URL("./public", import.meta.url).pathname` : undefined,
    publicConfig?.spa ? "assetsSpaFallback: true" : undefined,
    resourcesDirectory
      ? `resources: new FilesystemResources(new URL("./resources", import.meta.url).pathname)`
      : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  const require = createRequire(import.meta.url);
  const adapterPath = googlePackage.entryPath;
  const resourceProviderPath = resolve(import.meta.dirname, "../../dist/filesystem.js");
  const postgresProviderPath = postgresPackage?.entryPath;
  const entry = `import { createGoogleFunctionsHandler } from ${JSON.stringify(adapterPath)};
import { FilesystemResources } from ${JSON.stringify(resourceProviderPath)};
${postgres ? `import { PostgresDatabase } from ${JSON.stringify(postgresProviderPath)};` : ""}
import app from ${JSON.stringify(appPath)};
function requiredEnvironment(name) { const value = process.env[name]; if (!value) throw new Error(\`PostgreSQL database requires \${name}\`); return value; }
export const nosrv = createGoogleFunctionsHandler(app${options ? `, { ${options} }` : ""});
`;
  await bundleDeployment(entry, resolve(output, "index.js"), [
    "@google-cloud/firestore",
    "@google-cloud/storage",
    ...(postgres ? ["pg"] : []),
  ]);
  await writeFile(
    resolve(output, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        type: "module",
        main: "index.js",
        engines: { node: ">=24" },
        dependencies: {
          "@google-cloud/firestore": "^7.11.0",
          "@google-cloud/storage": "^7.16.0",
          ...(postgres ? { pg: "^8.16.0" } : {}),
        },
      },
      null,
      2,
    )}\n`,
  );
  return output;
}

export async function runGoogleDeploy(cwd, appPath, config, args) {
  const output = await generateGoogleDeployment(cwd, appPath, config);
  const deployment = config.deploy?.["google-functions"] ?? {};
  const name = readOption(args, "--name") ?? deployment.name ?? workerName(cwd, config);
  const region = readOption(args, "--region") ?? deployment.region;
  const runtime = readOption(args, "--runtime") ?? deployment.runtime ?? "nodejs24";
  if (typeof region !== "string" || !region)
    throw new Error("Google deployment requires deploy.google-functions.region or --region");
  console.log(`Generated Google Functions deployment: ${output}`);
  if (args.includes("--dry-run")) return;
  const commandArgs = [
    "functions",
    "deploy",
    name,
    "--gen2",
    "--trigger-http",
    `--runtime=${runtime}`,
    `--region=${region}`,
    `--source=${output}`,
    "--entry-point=nosrv",
  ];
  if (deployment.allowUnauthenticated === true) commandArgs.push("--allow-unauthenticated");
  else commandArgs.push("--no-allow-unauthenticated");
  const child = spawn("gcloud", commandArgs, { cwd, stdio: "inherit" });
  const code = await new Promise((done, reject) => {
    child.once("error", (error) =>
      reject(
        error.code === "ENOENT"
          ? new Error("gcloud is required for Google Functions deployment")
          : error,
      ),
    );
    child.once("exit", (value, signal) => done(signal ? 1 : (value ?? 1)));
  });
  if (code !== 0) process.exitCode = code;
}

async function generateGoogleFunctions(cwd, appPath, config) {
  const outputDirectory = resolve(cwd, ".nosrv/google-functions");
  await mkdir(outputDirectory, { recursive: true });
  const resolvedAppPath =
    appPath ?? (await writeStaticApp(resolve(outputDirectory, "static-app.mjs")));
  const entryPath = resolve(outputDirectory, "index.ts");
  const storage = config.providers?.["google-functions"]?.storage;
  const kv = config.providers?.["google-functions"]?.kv;
  const postgres = postgresDatabaseConfig(cwd, config, "google-functions");
  const googlePackage = resolveCloudPackage(cwd, "google-functions");
  const postgresPackage = postgres ? resolvePostgresPackage(cwd, "Google Functions") : null;
  const publicConfig = await stagePublicDirectory(
    cwd,
    "google-functions",
    resolvePublicConfig(cwd, config.spa === true),
  );
  const publicDirectory = publicConfig?.directory;
  const resourcesDirectory = resolveResourcesDirectory(cwd);
  if (storage && (storage.provider ?? "gcs") !== "gcs") {
    throw new Error(`Unsupported Google Functions storage provider: ${storage.provider}`);
  }
  if (storage && !storage.bucket)
    throw new Error("Google Functions GCS storage requires a bucket name");
  if (kv && (kv.provider ?? "firestore") !== "firestore")
    throw new Error(`Unsupported Google Functions KV provider: ${kv.provider}`);
  const googleOptions = [
    storage ? `gcsBucket: ${JSON.stringify(storage.bucket)}` : undefined,
    kv ? `firestoreCollection: ${JSON.stringify(kv.collection ?? "nosrv-kv")}` : undefined,
    postgres
      ? `db: new PostgresDatabase(requiredEnvironment(${JSON.stringify(postgres.urlEnv)}), ${JSON.stringify(postgres.appId)})`
      : undefined,
    postgres ? `hiddenEnvNames: [${JSON.stringify(postgres.urlEnv)}]` : undefined,
    publicDirectory ? `assetsDirectory: ${JSON.stringify(publicDirectory)}` : undefined,
    publicConfig?.spa ? "assetsSpaFallback: true" : undefined,
    resourcesDirectory
      ? `resources: new FilesystemResources(${JSON.stringify(resourcesDirectory)})`
      : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  const adapterOptions = googleOptions ? `, { ${googleOptions} }` : "";
  const frameworkPath = googlePackage.require.resolve("@google-cloud/functions-framework");
  const resourceProviderPath = resolve(import.meta.dirname, "../../dist/filesystem.js");
  const entry = `import { http } from ${JSON.stringify(frameworkPath)};\nimport { createGoogleFunctionsHandler } from ${JSON.stringify(googlePackage.entryPath)};\nimport { FilesystemResources } from ${JSON.stringify(resourceProviderPath)};\n${postgresPackage ? `import { PostgresDatabase } from ${JSON.stringify(postgresPackage.entryPath)};\n` : ""}import app from ${JSON.stringify(moduleSpecifier(outputDirectory, resolvedAppPath))};\nfunction requiredEnvironment(name) { const value = process.env[name]; if (!value) throw new Error(\`PostgreSQL database requires \${name}\`); return value; }\n\nhttp("nosrv", createGoogleFunctionsHandler(app${adapterOptions}));\n`;
  await writeFile(entryPath, entry, "utf8");
  return entryPath;
}

export async function runGoogleFunctionsDev(cwd, appPath, config, { hostname, port }) {
  const entryPath = await generateGoogleFunctions(cwd, appPath, config);
  const googlePackage = resolveCloudPackage(cwd, "google-functions");
  const frameworkDirectory = dirname(
    googlePackage.require.resolve("@google-cloud/functions-framework"),
  );
  const require = createRequire(import.meta.url);
  const frameworkBin = resolve(frameworkDirectory, "main.js");
  const tsxLoader = require.resolve("tsx/esm");
  const args = [
    "--import",
    pathToFileURL(tsxLoader).href,
    frameworkBin,
    "--target=nosrv",
    `--source=${entryPath}`,
    `--port=${port}`,
  ];

  console.log("nosrv Google Functions development server");
  console.log(`App: ${appPath ?? "(static only)"}`);
  console.log(`Generated: ${dirname(entryPath)}`);
  if (hostname !== "127.0.0.1" && hostname !== "localhost") {
    console.log("Note: Google Functions Framework controls the listening interface.");
  }

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
