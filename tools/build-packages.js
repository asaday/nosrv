import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packagesRoot = resolve(root, "packages");
const packages = new Map();

for (const directory of readdirSync(packagesRoot)) {
  const manifestPath = resolve(packagesRoot, directory, "package.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const configPath = resolve(packagesRoot, directory, "tsconfig.build.json");
  if (manifest.private || !existsSync(configPath)) continue;
  packages.set(manifest.name, { directory, manifest, configPath });
}

const built = new Set();
const active = new Set();

function build(name) {
  if (built.has(name)) return;
  if (active.has(name)) throw new Error(`Circular package dependency involving ${name}`);
  const pkg = packages.get(name);
  if (!pkg) return;

  active.add(name);
  for (const dependency of Object.keys(pkg.manifest.dependencies ?? {})) build(dependency);
  active.delete(name);

  rmSync(resolve(packagesRoot, pkg.directory, "dist"), { recursive: true, force: true });
  const result = spawnSync(
    process.execPath,
    [resolve(root, "node_modules/typescript/bin/tsc"), "-p", pkg.configPath],
    {
      cwd: root,
      stdio: "inherit",
    },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
  built.add(name);
}

for (const name of packages.keys()) build(name);
console.log(`Built ${built.size} publishable TypeScript packages.`);
