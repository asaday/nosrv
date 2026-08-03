import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

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

test("generates a Netlify Functions staging project with static assets", async () => {
  const directory = await fixture();
  try {
    await mkdir(resolve(directory, "public"));
    await writeFile(
      resolve(directory, "public/index.html"),
      "<!doctype html><title>nosrv</title>\n",
      "utf8",
    );
    await exec(process.execPath, [cli, "deploy", "--target", "netlify", "--dry-run"], {
      cwd: directory,
    });
    const output = resolve(directory, ".nosrv/netlify/deploy");
    const functionPath = resolve(output, "functions/nosrv.mjs");
    assert.match(await readFile(functionPath, "utf8"), /createNetlifyHandler/);
    const generated = await import(`${pathToFileURL(functionPath).href}?test=${Date.now()}`);
    const response = await generated.default(
      new Request("https://example.netlify.app/api/check"),
      {},
    );
    assert.deepEqual(await response.json(), { ok: true, resource: "private-resource" });
    assert.match(await readFile(resolve(output, "public/index.html"), "utf8"), /nosrv/);
    const config = await readFile(resolve(output, "netlify.toml"), "utf8");
    assert.match(config, /functions = "functions"/);
    assert.match(config, /\.netlify\/functions\/nosrv/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("generates a handler-free Netlify static deployment", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "nosrv-netlify-static-"));
  try {
    await writeFile(
      resolve(directory, "index.html"),
      "<!doctype html><title>static</title>\n",
      "utf8",
    );
    await exec(process.execPath, [cli, "deploy", "--target", "netlify", "--dry-run"], {
      cwd: directory,
    });
    const output = resolve(directory, ".nosrv/netlify/deploy");
    assert.match(await readFile(resolve(output, "public/index.html"), "utf8"), /static/);
    const config = await readFile(resolve(output, "netlify.toml"), "utf8");
    assert.doesNotMatch(config, /\[\[redirects\]\]/);
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
      exec(process.execPath, [cli, "deploy", "--target", "netlify", "--dry-run"], {
        cwd: directory,
      }),
      /Apps with host permissions can only deploy to nosrv Platform/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
