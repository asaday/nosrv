import assert from "node:assert/strict";
import { test } from "node:test";
import { EnvironmentSecrets, publicEnvironment } from "@nosrv/core";

test("configured environment and secrets are available without App declarations", async () => {
  const values = { PUBLIC_VALUE: "visible", API_KEY: "private" };
  const env = publicEnvironment(values);
  const secrets = new EnvironmentSecrets(values);

  assert.equal(env.PUBLIC_VALUE, "visible");
  assert.equal(env.API_KEY, "private");
  assert.equal(await secrets.get("API_KEY"), "private");
  assert.equal(await secrets.get("MISSING"), null);
});

test("runtime-owned environment names can be hidden", () => {
  const env = publicEnvironment({ PUBLIC_VALUE: "visible", INTERNAL_TOKEN: "hidden" }, [
    "INTERNAL_TOKEN",
  ]);

  assert.equal(env.PUBLIC_VALUE, "visible");
  assert.equal(env.INTERNAL_TOKEN, undefined);
});
