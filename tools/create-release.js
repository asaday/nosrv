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

function runCapture(command, args) {
  return execFileSync(command, args, { cwd: root, encoding: "utf8" }).trim();
}

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Invalid root version: ${version}`);
}
if (output("git", ["tag", "--list", tag])) {
  throw new Error(`Git tag already exists: ${tag}`);
}
const changes = output("git", ["status", "--short"]);
if (changes) {
  console.error("Cannot create a release with uncommitted changes:\n");
  console.error(changes);
  console.error("\nReview and commit these changes, then run `npm run release` again.");
  process.exit(1);
}

const branch = output("git", ["branch", "--show-current"]);
if (branch !== "dev") {
  console.error(`Cannot create a release from branch ${branch || "(detached HEAD)"}.`);
  console.error("Switch to dev and run `npm run release` again.");
  process.exit(1);
}
run("gh", ["auth", "status"]);
run("git", ["fetch", "origin", "dev"]);

const [ahead, behind] = output("git", [
  "rev-list",
  "--left-right",
  "--count",
  "HEAD...origin/dev",
]).split(/\s+/);
if (ahead !== "0" || behind !== "0") {
  console.error("Cannot create a release unless local dev matches origin/dev.");
  console.error(`Local dev is ${ahead} commit(s) ahead and ${behind} commit(s) behind origin/dev.`);
  console.error("Push or reconcile the branch, then run `npm run release` again.");
  process.exit(1);
}

console.log(
  runCapture("gh", [
    "pr",
    "create",
    "--base",
    "main",
    "--head",
    "dev",
    "--title",
    `Release ${tag}`,
    "--body",
    `Release ${tag}. npm packages have been published and this PR is ready to squash merge.`,
  ]),
);
run("gh", ["pr", "merge", "dev", "--squash"]);
run("git", ["switch", "main"]);
run("git", ["pull", "--ff-only", "origin", "main"]);

run("git", ["tag", "-a", tag, "-m", `Release ${tag}`]);
run("git", ["push", "origin", tag]);
run("gh", ["release", "create", tag, "--title", tag, "--generate-notes"]);

run("git", ["switch", "dev"]);
run("git", ["pull", "--ff-only", "origin", "dev"]);
run("git", ["merge", "origin/main", "--no-edit"]);
run("git", ["push", "origin", "dev"]);
