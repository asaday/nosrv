/** Internal Artifact container metadata. Runtime App settings belong in nosrv.yaml. */
export interface ArtifactManifest {
  schemaVersion: 1;
  digest: `sha256:${string}`;
}

export interface AppSchedule {
  name: string;
  cron: string;
}

export function isAppName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,62})$/.test(value);
}

const cronMonthNames = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];
const cronWeekdayNames = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function cronValue(value: string, minimum: number, maximum: number, names: string[]): number {
  const named = names.indexOf(value.toUpperCase());
  const parsed = named >= 0 ? minimum + named : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`Cron value is outside ${minimum}-${maximum}: ${value}`);
  }
  return parsed;
}

function validateCronField(
  field: string,
  minimum: number,
  maximum: number,
  names: string[] = [],
): void {
  if (!field) throw new TypeError("Cron field must not be empty");
  for (const item of field.split(",")) {
    if (!item) throw new TypeError("Cron list contains an empty item");
    const parts = item.split("/");
    if (parts.length > 2) throw new TypeError(`Invalid cron step: ${item}`);
    const [range, step] = parts;
    if (step !== undefined) {
      const parsedStep = Number(step);
      if (!Number.isInteger(parsedStep) || parsedStep < 1) {
        throw new TypeError(`Invalid cron step: ${step}`);
      }
    }
    if (range === "*") continue;
    const bounds = range.split("-");
    if (bounds.length > 2) throw new TypeError(`Invalid cron range: ${range}`);
    const start = cronValue(bounds[0], minimum, maximum, names);
    if (bounds.length === 2) {
      const end = cronValue(bounds[1], minimum, maximum, names);
      if (start > end) throw new TypeError(`Cron range is reversed: ${range}`);
    }
  }
}

export function normalizeAppSchedules(value: unknown): AppSchedule[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError("schedules must be an array");
  const names = new Set<string>();
  const expressions = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError(`schedules[${index}] must be an object`);
    }
    const keys = Object.keys(entry);
    const unknown = keys.find((key) => key !== "name" && key !== "cron");
    if (unknown) throw new TypeError(`Unsupported schedules[${index}] key: ${unknown}`);
    const name = Reflect.get(entry, "name");
    const configuredCron = Reflect.get(entry, "cron");
    if (!isAppName(name)) throw new TypeError(`schedules[${index}].name is invalid`);
    if (names.has(name)) throw new TypeError(`Duplicate schedule name: ${name}`);
    names.add(name);
    if (typeof configuredCron !== "string") {
      throw new TypeError(`schedules[${index}].cron must be a five-field cron expression`);
    }
    const cron = configuredCron.trim();
    const fields = cron.split(/\s+/);
    if (fields.length !== 5) {
      throw new TypeError(`schedules[${index}].cron must be a five-field cron expression`);
    }
    const definitions: Array<[number, number, string[]?]> = [
      [0, 59],
      [0, 23],
      [1, 31],
      [1, 12, cronMonthNames],
      [0, 7, cronWeekdayNames],
    ];
    try {
      fields.forEach((field, fieldIndex) => validateCronField(field, ...definitions[fieldIndex]));
    } catch (error) {
      throw new TypeError(
        `Invalid cron expression for ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (expressions.has(cron)) throw new TypeError(`Duplicate cron expression: ${cron}`);
    expressions.add(cron);
    return { name, cron };
  });
}

export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

export interface Secrets {
  get(name: string): Promise<string | null>;
}

export class EnvironmentSecrets implements Secrets {
  private readonly values: Readonly<Record<string, string | undefined>>;

  constructor(values: Readonly<Record<string, string | undefined>>) {
    this.values = values;
  }

  async get(name: string): Promise<string | null> {
    return this.values[name] ?? null;
  }
}

export interface Resources {
  get(path: string): Promise<Blob | null>;
}

export function isResourcePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}

export class MemoryResources implements Resources {
  readonly #entries: ReadonlyMap<string, Blob>;

  constructor(entries: Readonly<Record<string, string | Uint8Array | ArrayBuffer | Blob>> = {}) {
    this.#entries = new Map(
      Object.entries(entries).map(([path, value]) => {
        if (!isResourcePath(path)) throw new Error(`Invalid resource path: ${path}`);
        const part = value instanceof Uint8Array ? Uint8Array.from(value).buffer : value;
        return [path, value instanceof Blob ? value : new Blob([part])];
      }),
    );
  }

  async get(path: string): Promise<Blob | null> {
    return isResourcePath(path) ? (this.#entries.get(path) ?? null) : null;
  }
}

export function publicEnvironment(
  values: Readonly<Record<string, string | undefined>>,
  hiddenNames: readonly string[] = [],
): Readonly<Record<string, string | undefined>> {
  const hidden = new Set(hiddenNames);
  return Object.freeze(
    Object.fromEntries(
      Object.entries(values).filter(([name, value]) => !hidden.has(name) && value !== undefined),
    ),
  );
}

export interface KVGetOptions {
  type?: "text" | "bytes";
}

export interface KVSetOptions {
  expirationTtl?: number;
  expiration?: number;
}

export interface KVListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
}

export interface KVListKey {
  key: string;
  expiresAt?: number;
}

export interface KVListResult {
  keys: KVListKey[];
  complete: boolean;
  cursor?: string;
}

export function kvExpiration(options: KVSetOptions = {}, now = Date.now()): number | undefined {
  if (options.expiration !== undefined && options.expirationTtl !== undefined) {
    throw new TypeError("KV expiration and expirationTtl are mutually exclusive");
  }
  if (options.expirationTtl !== undefined) {
    if (!Number.isInteger(options.expirationTtl) || options.expirationTtl < 60) {
      throw new TypeError("KV expirationTtl must be an integer of at least 60 seconds");
    }
    return Math.floor(now / 1000) + options.expirationTtl;
  }
  if (options.expiration !== undefined) {
    if (!Number.isInteger(options.expiration) || options.expiration < Math.floor(now / 1000) + 60) {
      throw new TypeError("KV expiration must be an integer at least 60 seconds in the future");
    }
    return options.expiration;
  }
  return undefined;
}

export function kvListLimit(options: KVListOptions = {}): number {
  const limit = options.limit ?? 1000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new TypeError("KV list limit must be an integer between 1 and 1000");
  }
  return limit;
}

export interface KV {
  get(key: string, options?: KVGetOptions & { type?: "text" }): Promise<string | null>;
  get(key: string, options: KVGetOptions & { type: "bytes" }): Promise<Uint8Array | null>;
  set(key: string, value: string | Uint8Array, options?: KVSetOptions): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: KVListOptions): Promise<KVListResult>;
}

export type StorageBody = string | Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>;

export interface StorageMetadata {
  key: string;
  size: number;
  etag?: string;
  contentType?: string;
  lastModified?: Date;
  custom?: Readonly<Record<string, string>>;
}

export interface StorageObject {
  body: ReadableStream<Uint8Array>;
  metadata: StorageMetadata;
}

export interface StoragePutOptions {
  contentType?: string;
  customMetadata?: Record<string, string>;
}

export interface StoragePutResult {
  key: string;
  etag?: string;
}

export interface StorageListOptions {
  prefix?: string;
  cursor?: string;
  limit?: number;
}

export interface StorageListResult {
  objects: StorageMetadata[];
  cursor?: string;
  truncated: boolean;
}

export interface ObjectStorage {
  get(key: string): Promise<StorageObject | null>;
  put(key: string, body: StorageBody, options?: StoragePutOptions): Promise<StoragePutResult>;
  delete(key: string): Promise<void>;
  head(key: string): Promise<StorageMetadata | null>;
  list(options?: StorageListOptions): Promise<StorageListResult>;
}

export type SqlValue = string | number | bigint | boolean | null | Uint8Array;
export type DatabaseRow = Record<string, unknown>;

export interface DatabaseQueryResult<T extends DatabaseRow = DatabaseRow> {
  rows: T[];
}

export interface DatabaseExecuteResult {
  rowsAffected: number;
  lastInsertId?: string | number | bigint;
}

export interface DatabaseSql {
  query<T extends DatabaseRow = DatabaseRow>(
    sql: string,
    params?: readonly SqlValue[],
  ): Promise<DatabaseQueryResult<T>>;
  execute(sql: string, params?: readonly SqlValue[]): Promise<DatabaseExecuteResult>;
  transaction?<T>(callback: (sql: DatabaseSql) => Promise<T>): Promise<T>;
}

export type DatabaseColumnType = "text" | "number" | "integer" | "boolean" | "bytes" | "timestamp";

export interface DatabaseReference {
  table: string;
  field: string;
  onDelete?: "cascade" | "restrict" | "set null";
}

export interface DatabaseDefaultExpression {
  expression: "currentTimestamp";
}

export interface DatabaseColumn {
  type: DatabaseColumnType;
  primaryKey?: boolean;
  generated?: "identity";
  required?: boolean;
  default?: SqlValue | DatabaseDefaultExpression;
  references?: DatabaseReference;
}

export type DatabaseTable = Readonly<Record<string, DatabaseColumn>>;
export type DatabaseValues = Readonly<Record<string, SqlValue>>;
export interface DatabaseWhereOperators {
  eq?: SqlValue;
  ne?: SqlValue;
  lt?: SqlValue;
  lte?: SqlValue;
  gt?: SqlValue;
  gte?: SqlValue;
  in?: readonly SqlValue[];
  notIn?: readonly SqlValue[];
}

export type DatabaseWhere = Readonly<
  Record<string, SqlValue | DatabaseWhereOperators | readonly DatabaseWhere[]>
>;

export interface DatabaseSelectOptions {
  fields?: readonly string[];
  where?: DatabaseWhere;
  orderBy?: readonly { field: string; direction?: "asc" | "desc" }[];
  limit?: number;
  offset?: number;
}

export interface DatabaseIndexOptions {
  fields: readonly string[];
  unique?: boolean;
}

export interface DatabaseTableOptions {
  unique?: readonly (readonly string[])[];
}

export interface DatabaseUpsertOptions {
  conflict: readonly string[];
  update: readonly string[];
}

/** Portable CRUD for common relational operations, with raw SQL as an explicit escape hatch. */
export interface Database {
  readonly sql: DatabaseSql;
  currentTimestamp(): Promise<string>;
  ensureTable(name: string, columns: DatabaseTable, options?: DatabaseTableOptions): Promise<void>;
  ensureIndex(name: string, table: string, options: DatabaseIndexOptions): Promise<void>;
  insert(name: string, values: DatabaseValues): Promise<DatabaseExecuteResult>;
  insertMany(name: string, rows: readonly DatabaseValues[]): Promise<DatabaseExecuteResult>;
  upsert(
    name: string,
    values: DatabaseValues,
    options: DatabaseUpsertOptions,
  ): Promise<DatabaseExecuteResult>;
  select<T extends DatabaseRow = DatabaseRow>(
    name: string,
    options?: DatabaseSelectOptions,
  ): Promise<T[]>;
  count(name: string, options?: { where?: DatabaseWhere }): Promise<number>;
  exists(name: string, options?: { where?: DatabaseWhere }): Promise<boolean>;
  update(
    name: string,
    values: DatabaseValues,
    options: { where: DatabaseWhere },
  ): Promise<DatabaseExecuteResult>;
  delete(name: string, options: { where: DatabaseWhere }): Promise<DatabaseExecuteResult>;
  transaction<T>(callback: (db: Database) => Promise<T>): Promise<T>;
}

export interface PlatformInfo {
  readonly name: "node" | "cloudflare" | "lambda" | "google-functions" | (string & {});
}

export interface User {
  id: string;
  email?: string;
  name?: string;
  thumbnail?: string;
}

export interface CapabilityRequirements {
  db?: boolean;
  kv?: boolean;
  storage?: boolean;
}

export interface AppContext {
  env: Readonly<Record<string, string | undefined>>;
  log: Logger;
  platform: PlatformInfo;
  waitUntil(promise: Promise<unknown>): void;
  kv?: KV;
  storage?: ObjectStorage;
  db?: Database;
  secrets: Secrets;
  resources: Resources;
  user: User | null;
}

type RequiredContext<R extends CapabilityRequirements> = Omit<AppContext, "kv" | "storage" | "db"> &
  (R["kv"] extends true ? { kv: KV } : {}) &
  (R["storage"] extends true ? { storage: ObjectStorage } : {}) &
  (R["db"] extends true ? { db: Database } : {});

export type AppContextFor<R extends CapabilityRequirements> = RequiredContext<R>;

export interface ScheduledEvent {
  name: string;
  cron: string;
  scheduledTime: number;
  trigger: "cron" | "manual";
}

export interface AppDefinition<R extends CapabilityRequirements> {
  requires: R;
  initialize?(context: RequiredContext<R>): void | Promise<void>;
  fetch(request: Request, context: RequiredContext<R>): Response | Promise<Response>;
  scheduled?(event: ScheduledEvent, context: RequiredContext<R>): void | Promise<void>;
}

export interface NosrvApp {
  requires?: CapabilityRequirements;
  initialize?(context: AppContext): void | Promise<void>;
  fetch(request: Request, context: AppContext): Response | Promise<Response>;
  scheduled?(event: ScheduledEvent, context: AppContext): void | Promise<void>;
}

export function defineApp<const R extends CapabilityRequirements>(app: AppDefinition<R>): NosrvApp;
export function defineApp(app: Omit<AppDefinition<{}>, "requires">): NosrvApp;
export function defineApp(app: NosrvApp): NosrvApp {
  return app;
}

const appInitializations = new WeakMap<NosrvApp, Promise<void>>();

export async function initializeApp(app: NosrvApp, context: AppContext): Promise<void> {
  if (!app.initialize) return;
  let initialization = appInitializations.get(app);
  if (!initialization) {
    initialization = Promise.resolve().then(() => app.initialize!(context));
    appInitializations.set(app, initialization);
  }
  try {
    await initialization;
  } catch (error) {
    if (appInitializations.get(app) === initialization) appInitializations.delete(app);
    throw error;
  }
}

export function validateCapabilities(app: NosrvApp, context: AppContext): void {
  if (app.requires?.kv && !context.kv) throw new Error("Required capability is unavailable: kv");
  if (app.requires?.storage && !context.storage)
    throw new Error("Required capability is unavailable: storage");
  if (app.requires?.db && !context.db) throw new Error("Required capability is unavailable: db");
}
