import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const cli = resolve("packages/cli/bin/nosrv.js");

test("create produces an installable App from a source checkout", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "nosrv-create-"));
  const app = resolve(parent, "hello");

  try {
    const created = await exec(process.execPath, [cli, "create", app]);
    assert.match(created.stdout, /npm run dev/);

    const pkg = JSON.parse(await readFile(resolve(app, "package.json"), "utf8"));
    assert.match(pkg.dependencies["@nosrv/core"], /^file:/);
    assert.match(pkg.scripts.dev, /packages\/cli\/bin\/nosrv\.js.* dev$/);

    await exec("npm", ["install", "--ignore-scripts"], { cwd: app });
    await exec("npm", ["run", "dev", "--", "--help"], { cwd: app });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
