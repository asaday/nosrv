import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const pluginRoot = new URL("../.agents/plugins/plugins/nosrv/", import.meta.url);

test("ships a self-contained Agent Plugin for building nosrv Apps", async () => {
  const manifest = JSON.parse(await readFile(new URL("plugin.json", pluginRoot), "utf8")) as {
    $schema?: string;
    name?: string;
    version?: string;
    license?: string;
  };
  assert.equal(manifest.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.equal(manifest.name, "nosrv");
  assert.match(manifest.version ?? "", /^0\.1\.0(?:\+.+)?$/);
  assert.equal(manifest.license, "Apache-2.0");

  const codexManifest = JSON.parse(
    await readFile(new URL(".codex-plugin/plugin.json", pluginRoot), "utf8"),
  ) as {
    name?: string;
    version?: string;
    skills?: string;
  };
  assert.equal(codexManifest.name, "nosrv");
  assert.match(codexManifest.version ?? "", /^0\.1\.0(?:\+.+)?$/);
  assert.equal(codexManifest.skills, "./skills/");

  const skill = await readFile(new URL("skills/build-nosrv-app/SKILL.md", pluginRoot), "utf8");
  const contract = await readFile(
    new URL("skills/build-nosrv-app/references/contract.md", pluginRoot),
    "utf8",
  );
  const patterns = await readFile(
    new URL("skills/build-nosrv-app/references/api-patterns.md", pluginRoot),
    "utf8",
  );

  for (const required of [
    "lifecycle cost",
    "constrained access",
    "scheduled",
    "public FaaS",
    "host permissions",
    "structured `ctx.db` CRUD",
    "Do not generate raw SQL",
    "nosrv tools list --json",
    "ctx.tools.<group>",
  ]) {
    assert.ok(skill.includes(required), `skill should explain ${required}`);
  }
  for (const required of [
    "Request` and `Response",
    "ctx.db",
    "ctx.kv",
    "ctx.storage",
    "Node.js Permission Model",
    "nosrv deploy --target",
  ]) {
    assert.ok(contract.includes(required), `bundled contract should explain ${required}`);
  }
  assert.match(patterns, /defineApp/);
  assert.match(patterns, /createRouter/);
  assert.match(patterns, /scheduled/);
});
