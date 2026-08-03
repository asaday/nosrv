import assert from "node:assert/strict";
import test from "node:test";
import { kvExpiration, kvListLimit } from "@nosrv/core";

test("KV expiration accepts portable relative and absolute deadlines", () => {
  assert.equal(kvExpiration({}, 1_000_000), undefined);
  assert.equal(kvExpiration({ expirationTtl: 60 }, 1_000_000), 1060);
  assert.equal(kvExpiration({ expiration: 1060 }, 1_000_000), 1060);
  assert.throws(() => kvExpiration({ expirationTtl: 59 }, 1_000_000), /at least 60/);
  assert.throws(() => kvExpiration({ expiration: 1059 }, 1_000_000), /at least 60/);
  assert.throws(
    () => kvExpiration({ expiration: 1060, expirationTtl: 60 }, 1_000_000),
    /mutually exclusive/,
  );
});

test("KV list limits are bounded consistently", () => {
  assert.equal(kvListLimit(), 1000);
  assert.equal(kvListLimit({ limit: 1 }), 1);
  assert.throws(() => kvListLimit({ limit: 0 }), /between 1 and 1000/);
  assert.throws(() => kvListLimit({ limit: 1001 }), /between 1 and 1000/);
});
