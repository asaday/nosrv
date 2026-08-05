import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const cli = resolve("packages/cli/bin/nosrv.js");

test("CLI help reports the package version", async () => {
  const manifest = JSON.parse(await readFile(resolve("packages/cli/package.json"), "utf8"));
  const result = await exec(process.execPath, [cli, "--help"]);
  assert.match(
    result.stdout,
    new RegExp(`^nosrv v${manifest.version.replaceAll(".", "\\.")}$`, "m"),
  );
});

test("create produces an installable App from a source checkout", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "nosrv-create-"));
  const app = resolve(parent, "hello");

  try {
    const created = await exec(process.execPath, [cli, "create", app]);
    assert.match(created.stdout, /npm run dev/);

    const pkg = JSON.parse(await readFile(resolve(app, "package.json"), "utf8"));
    assert.match(pkg.dependencies["@nosrv/core"], /^file:/);
    assert.equal("devDependencies" in pkg, false);
    assert.equal(pkg.scripts.dev, "npx nosrv dev");
    assert.equal(pkg.scripts.deploy, "npx nosrv deploy");
    assert.equal(pkg.engines.node, ">=24");

    await exec("npm", ["install", "--ignore-scripts"], { cwd: app });
    await exec("npm", ["run", "dev", "--", "--help"], {
      cwd: app,
      env: { ...process.env, npm_config_cache: resolve(parent, ".npm-cache") },
    });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
