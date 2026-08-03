import assert from "node:assert/strict";
import test from "node:test";
import { isAppName, normalizeAppSchedules } from "@nosrv/core";

test("normalizes the shared App name and schedule contract", () => {
  assert.equal(isAppName("app--variant"), true);
  assert.equal(isAppName("-invalid"), false);
  assert.equal(isAppName("a".repeat(64)), false);

  assert.deepEqual(
    normalizeAppSchedules([{ name: "work-hours", cron: "  */15 9-17 * JAN-MAR MON-FRI  " }]),
    [{ name: "work-hours", cron: "*/15 9-17 * JAN-MAR MON-FRI" }],
  );
  assert.throws(
    () => normalizeAppSchedules([{ name: "invalid", cron: "60 * * * *" }]),
    /Invalid cron expression/,
  );
  assert.throws(
    () =>
      normalizeAppSchedules([
        { name: "duplicate", cron: "0 1 * * *" },
        { name: "duplicate", cron: "0 2 * * *" },
      ]),
    /Duplicate schedule name/,
  );
  assert.throws(
    () =>
      normalizeAppSchedules([
        { name: "first", cron: "0 1 * * *" },
        { name: "second", cron: "0 1 * * *" },
      ]),
    /Duplicate cron expression/,
  );
});
