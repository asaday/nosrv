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
    "@nosrv/aws": ["packages/aws/src/index.ts"],
    "@nosrv/azure": ["packages/azure/src/index.ts"],
    "@nosrv/cloudflare": ["packages/cloudflare/src/index.ts"],
    "@nosrv/core": ["packages/core/src/index.ts"],
    "@nosrv/google-cloud": ["packages/google-cloud/src/index.ts"],
    "@nosrv/postgres": ["packages/postgres/src/index.ts"],
    "@nosrv/redis": ["packages/redis/src/index.ts"],
    "nosrv/runtime/filesystem": ["packages/cli/src/filesystem.ts"],
    "nosrv/runtime/memory": ["packages/cli/src/memory.ts"],
    "nosrv/runtime/node": ["packages/cli/src/runtime-node.ts"],
    "nosrv/runtime/sqlite": ["packages/cli/src/sqlite.ts"],
    "nosrv/runtime/static-files": ["packages/cli/src/static-files.ts"],
  };
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    tsconfigPath,
    `${JSON.stringify({ compilerOptions: { baseUrl: packageRoot, paths: packagePaths } }, null, 2)}\n`,
    "utf8",
  );
  register({ tsconfig: tsconfigPath });
}
