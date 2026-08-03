import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packagesRoot = resolve(root, "packages");

export function publishablePackages() {
  const packages = new Map();
  for (const directory of readdirSync(packagesRoot)) {
    const manifestPath = resolve(packagesRoot, directory, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.private) continue;
    packages.set(manifest.name, { directory, manifest, manifestPath });
  }
  return packages;
}

export function orderedPackages() {
  const packages = publishablePackages();
  const ordered = [];
  const visited = new Set();
  const active = new Set();

  function visit(name) {
    if (visited.has(name)) return;
    if (active.has(name)) throw new Error(`Circular package dependency involving ${name}`);
    const pkg = packages.get(name);
    if (!pkg) return;

    active.add(name);
    for (const dependency of Object.keys(pkg.manifest.dependencies ?? {})) visit(dependency);
    active.delete(name);
    visited.add(name);
    ordered.push(pkg);
  }

  for (const name of packages.keys()) visit(name);
  return ordered;
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0 && !options.allowFailure) {
    if (options.capture) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result;
}

export { root };
