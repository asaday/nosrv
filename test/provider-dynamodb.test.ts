import assert from "node:assert/strict";
import test from "node:test";
import { PutItemCommand, ScanCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBKV } from "@nosrv/provider-dynamodb";

test("DynamoDB KV maps expiration and opaque scan cursors", async () => {
  const commands: unknown[] = [];
  const client = {
    async send(command: unknown) {
      commands.push(command);
      if (command instanceof ScanCommand) {
        return {
          Items: [
            { key: { S: "item:a" }, expiresAt: { N: "2000000000" } },
            { key: { S: "expired" }, expiresAt: { N: "1" } },
          ],
          LastEvaluatedKey: { key: { S: "item:a" } },
        };
      }
      return {};
    },
  };
  const kv = new DynamoDBKV("table", client as never);
  await kv.set("item:a", "value", { expiration: 2_000_000_000 });
  assert.equal((commands[0] as PutItemCommand).input.Item?.expiresAt?.N, "2000000000");
  const result = await kv.list({ prefix: "item:", limit: 10 });
  assert.deepEqual(result.keys, [{ key: "item:a", expiresAt: 2_000_000_000 }]);
  assert.equal(result.complete, false);
  assert.equal(typeof result.cursor, "string");
  const scan = commands[1] as ScanCommand;
  assert.equal(scan.input.FilterExpression, "begins_with(#key, :prefix)");
});
