import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { resolvePostgresPackage } from "../packages/cli/bin/targets/packages.js";

const exec = promisify(execFile);
const cli = resolve("packages/cli/bin/nosrv.js");

async function fixture(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "nosrv-deployment-"));
  await mkdir(resolve(directory, "src"), { recursive: true });
  await mkdir(resolve(directory, "resources"));
  await writeFile(resolve(directory, "nosrv.yaml"), "app: ./src/app.ts\n", "utf8");
  await writeFile(resolve(directory, "resources/private.txt"), "private-resource", "utf8");
  await writeFile(
    resolve(directory, "src/app.ts"),
    'export default { async fetch(_request, ctx) { return Response.json({ ok: true, resource: await (await ctx.resources.get("private.txt"))?.text() }); } };\n',
    "utf8",
  );
  return directory;
}

test("embeds private resources in the Cloudflare Worker bundle input", async () => {
  const directory = await fixture();
  try {
    await exec(process.execPath, [cli, "deploy", "--target", "cloudflare", "--dry-run"], {
      cwd: directory,
    });
    const worker = await readFile(resolve(directory, ".nosrv/cloudflare/worker.ts"), "utf8");
    assert.match(worker, /MemoryResources/);
    assert.match(worker, /cHJpdmF0ZS1yZXNvdXJjZQ==/);
    assert.doesNotMatch(worker, /private-resource/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("generates a self-contained Google Functions staging project", async () => {
  const directory = await fixture();
  try {
    await exec(
      process.execPath,
      [cli, "deploy", "--target", "google-functions", "--region", "asia-northeast1", "--dry-run"],
      { cwd: directory },
    );
    const output = resolve(directory, ".nosrv/google-functions/deploy");
    assert.match(await readFile(resolve(output, "index.js"), "utf8"), /nosrv/);
    assert.equal(
      await readFile(resolve(output, "resources/private.txt"), "utf8"),
      "private-resource",
    );
    const pkg = JSON.parse(await readFile(resolve(output, "package.json"), "utf8"));
    assert.equal(pkg.type, "module");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("generates a Lambda SAM staging project", async () => {
  const directory = await fixture();
  try {
    await exec(process.execPath, [cli, "deploy", "--target", "lambda", "--dry-run"], {
      cwd: directory,
    });
    const output = resolve(directory, ".nosrv/lambda/deploy");
    assert.match(await readFile(resolve(output, "handler.mjs"), "utf8"), /handler/);
    assert.equal(
      await readFile(resolve(output, "resources/private.txt"), "utf8"),
      "private-resource",
    );
    assert.match(
      await readFile(resolve(output, "template.yaml"), "utf8"),
      /AWS::Serverless::Function/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("infers standard cloud providers when provider fields are omitted", async () => {
  const directory = await fixture();
  try {
    await writeFile(
      resolve(directory, "nosrv.yaml"),
      `app: ./src/app.ts
providers:
  cloudflare:
    db: { database: app-db, id: local-db }
    kv: { id: local-kv }
    storage: { bucket: app-r2 }
  google-functions:
    db: { urlEnv: DATABASE_URL, appId: app }
    kv: { collection: app-kv }
    storage: { bucket: app-gcs }
  lambda:
    db: { urlEnv: DATABASE_URL, appId: app }
    kv: { table: app-kv }
    storage: { bucket: app-s3 }
`,
      "utf8",
    );
    await exec(process.execPath, [cli, "deploy", "--target", "cloudflare", "--dry-run"], {
      cwd: directory,
    });
    const wrangler = JSON.parse(
      await readFile(resolve(directory, ".nosrv/cloudflare/wrangler.jsonc"), "utf8"),
    );
    assert.equal(wrangler.d1_databases[0].database_name, "app-db");
    assert.equal(wrangler.kv_namespaces[0].id, "local-kv");
    assert.equal(wrangler.r2_buckets[0].bucket_name, "app-r2");

    await exec(
      process.execPath,
      [cli, "deploy", "--target", "google-functions", "--region", "asia-northeast1", "--dry-run"],
      { cwd: directory },
    );
    const google = await readFile(
      resolve(directory, ".nosrv/google-functions/deploy/index.js"),
      "utf8",
    );
    assert.match(google, /app-kv/);
    assert.match(google, /app-gcs/);

    await exec(process.execPath, [cli, "deploy", "--target", "lambda", "--dry-run"], {
      cwd: directory,
    });
    const lambda = await readFile(resolve(directory, ".nosrv/lambda/deploy/handler.mjs"), "utf8");
    assert.match(lambda, /app-kv/);
    assert.match(lambda, /app-s3/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects an explicitly unsupported cloud provider", async () => {
  const directory = await fixture();
  try {
    await writeFile(
      resolve(directory, "nosrv.yaml"),
      "app: ./src/app.ts\nproviders:\n  cloudflare:\n    kv:\n      provider: redis\n",
      "utf8",
    );
    await assert.rejects(
      exec(process.execPath, [cli, "deploy", "--target", "cloudflare", "--dry-run"], {
        cwd: directory,
      }),
      /Unsupported Cloudflare KV provider: redis/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("generates an Azure Functions staging project with assets and timers", async () => {
  const directory = await fixture();
  try {
    await mkdir(resolve(directory, "public"));
    await writeFile(
      resolve(directory, "public/index.html"),
      "<!doctype html><title>nosrv</title>\n",
      "utf8",
    );
    await writeFile(
      resolve(directory, "nosrv.yaml"),
      "app: ./src/app.ts\nschedules:\n  - name: cleanup\n    cron: '*/5 * * * *'\n",
      "utf8",
    );
    await exec(process.execPath, [cli, "deploy", "--target", "azure", "--dry-run"], {
      cwd: directory,
    });
    const output = resolve(directory, ".nosrv/azure/deploy");
    const entry = await readFile(resolve(output, "index.mjs"), "utf8");
    assert.match(entry, /createAzureHttpHandler/);
    assert.match(entry, /createAzureTimerHandler/);
    assert.match(entry, /0 \*\/5 \* \* \* \*/);
    assert.match(await readFile(resolve(output, "public/index.html"), "utf8"), /nosrv/);
    assert.match(await readFile(resolve(output, "host.json"), "utf8"), /routePrefix/);
    const pkg = JSON.parse(await readFile(resolve(output, "package.json"), "utf8"));
    assert.equal(pkg.dependencies["@azure/functions"], "^4.7.0");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("generates a handler-free Azure static deployment", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "nosrv-azure-static-"));
  try {
    await writeFile(
      resolve(directory, "index.html"),
      "<!doctype html><title>static</title>\n",
      "utf8",
    );
    await exec(process.execPath, [cli, "deploy", "--target", "azure", "--dry-run"], {
      cwd: directory,
    });
    const output = resolve(directory, ".nosrv/azure/deploy");
    assert.match(await readFile(resolve(output, "public/index.html"), "utf8"), /static/);
    assert.match(await readFile(resolve(output, "index.mjs"), "utf8"), /Not found/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects Apps with host permissions for public-cloud deployment targets", async () => {
  const directory = await fixture();
  try {
    await writeFile(
      resolve(directory, "nosrv.yaml"),
      'app: ./src/app.ts\npermissions: "*"\n',
      "utf8",
    );
    await assert.rejects(
      exec(process.execPath, [cli, "deploy", "--target", "azure", "--dry-run"], {
        cwd: directory,
      }),
      /Apps with host permissions can only deploy to nosrv Platform/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports missing cloud integration packages with install guidance", async () => {
  const directory = await fixture();
  const cases = [
    {
      target: "cloudflare",
      packageName: "@nosrv/cloudflare",
      args: ["deploy", "--target", "cloudflare", "--dry-run"],
    },
    {
      target: "google-functions",
      packageName: "@nosrv/google-cloud",
      args: ["deploy", "--target", "google-functions", "--region", "asia-northeast1", "--dry-run"],
    },
    {
      target: "lambda",
      packageName: "@nosrv/aws",
      args: ["deploy", "--target", "lambda", "--dry-run"],
    },
    {
      target: "azure",
      packageName: "@nosrv/azure",
      args: ["deploy", "--target", "azure", "--dry-run"],
    },
  ];
  try {
    for (const item of cases) {
      await assert.rejects(
        exec(process.execPath, [cli, ...item.args], {
          cwd: directory,
          env: { ...process.env, NOSRV_DISABLE_CHECKOUT_FALLBACK: "1" },
        }),
        new RegExp(
          `Install it in the application with:[\\s\\S]*npm install -D ${item.packageName.replace("/", "\\/")}`,
        ),
        `expected install guidance for ${item.target}`,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports missing PostgreSQL provider guidance", async () => {
  const directory = await fixture();
  const original = process.env.NOSRV_DISABLE_CHECKOUT_FALLBACK;
  process.env.NOSRV_DISABLE_CHECKOUT_FALLBACK = "1";
  try {
    assert.throws(
      () => resolvePostgresPackage(directory, "Google Functions"),
      /npm install -D @nosrv\/postgres/,
    );
  } finally {
    if (original === undefined) delete process.env.NOSRV_DISABLE_CHECKOUT_FALLBACK;
    else process.env.NOSRV_DISABLE_CHECKOUT_FALLBACK = original;
    await rm(directory, { recursive: true, force: true });
  }
});
