import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stringify } from "yaml";
import {
  copyPublicDirectory,
  postgresDatabaseConfig,
  resolveEnvironment,
  resolvePublicConfig,
  resolveResourcesDirectory,
  resolveSchedules,
  workerName,
  writeStaticApp,
} from "../project.js";
import { registerTypeScript } from "../register-typescript.js";
import { resolveCloudPackage, resolvePostgresPackage } from "./packages.js";
import { bundleDeployment } from "./shared.js";

async function generateLambdaDeployment(cwd, appPath, config) {
  if (!appPath) throw new Error("Lambda deployment requires an application handler");
  const schedules = resolveSchedules(config.schedules);
  if (schedules.length)
    throw new Error(
      "Lambda schedule provisioning is not automated yet; EventBridge schedule generation is the next deployment step",
    );
  const output = resolve(cwd, ".nosrv/lambda/deploy");
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const publicConfig = resolvePublicConfig(cwd, config.spa === true);
  if (publicConfig) await copyPublicDirectory(publicConfig.directory, resolve(output, "public"));
  const resourcesDirectory = resolveResourcesDirectory(cwd);
  if (resourcesDirectory)
    await copyPublicDirectory(resourcesDirectory, resolve(output, "resources"));
  const provider = config.providers?.lambda ?? {};
  const postgres = postgresDatabaseConfig(cwd, config, "lambda");
  const awsPackage = resolveCloudPackage(cwd, "lambda");
  const postgresPackage = postgres ? resolvePostgresPackage(cwd, "AWS Lambda") : null;
  if (provider.storage && (provider.storage.provider ?? "s3") !== "s3")
    throw new Error(`Unsupported Lambda storage provider: ${provider.storage.provider}`);
  if (provider.kv && (provider.kv.provider ?? "dynamodb") !== "dynamodb")
    throw new Error(`Unsupported Lambda KV provider: ${provider.kv.provider}`);
  if (provider.storage && !provider.storage.bucket)
    throw new Error("Lambda S3 storage requires a bucket name");
  if (provider.kv && !provider.kv.table)
    throw new Error("Lambda DynamoDB KV requires a table name");
  const options = [
    resolveEnvironment(config.env)
      ? "env: " + JSON.stringify(resolveEnvironment(config.env))
      : undefined,
    provider.storage ? `s3Bucket: ${JSON.stringify(provider.storage.bucket)}` : undefined,
    provider.kv ? `dynamodbTable: ${JSON.stringify(provider.kv.table)}` : undefined,
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
  const adapterPath = awsPackage.entryPath;
  const resourceProviderPath = resolve(import.meta.dirname, "../../dist/filesystem.js");
  const postgresProviderPath = postgresPackage?.entryPath;
  const entry = `import { createLambdaHandler } from ${JSON.stringify(adapterPath)};
import { FilesystemResources } from ${JSON.stringify(resourceProviderPath)};
${postgres ? `import { PostgresDatabase } from ${JSON.stringify(postgresProviderPath)};` : ""}
import app from ${JSON.stringify(appPath)};
function requiredEnvironment(name) { const value = process.env[name]; if (!value) throw new Error(\`PostgreSQL database requires \${name}\`); return value; }
export const handler = createLambdaHandler(app${options ? `, { ${options} }` : ""});
`;
  await bundleDeployment(entry, resolve(output, "handler.mjs"), [
    "@aws-sdk/client-dynamodb",
    "@aws-sdk/client-s3",
    ...(postgres ? ["pg"] : []),
  ]);
  await writeFile(
    resolve(output, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies: {
          "@aws-sdk/client-dynamodb": "^3.800.0",
          "@aws-sdk/client-s3": "^3.800.0",
          ...(postgres ? { pg: "^8.16.0" } : {}),
        },
      },
      null,
      2,
    )}\n`,
  );
  const deployment = config.deploy?.lambda ?? {};
  const runtime = deployment.runtime ?? "nodejs24.x";
  const auth = deployment.http?.auth === "none" ? "NONE" : "AWS_IAM";
  const template = {
    AWSTemplateFormatVersion: "2010-09-09",
    Transform: "AWS::Serverless-2016-10-31",
    Resources: {
      NosrvFunction: {
        Type: "AWS::Serverless::Function",
        Properties: {
          CodeUri: ".",
          Handler: "handler.handler",
          Runtime: runtime,
          Timeout: deployment.timeout ?? 30,
          FunctionUrlConfig: { AuthType: auth },
        },
      },
    },
    Outputs: {
      FunctionUrl: { Value: { "Fn::GetAtt": ["NosrvFunctionUrl", "FunctionUrl"] } },
    },
  };
  await writeFile(resolve(output, "template.yaml"), stringify(template), "utf8");
  return output;
}

export async function runLambdaDeploy(cwd, appPath, config, args) {
  const output = await generateLambdaDeployment(cwd, appPath, config);
  console.log(`Generated Lambda SAM deployment: ${output}`);
  if (args.includes("--dry-run")) return;
  const build = spawn(
    "sam",
    [
      "build",
      "--template-file",
      resolve(output, "template.yaml"),
      "--build-dir",
      resolve(output, ".aws-sam/build"),
    ],
    { cwd: output, stdio: "inherit" },
  );
  const buildCode = await new Promise((done, reject) => {
    build.once("error", (error) =>
      reject(
        error.code === "ENOENT"
          ? new Error("AWS SAM CLI is required for Lambda deployment")
          : error,
      ),
    );
    build.once("exit", (value, signal) => done(signal ? 1 : (value ?? 1)));
  });
  if (buildCode !== 0) {
    process.exitCode = buildCode;
    return;
  }
  const guided = args.includes("--guided") || !existsSync(resolve(output, "samconfig.toml"));
  const deployArgs = [
    "deploy",
    ...(guided ? ["--guided"] : []),
    "--template-file",
    resolve(output, ".aws-sam/build/template.yaml"),
  ];
  const deployment = config.deploy?.lambda ?? {};
  if (deployment.region) deployArgs.push("--region", String(deployment.region));
  const child = spawn("sam", deployArgs, { cwd: output, stdio: "inherit" });
  const code = await new Promise((done, reject) => {
    child.once("error", reject);
    child.once("exit", (value, signal) => done(signal ? 1 : (value ?? 1)));
  });
  if (code !== 0) process.exitCode = code;
}

export async function runLambdaDev(cwd, appPath, config, { hostname, port }) {
  const resolvedAppPath =
    appPath ?? (await writeStaticApp(resolve(cwd, ".nosrv/lambda/static-app.mjs")));
  await registerTypeScript(cwd, resolvedAppPath);
  const module = await import(pathToFileURL(resolvedAppPath).href);
  const app = module.default?.fetch ? module.default : module.default?.default;
  if (!app || typeof app.fetch !== "function")
    throw new Error(`${resolvedAppPath} must default-export an app created with defineApp()`);
  const awsPackage = resolveCloudPackage(cwd, "lambda");
  const { createLambdaHandler } = await import(pathToFileURL(awsPackage.entryPath).href);
  const { FilesystemResources } = await import(
    pathToFileURL(resolve(import.meta.dirname, "../../dist/filesystem.js")).href
  );
  const resourcesDirectory = resolveResourcesDirectory(cwd);
  const provider = config.providers?.lambda ?? {};
  const postgres = postgresDatabaseConfig(cwd, config, "lambda");
  if (provider.storage && (provider.storage.provider ?? "s3") !== "s3")
    throw new Error(`Unsupported Lambda storage provider: ${provider.storage.provider}`);
  if (provider.kv && (provider.kv.provider ?? "dynamodb") !== "dynamodb")
    throw new Error(`Unsupported Lambda KV provider: ${provider.kv.provider}`);
  if (provider.storage && !provider.storage.bucket)
    throw new Error("Lambda S3 storage requires a bucket name");
  if (provider.kv && !provider.kv.table)
    throw new Error("Lambda DynamoDB KV requires a table name");
  const postgresPackage = postgres ? resolvePostgresPackage(cwd, "AWS Lambda") : null;
  const database =
    postgres && postgresPackage
      ? new (await import(pathToFileURL(postgresPackage.entryPath).href)).PostgresDatabase(
          (() => {
            const value = process.env[postgres.urlEnv];
            if (!value) throw new Error(`PostgreSQL database requires ${postgres.urlEnv}`);
            return value;
          })(),
          postgres.appId,
        )
      : undefined;
  const handler = createLambdaHandler(app, {
    ...(provider.storage ? { s3Bucket: provider.storage.bucket } : {}),
    ...(provider.kv ? { dynamodbTable: provider.kv.table } : {}),
    ...(database ? { db: database, hiddenEnvNames: [postgres.urlEnv] } : {}),
    ...(resourcesDirectory ? { resources: new FilesystemResources(resourcesDirectory) } : {}),
  });
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks = [];
      for await (const chunk of incoming)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const host = incoming.headers.host ?? `${hostname}:${port}`;
      const url = new URL(incoming.url ?? "/", `http://${host}`);
      const headers = Object.fromEntries(
        Object.entries(incoming.headers).flatMap(([name, value]) =>
          typeof value === "string"
            ? [[name, value]]
            : Array.isArray(value)
              ? [[name, value.join(",")]]
              : [],
        ),
      );
      const event = {
        version: "2.0",
        routeKey: "$default",
        rawPath: url.pathname,
        rawQueryString: url.search.slice(1),
        headers,
        requestContext: {
          accountId: "local",
          apiId: "local",
          domainName: host,
          domainPrefix: "local",
          http: {
            method: incoming.method ?? "GET",
            path: url.pathname,
            protocol: "HTTP/1.1",
            sourceIp: "127.0.0.1",
            userAgent: headers["user-agent"] ?? "",
          },
          requestId: crypto.randomUUID(),
          routeKey: "$default",
          stage: "$default",
          time: new Date().toUTCString(),
          timeEpoch: Date.now(),
        },
        ...(body.length
          ? { body: body.toString("base64"), isBase64Encoded: true }
          : { isBase64Encoded: false }),
      };
      const result = await handler(event, {});
      outgoing.statusCode = result.statusCode ?? 200;
      for (const [name, value] of Object.entries(result.headers ?? {}))
        if (value !== undefined) outgoing.setHeader(name, String(value));
      if (result.cookies?.length) outgoing.setHeader("set-cookie", result.cookies);
      outgoing.end(
        result.isBase64Encoded ? Buffer.from(result.body ?? "", "base64") : (result.body ?? ""),
      );
    } catch (error) {
      outgoing.statusCode = 500;
      outgoing.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, done);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.log("nosrv Lambda HTTP API v2 emulator");
  console.log(`App: ${appPath ?? "(static only)"}`);
  console.log(`Local: http://${hostname}:${actualPort}`);
  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
