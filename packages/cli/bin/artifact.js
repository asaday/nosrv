import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, relative, resolve, sep } from "node:path";
import { stringify } from "yaml";
import {
  copyPublicDirectory,
  loadConfig,
  resolveApp,
  resolveEnvironment,
  resolveMeta,
  resolvePermissions,
  resolvePublicConfig,
  resolveResourcesDirectory,
  resolveSchedules,
  resolveTimezone,
  workerName,
  writeStaticApp,
} from "./project.js";

function readOption(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function artifactFiles(directory, base = directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === "manifest.json" && directory === base) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await artifactFiles(path, base)));
    else if (entry.isFile())
      files.push({ path, relative: relative(base, path).split(sep).join("/") });
  }
  return files;
}

async function artifactDigest(directory) {
  const hash = createHash("sha256");
  for (const file of await artifactFiles(directory)) {
    hash.update(file.relative);
    hash.update("\0");
    hash.update(await readFile(file.path));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

export async function embeddedResourcesExpression(directory) {
  if (!directory) return undefined;
  const entries = Object.fromEntries(
    await Promise.all(
      (await artifactFiles(directory, directory)).map(async (file) => [
        file.relative,
        (await readFile(file.path)).toString("base64"),
      ]),
    ),
  );
  return `new MemoryResources(Object.fromEntries(Object.entries(${JSON.stringify(entries)}).map(([path, value]) => [path, Uint8Array.from(atob(value), (character) => character.charCodeAt(0))])))`;
}

const forbiddenArtifactBuiltins = new Set([
  "child_process",
  "cluster",
  "dgram",
  "fs",
  "module",
  "net",
  "sqlite",
  "tls",
  "vm",
  "worker_threads",
]);

function artifactPermissionPlugin(permissions) {
  return {
    name: "nosrv-portable-artifact",
    setup(build) {
      build.onResolve({ filter: /^(?:node:)?[a-z_]+(?:\/.*)?$/ }, (args) => {
        const name = args.path.replace(/^node:/, "").split("/", 1)[0];
        if (!forbiddenArtifactBuiltins.has(name)) return;
        if (
          (name === "fs" &&
            permissions !== "*" &&
            (permissions?.filesystem?.read.length || permissions?.filesystem?.write.length)) ||
          (name === "child_process" && permissions !== "*" && permissions?.childProcess === true)
        )
          return;
        return {
          errors: [
            {
              text: `Node builtin "${args.path}" requires an App permission and is not allowed by this Artifact.`,
            },
          ],
        };
      });
    },
  };
}

export async function buildArtifact(args, options = {}) {
  const cwd = process.cwd();
  const config = await loadConfig(cwd);
  const permissions = resolvePermissions(config.permissions);
  const configuredEnvironment = resolveEnvironment(config.env);
  const meta = resolveMeta(config.meta);
  const route = config.route;
  if (route !== undefined && (typeof route !== "string" || !route.trim())) {
    throw new Error("route must be a non-empty string");
  }
  const schedules = resolveSchedules(config.schedules);
  const timezone = resolveTimezone(config.timezone);
  const publicConfig = resolvePublicConfig(cwd, config.spa === true);
  const resourcesDirectory = resolveResourcesDirectory(cwd);
  const appPath = resolveApp(cwd, config.app, {
    allowStatic: true,
  });
  if (schedules.length && !appPath)
    throw new Error("Static-only applications cannot declare schedules");
  const output = resolve(cwd, readOption(args, "--output") ?? ".nosrv/build");
  const temp = resolve(dirname(output), `.build-${process.pid}-${Date.now()}`);
  await rm(temp, { recursive: true, force: true });
  await mkdir(temp, { recursive: true });

  try {
    if (appPath) {
      const { build } = await import("esbuild");
      await build({
        entryPoints: [appPath],
        outfile: resolve(temp, "app.mjs"),
        bundle: true,
        format: "esm",
        platform: "node",
        target: "node20",
        sourcemap: false,
        legalComments: "none",
        logLevel: "silent",
        nodePaths: (process.env.NODE_PATH ?? "").split(delimiter).filter(Boolean),
        plugins: permissions === "*" ? [] : [artifactPermissionPlugin(permissions)],
      });
    } else {
      await writeStaticApp(resolve(temp, "app.mjs"));
    }
    if (publicConfig) {
      await copyPublicDirectory(publicConfig.directory, resolve(temp, "public"), {
        implicit: publicConfig.implicit,
        excludedPaths: [output, temp],
        excludedTopLevelNames: [basename(output), basename(temp)],
      });
    }
    if (resourcesDirectory) {
      await copyPublicDirectory(resourcesDirectory, resolve(temp, "resources"));
    }
    const artifactConfig = {
      name: workerName(cwd, config),
      app: "./app.mjs",
      ...(route ? { route } : {}),
      ...(meta ? { meta } : {}),
      ...(schedules.length ? { schedules } : {}),
      ...(timezone ? { timezone } : {}),
      ...(publicConfig?.spa ? { spa: true } : {}),
      ...(config.providers?.node ? { providers: { node: config.providers.node } } : {}),
      ...(permissions ? { permissions } : {}),
      ...(configuredEnvironment ? { env: configuredEnvironment } : {}),
    };
    await writeFile(resolve(temp, "nosrv.yaml"), stringify(artifactConfig), "utf8");
    const digest = await artifactDigest(temp);
    /** @type {import("@nosrv/core").ArtifactManifest} */
    const manifest = {
      schemaVersion: 1,
      digest,
    };
    await writeFile(
      resolve(temp, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    await rm(output, { recursive: true, force: true });
    await mkdir(dirname(output), { recursive: true });
    await rename(temp, output);
    if (!options.quiet) {
      console.log(`Built nosrv Artifact`);
      console.log(`Output: ${output}`);
      console.log(`Digest: ${digest}`);
    }
    return { output, digest, manifest };
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
}

export async function runArtifact(args, runDev) {
  const directoryArgument = args[0];
  if (!directoryArgument || directoryArgument.startsWith("-"))
    throw new Error("run requires an artifact directory");
  const directory = resolve(process.cwd(), directoryArgument);
  const manifestPath = resolve(directory, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`Artifact manifest not found: ${manifestPath}`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    manifest.schemaVersion !== 1 ||
    typeof manifest.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(manifest.digest) ||
    Object.keys(manifest).some((name) => name !== "schemaVersion" && name !== "digest")
  ) {
    throw new Error("Unsupported or invalid Artifact manifest");
  }
  if (!existsSync(resolve(directory, "app.mjs"))) {
    throw new Error("Artifact must contain app.mjs and nosrv.yaml");
  }
  const config = await loadConfig(directory);
  if (config.name === undefined || config.app !== "./app.mjs") {
    throw new Error("Artifact configuration must contain a name and use app.mjs");
  }
  workerName(directory, config);
  resolvePermissions(config.permissions);
  resolveEnvironment(config.env);
  resolveSchedules(config.schedules);
  resolveTimezone(config.timezone);
  if (config.route !== undefined && (typeof config.route !== "string" || !config.route.trim())) {
    throw new Error("Artifact route must be a non-empty string");
  }
  const actualDigest = await artifactDigest(directory);
  if (manifest.digest !== actualDigest)
    throw new Error("Artifact digest does not match its contents");
  process.chdir(directory);
  await runDev(args.slice(1), { artifact: true });
}
