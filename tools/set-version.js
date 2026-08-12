import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("Usage: npm run set-version -- 0.3.0");
  process.exit(1);
}

const packagePath = resolve(root, "package.json");
const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
manifest.version = version;
writeFileSync(packagePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const sync = spawnSync(process.execPath, [resolve(root, "tools/sync-release-version.js")], {
  cwd: root,
  stdio: "inherit",
});
if (sync.status !== 0) process.exit(sync.status ?? 1);

const lockfile = spawnSync("npm", ["install", "--package-lock-only", "--ignore-scripts"], {
  cwd: root,
  stdio: "inherit",
});
process.exit(lockfile.status ?? 1);
