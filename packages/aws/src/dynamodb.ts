import {
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  ScanCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import {
  kvExpiration,
  kvListLimit,
  type KV,
  type KVGetOptions,
  type KVListOptions,
  type KVListResult,
  type KVSetOptions,
} from "@nosrv/core";

function encodeCursor(key: Record<string, AttributeValue>): string {
  return Buffer.from(JSON.stringify(key)).toString("base64url");
}

function decodeCursor(cursor: string): Record<string, AttributeValue> {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new TypeError("Invalid DynamoDB KV cursor");
  }
}

export class DynamoDBKV implements KV {
  private readonly table: string;
  private readonly client: DynamoDBClient;

  constructor(table: string, client: DynamoDBClient = new DynamoDBClient({})) {
    this.table = table;
    this.client = client;
  }

  async get(key: string, options?: KVGetOptions & { type?: "text" }): Promise<string | null>;
  async get(key: string, options: KVGetOptions & { type: "bytes" }): Promise<Uint8Array | null>;
  async get(key: string, options?: KVGetOptions): Promise<string | Uint8Array | null> {
    const result = await this.client.send(
      new GetItemCommand({
        TableName: this.table,
        Key: { key: { S: key } },
        ConsistentRead: true,
      }),
    );
    const expiresAt = result.Item?.expiresAt?.N ? Number(result.Item.expiresAt.N) : undefined;
    if (expiresAt !== undefined && expiresAt <= Math.floor(Date.now() / 1000)) return null;
    const value = result.Item?.value?.B;
    if (!value) return null;
    const bytes = Uint8Array.from(value);
    return options?.type === "bytes" ? bytes : new TextDecoder().decode(bytes);
  }

  async set(key: string, value: string | Uint8Array, options?: KVSetOptions): Promise<void> {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
    const expiration = kvExpiration(options);
    await this.client.send(
      new PutItemCommand({
        TableName: this.table,
        Item: {
          key: { S: key },
          value: { B: bytes },
          ...(expiration === undefined ? {} : { expiresAt: { N: String(expiration) } }),
        },
      }),
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteItemCommand({ TableName: this.table, Key: { key: { S: key } } }),
    );
  }

  async list(options: KVListOptions = {}): Promise<KVListResult> {
    const result = await this.client.send(
      new ScanCommand({
        TableName: this.table,
        Limit: kvListLimit(options),
        ProjectionExpression: "#key, expiresAt",
        ExpressionAttributeNames: { "#key": "key" },
        ...(options.prefix === undefined
          ? {}
          : {
              FilterExpression: "begins_with(#key, :prefix)",
              ExpressionAttributeValues: { ":prefix": { S: options.prefix } },
            }),
        ...(options.cursor === undefined
          ? {}
          : { ExclusiveStartKey: decodeCursor(options.cursor) }),
      }),
    );
    const now = Math.floor(Date.now() / 1000);
    const keys = (result.Items ?? []).flatMap((item) => {
      const key = item.key?.S;
      const expiresAt = item.expiresAt?.N ? Number(item.expiresAt.N) : undefined;
      return !key || (expiresAt !== undefined && expiresAt <= now)
        ? []
        : [{ key, ...(expiresAt === undefined ? {} : { expiresAt }) }];
    });
    const complete = result.LastEvaluatedKey === undefined;
    return {
      keys,
      complete,
      ...(!complete ? { cursor: encodeCursor(result.LastEvaluatedKey!) } : {}),
    };
  }
}
