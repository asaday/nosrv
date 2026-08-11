import assert from "node:assert/strict";
import test from "node:test";
// The CLI entry modules are intentionally authored as JavaScript.
// @ts-expect-error no declaration file is published for internal CLI helpers
import { resolveBindings } from "../packages/cli/bin/project.js";

test("validates named Platform bindings and tool allowlists", () => {
  assert.deepEqual(resolveBindings({ drive: { tools: ["search_files"] } }), {
    drive: { tools: ["search_files"] },
  });
  assert.throws(() => resolveBindings({ drive: { tools: [] } }), /non-empty string array/);
  assert.throws(() => resolveBindings({ drive: { tools: ["search", "search"] } }), /duplicates/);
});
