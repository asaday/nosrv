import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const version = manifest.version;
const tag = `v${version}`;

function output(command, args) {
  return execFileSync(command, args, { cwd: root, encoding: "utf8" }).trim();
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Invalid root version: ${version}`);
}
if (output("git", ["tag", "--list", tag])) {
  throw new Error(`Git tag already exists: ${tag}`);
}
run("gh", ["auth", "status"]);

if (!output("git", ["status", "--porcelain"])) {
  throw new Error("No release changes found to commit");
}
run("git", ["add", "-A"]);
run("git", ["commit", "-m", `chore: release ${tag}`]);
run("git", ["tag", "-a", tag, "-m", `Release ${tag}`]);
run("git", ["push", "origin", "HEAD"]);
run("git", ["push", "origin", tag]);
run("gh", ["release", "create", tag, "--title", tag, "--generate-notes"]);
