import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { validateConfig } from "../packages/cli/bin/project.js";

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

test("bundled AI specification directs agents to discover Platform tools", async () => {
  const specification = await readFile(resolve("packages/cli/spec/ai-spec.md"), "utf8");
  assert.match(specification, /nosrv tools list --json/);
  assert.match(specification, /requires\.tools/);
  assert.match(specification, /ctx\.tools\.drive/);
  assert.match(specification, /result\.rowsAffected === 0/);
  assert.match(specification, /do not test the result object itself for truthiness/i);
});

test("nosrv.yaml rejects App-level authentication settings", () => {
  assert.throws(
    () => validateConfig({ name: "example", auth: { mode: "required" } }),
    /Unsupported nosrv.yaml key: auth/,
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
    const agentInstructions = await readFile(resolve(app, "AGENTS.md"), "utf8");
    assert.match(agentInstructions, /npx nosrv tools list --json/);
    assert.match(agentInstructions, /requires\.tools/);
    assert.match(agentInstructions, /ctx\.tools\.<group>/);

    await exec("npm", ["install", "--ignore-scripts"], { cwd: app });
    await exec("npm", ["run", "dev", "--", "--help"], {
      cwd: app,
      env: { ...process.env, npm_config_cache: resolve(parent, ".npm-cache") },
    });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
