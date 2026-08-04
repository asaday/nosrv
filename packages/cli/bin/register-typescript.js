import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generatedDirectory } from "./project.js";

export async function registerTypeScript(cwd, appPath) {
  const { register } = await import("tsx/esm/api");
  const requireFromApp = createRequire(pathToFileURL(appPath));
  try {
    requireFromApp.resolve("@nosrv/core");
    register();
    return;
  } catch {
    // A GitHub-installed CLI lives in npm's npx cache, outside the application.
    // Point TypeScript imports back to the packages shipped with this repository.
  }

  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const outputDirectory = generatedDirectory(cwd);
  const tsconfigPath = resolve(outputDirectory, "tsconfig.npx.json");
  const packagePaths = {
    "@nosrv/adapter-cloudflare": ["packages/adapter-cloudflare/src/index.ts"],
    "@nosrv/adapter-azure-functions": ["packages/adapter-azure-functions/src/index.ts"],
    "@nosrv/adapter-google-functions": ["packages/adapter-google-functions/src/index.ts"],
    "@nosrv/adapter-lambda": ["packages/adapter-lambda/src/index.ts"],
    "@nosrv/core": ["packages/core/src/index.ts"],
    "@nosrv/provider-cloudflare-kv": ["packages/provider-cloudflare-kv/src/index.ts"],
    "@nosrv/provider-azure-blob": ["packages/provider-azure-blob/src/index.ts"],
    "@nosrv/provider-cosmos": ["packages/provider-cosmos/src/index.ts"],
    "@nosrv/provider-d1": ["packages/provider-d1/src/index.ts"],
    "@nosrv/provider-dynamodb": ["packages/provider-dynamodb/src/index.ts"],
    "@nosrv/provider-filesystem": ["packages/provider-filesystem/src/index.ts"],
    "@nosrv/provider-firestore": ["packages/provider-firestore/src/index.ts"],
    "@nosrv/provider-gcs": ["packages/provider-gcs/src/index.ts"],
    "@nosrv/provider-postgres": ["packages/provider-postgres/src/index.ts"],
    "@nosrv/provider-r2": ["packages/provider-r2/src/index.ts"],
    "@nosrv/provider-redis": ["packages/provider-redis/src/index.ts"],
    "@nosrv/provider-s3": ["packages/provider-s3/src/index.ts"],
    "@nosrv/provider-sql": ["packages/provider-sql/src/index.ts"],
    "@nosrv/provider-sqlite": ["packages/provider-sqlite/src/index.ts"],
    "@nosrv/provider-static-files": ["packages/provider-static-files/src/index.ts"],
    "@nosrv/provider-memory": ["packages/provider-memory/src/index.ts"],
    "@nosrv/router": ["packages/router/src/index.ts"],
    "@nosrv/runtime-node": ["packages/runtime-node/src/index.ts"],
  };
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    tsconfigPath,
    `${JSON.stringify({ compilerOptions: { baseUrl: packageRoot, paths: packagePaths } }, null, 2)}\n`,
    "utf8",
  );
  register({ tsconfig: tsconfigPath });
}
