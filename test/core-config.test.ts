import assert from "node:assert/strict";
import test from "node:test";
import { isAppName, normalizeAppSchedules, normalizeAppTimezone } from "@nosrv/core";

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

test("normalizes an optional App schedule timezone", () => {
  assert.equal(normalizeAppTimezone(undefined), undefined);
  assert.equal(normalizeAppTimezone(" Asia/Tokyo "), "Asia/Tokyo");
  assert.equal(normalizeAppTimezone("UTC"), "UTC");
  assert.throws(() => normalizeAppTimezone(""), /non-empty IANA time zone/);
  assert.throws(() => normalizeAppTimezone("Not/A_Timezone"), /Invalid IANA time zone/);
  assert.throws(() => normalizeAppTimezone("+09:00"), /Invalid IANA time zone/);
  assert.throws(() => normalizeAppTimezone("JST"), /Invalid IANA time zone/);
  assert.throws(() => normalizeAppTimezone(9), /non-empty IANA time zone/);
});
