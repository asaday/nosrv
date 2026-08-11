import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import * as tar from "tar";
import { loadConfig, projectName, workerName } from "./project.js";

function readOption(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

const forbiddenPlatformHeaders = new Set(["authorization", "host", "content-length"]);

function resolvePlatformHeaderValue(value) {
  if (value.startsWith("$$")) return value.slice(1);
  const reference =
    value.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/)?.[1] ??
    value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/)?.[1];
  if (!reference) return value;
  const resolved = process.env[reference];
  if (!resolved) throw new Error(`Platform header environment variable is not set: ${reference}`);
  return resolved;
}

function readPlatformHeaderDefinitions(args) {
  const definitions = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--header" && args[index] !== "-H") continue;
    const field = args[index + 1];
    if (field === undefined) throw new Error(`${args[index]} requires a header in name:value form`);
    const separator = field.indexOf(":");
    const name = separator === -1 ? "" : field.slice(0, separator).trim();
    if (!name) throw new Error(`${args[index]} requires a header in name:value form`);
    if (forbiddenPlatformHeaders.has(name.toLowerCase())) {
      throw new Error(`Platform header cannot override ${name}`);
    }
    const value = field.slice(separator + 1).trimStart();
    const resolvedValue = resolvePlatformHeaderValue(value);
    try {
      new Headers({ [name]: resolvedValue });
    } catch {
      throw new Error(`Invalid Platform header name or value: ${name}`);
    }
    definitions.push(`${name}: ${value}`);
    index += 1;
  }
  return definitions;
}

function resolvePlatformHeaders(...definitionGroups) {
  const headers = new Headers();
  for (const definitions of definitionGroups) {
    for (const field of definitions ?? []) {
      const separator = field.indexOf(":");
      const name = separator === -1 ? "" : field.slice(0, separator).trim();
      if (!name || forbiddenPlatformHeaders.has(name.toLowerCase())) {
        throw new Error(`Invalid saved Platform header: ${field}`);
      }
      const value = resolvePlatformHeaderValue(field.slice(separator + 1).trimStart());
      try {
        headers.set(name, value);
      } catch {
        throw new Error(`Invalid Platform header name or value: ${name}`);
      }
    }
  }
  return headers;
}

function withoutPlatformHeaders(args) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--header" || args[index] === "-H") {
      index += 1;
      continue;
    }
    result.push(args[index]);
  }
  return result;
}

function platformHeaders(customHeaders, requiredHeaders = {}) {
  const headers = new Headers(customHeaders);
  const definedRequiredHeaders = Object.fromEntries(
    Object.entries(requiredHeaders).filter(([, value]) => value !== undefined),
  );
  for (const [name, value] of new Headers(definedRequiredHeaders)) {
    headers.set(name, value);
  }
  return headers;
}

export async function deployPlatform(cwd, config, args, buildArtifact) {
  const explicitHeaderDefinitions = readPlatformHeaderDefinitions(args);
  const { url: platform } = await platformUrl(config, args);
  const url = new URL("/_platform/deployments/upload", platform);
  const configuredToken = readOption(args, "--token") ?? process.env.NOSRV_TOKEN;
  let savedToken = configuredToken ? undefined : await storedPlatformToken(platform);
  let headerDefinitions = await platformHeaderDefinitions(platform, explicitHeaderDefinitions);
  let customHeaders = resolvePlatformHeaders(headerDefinitions);
  if (!configuredToken && !savedToken) {
    console.log(`No saved Platform login for ${url.origin}. Starting login...`);
    await platformLogin(["--url", url.origin], headerDefinitions);
    savedToken = await storedPlatformToken(url);
  }
  let token = configuredToken ?? savedToken;
  if (!token) {
    throw new Error("Platform login completed without saving a personal token");
  }
  const name = workerName(cwd, config);
  const temporary = await mkdtemp(resolve(tmpdir(), "nosrv-deploy-"));
  try {
    const artifactDirectory = resolve(temporary, "artifact");
    const archivePath = resolve(temporary, "artifact.tar.gz");
    const artifact = await buildArtifact(["--output", artifactDirectory], { quiet: true });
    await tar.create(
      { cwd: artifactDirectory, file: archivePath, gzip: true, portable: true, noMtime: true },
      ["."],
    );
    console.log(`Destination: ${url.origin}`);
    console.log(`Authentication: ${savedToken ? "saved personal token" : "provided token"}`);
    console.log(`App: ${name}`);
    console.log(`Digest: ${artifact.digest}`);
    console.log("Uploading Artifact...");
    const upload = () =>
      fetch(url, {
        method: "POST",
        headers: platformHeaders(customHeaders, {
          authorization: `Bearer ${token}`,
          "content-type": "application/gzip",
          "x-nosrv-digest": artifact.digest,
        }),
        body: createReadStream(archivePath),
        duplex: "half",
      });
    let response = await upload();
    if (response.status === 401 && !configuredToken) {
      await response.body?.cancel();
      console.log(`Saved Platform login was rejected. Starting login again...`);
      await deletePlatformToken(url);
      await platformLogin(["--url", url.origin], headerDefinitions);
      savedToken = await storedPlatformToken(url);
      if (!savedToken) throw new Error("Platform login completed without saving a personal token");
      token = savedToken;
      headerDefinitions = await platformHeaderDefinitions(url, explicitHeaderDefinitions);
      customHeaders = resolvePlatformHeaders(headerDefinitions);
      console.log("Retrying Artifact upload...");
      response = await upload();
    }
    const body = await response.text();
    if (response.status === 401) {
      throw platformAuthenticationError(configuredToken ? "explicit" : "saved", "npx nosrv deploy");
    }
    if (!response.ok) throw new Error(`Platform deployment failed (${response.status}): ${body}`);
    const result = JSON.parse(body);
    console.log(`Deployed: ${result.app.name}`);
    console.log(`Version: ${result.version.digest}`);
    console.log(`Route: ${new URL(result.app.routePrefix, url.origin)}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function platformAuthenticationError(tokenSource, command = "nosrv list") {
  const reason =
    tokenSource === "explicit"
      ? "The provided token was rejected."
      : tokenSource === "saved"
        ? "The saved Platform login was rejected. Sign in again."
        : "This Platform requires an authorized user.";
  return new Error(
    `Platform authentication failed (401). ${reason}\n` +
      `Sign in and retry:\n  nosrv login --url <platform-url>\n  ${command}\n` +
      `For CI, provide a personal token through NOSRV_TOKEN.`,
  );
}

function credentialPath() {
  return process.env.NOSRV_CREDENTIALS_FILE ?? resolve(homedir(), ".config/nosrv/credentials.json");
}

async function readCredentials() {
  try {
    const value = JSON.parse(await readFile(credentialPath(), "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

async function storedPlatform() {
  const credentials = await readCredentials();
  return credentials.platform && typeof credentials.platform === "object"
    ? credentials.platform
    : undefined;
}

async function storedPlatformToken(url) {
  const platform = await storedPlatform();
  return platform?.url === url.origin && typeof platform.token === "string"
    ? platform.token
    : undefined;
}

async function storedPlatformUrl() {
  const platform = await storedPlatform();
  return typeof platform?.url === "string" ? platform.url : undefined;
}

async function platformHeaderDefinitions(url, explicitDefinitions = []) {
  const platform = await storedPlatform();
  const savedDefinitions =
    platform?.url === url.origin && Array.isArray(platform.headers) ? platform.headers : [];
  const byName = new Map();
  for (const field of [...savedDefinitions, ...explicitDefinitions]) {
    const separator = field.indexOf(":");
    const name = separator === -1 ? "" : field.slice(0, separator).trim().toLowerCase();
    if (name) byName.set(name, field);
  }
  return [...byName.values()];
}

async function savePlatformToken(url, token, expiresAt, headers = []) {
  const path = credentialPath();
  const credentials = {
    platform: { url: url.origin, token, expiresAt, ...(headers.length ? { headers } : {}) },
  };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
}

async function deletePlatformToken(url) {
  const path = credentialPath();
  const credentials = await readCredentials();
  const platform = await storedPlatform();
  if (platform?.url === url.origin) {
    delete credentials.platform;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
}

async function platformUrl(config, args) {
  const configuredBaseUrl = readOption(args, "--url") ?? process.env.NOSRV_PLATFORM_URL;
  const baseUrl = configuredBaseUrl ?? (await storedPlatformUrl()) ?? "http://127.0.0.1:3100";
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("Platform URL must use http or https");
  return { url };
}

async function platformConnection(config, args) {
  const { url } = await platformUrl(config, args);
  const configuredToken = readOption(args, "--token") ?? process.env.NOSRV_TOKEN;
  const savedToken = configuredToken ? undefined : await storedPlatformToken(url);
  const token = configuredToken ?? savedToken;
  if (!token)
    throw new Error(
      'Platform management requires "nosrv login --url <platform-url>" or NOSRV_TOKEN',
    );
  return {
    url,
    token,
    defaultName: config.name,
    tokenSource: configuredToken ? "explicit" : "saved",
    headers: resolvePlatformHeaders(
      await platformHeaderDefinitions(url, readPlatformHeaderDefinitions(args)),
    ),
  };
}

async function platformRequest(connection, path, init = {}) {
  const url = new URL(path, connection.url);
  const headers = platformHeaders(connection.headers, init.headers);
  if (connection.token) headers.set("authorization", `Bearer ${connection.token}`);
  const response = await fetch(url, { ...init, headers });
  const text = await response.text();
  if (response.status === 401) {
    throw platformAuthenticationError(connection.tokenSource);
  }
  if (!response.ok) throw new Error(`Platform request failed (${response.status}): ${text}`);
  return text ? JSON.parse(text) : undefined;
}

async function studioConnection(config, args) {
  const { url } = await platformUrl(config, args);
  const configuredToken = readOption(args, "--token") ?? process.env.NOSRV_TOKEN;
  const savedToken = configuredToken ? undefined : await storedPlatformToken(url);
  const headers = resolvePlatformHeaders(
    await platformHeaderDefinitions(url, readPlatformHeaderDefinitions(args)),
  );
  const token = configuredToken ?? savedToken;
  if (!token) {
    const response = await fetch(new URL("/_platform/auth/config", url), {
      headers: platformHeaders(headers),
    });
    const auth = response.ok ? await response.json() : undefined;
    if (auth?.mode !== "none") {
      throw new Error('Studio import requires "nosrv login --url <platform-url>" or NOSRV_TOKEN');
    }
  }
  return {
    url,
    token,
    tokenSource: configuredToken ? "explicit" : savedToken ? "saved" : undefined,
    headers,
  };
}

export async function studioImport(args, usage) {
  const directoryArgument = args[0];
  if (!directoryArgument || directoryArgument.startsWith("-")) {
    throw new Error(`studio import requires a directory\n\n${usage}`);
  }
  const mode = readOption(args, "--mode") ?? "copy";
  if (mode !== "copy" && mode !== "link") throw new Error("--mode must be copy or link");
  const source = await realpath(resolve(process.cwd(), directoryArgument));
  if (!(await stat(source)).isDirectory()) throw new Error("Import source must be a directory");
  const name = readOption(args, "--name") ?? projectName(source);
  const connection = await studioConnection(await loadConfig(process.cwd()), args);
  const result = await platformRequest(connection, "/_platform/studio/api/projects/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, path: source, mode }),
  });
  console.log(`Imported: ${result.project.name}`);
  console.log(`Mode: ${mode}`);
  console.log(`Source: ${source}`);
  console.log(`Studio: ${new URL(`/_platform/studio/apps/${result.project.id}/`, connection.url)}`);
}

function writePlatformResult(value, json) {
  if (json) console.log(JSON.stringify(value, null, 2));
}

async function findPlatformApp(connection, reference) {
  const resolvedReference = reference ?? connection.defaultName;
  if (
    typeof resolvedReference !== "string" ||
    !resolvedReference ||
    resolvedReference.startsWith("-")
  ) {
    throw new Error("Platform command requires an App name or ID, or top-level name");
  }
  const listed = await platformRequest(connection, "/_platform/apps");
  const app = listed.apps.find(
    (candidate) => candidate.id === resolvedReference || candidate.name === resolvedReference,
  );
  if (!app) throw new Error(`Platform App not found: ${resolvedReference}`);
  return app;
}

function printPlatformApp(app, origin) {
  console.log(`Name: ${app.name}`);
  console.log(`ID: ${app.id}`);
  console.log(`Status: ${app.status}`);
  console.log(`Type: ${app.activeVersionId ? "deployed" : "linked"}`);
  console.log(`Route: ${new URL(`${app.routePrefix}/`, origin)}`);
  if (app.meta?.description) console.log(`Description: ${app.meta.description}`);
  if (app.activeDigest) console.log(`Version: ${app.activeDigest}`);
  if (app.sourcePath) console.log(`Source: ${app.sourcePath}`);
  if (app.runtime?.startedAt) console.log(`Started: ${app.runtime.startedAt}`);
  if (app.configuration) {
    console.log(`Permissions: ${JSON.stringify(app.configuration.permissions ?? "portable")}`);
    console.log(`Public assets: ${app.configuration.public ? "yes" : "no"}`);
    console.log(`Private resources: ${app.configuration.resources ? "yes" : "no"}`);
    if (app.configuration.schedules.length) {
      console.log(`Timezone: ${app.configuration.timezone ?? "runtime local"}`);
      console.log("Schedules:");
      for (const schedule of app.configuration.schedules) {
        console.log(`  ${schedule.name}: ${schedule.cron}`);
      }
    } else console.log("Schedules: none");
  }
  if (app.secrets) {
    console.log(
      `Secrets: ${app.secrets.length ? app.secrets.map((secret) => secret.name).join(", ") : "none"}`,
    );
  }
  if (app.versionCount !== undefined) console.log(`Versions: ${app.versionCount}`);
}

async function readSecretFromStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > 64 * 1024) throw new Error("Secret input exceeds 64 KiB");
    chunks.push(value);
  }
  return Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
}

async function readHiddenSecret(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    throw new Error("Secret input requires an interactive terminal or --stdin");
  }
  process.stdout.write(prompt);
  process.stdin.setEncoding("utf8");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let value = "";
  try {
    return await new Promise((resolveValue, reject) => {
      const onData = (data) => {
        for (const character of data) {
          if (character === "\u0003") {
            cleanup();
            reject(new Error("Secret input cancelled"));
            return;
          }
          if (character === "\r" || character === "\n") {
            cleanup();
            resolveValue(value);
            return;
          }
          if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
          else value += character;
        }
      };
      const cleanup = () => process.stdin.removeListener("data", onData);
      process.stdin.on("data", onData);
    });
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write("\n");
  }
}

function openBrowser(url) {
  if (process.env.NOSRV_NO_BROWSER === "true") return false;
  const command =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  const child = spawn(command[0], command[1], { detached: true, stdio: "ignore" });
  child.once("error", () => {});
  child.unref();
  return true;
}

export async function platformLogin(args, providedHeaderDefinitions) {
  const config = await loadConfig(process.cwd());
  const { url } = await platformUrl(config, args);
  const headerDefinitions =
    providedHeaderDefinitions ??
    (await platformHeaderDefinitions(url, readPlatformHeaderDefinitions(args)));
  const customHeaders = resolvePlatformHeaders(headerDefinitions);
  const response = await fetch(new URL("/_platform/auth/cli/device", url), {
    method: "POST",
    headers: customHeaders,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Platform login failed (${response.status}): ${text}`);
  const authorization = JSON.parse(text);
  console.log(`Code: ${authorization.userCode}`);
  console.log(`Open: ${authorization.verificationUri}`);
  openBrowser(authorization.verificationUri);
  const deadline = Date.now() + Number(authorization.expiresIn) * 1_000;
  const interval = Math.max(1, Number(authorization.interval) || 2) * 1_000;
  while (Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, interval));
    const tokenResponse = await fetch(new URL("/_platform/auth/cli/token", url), {
      method: "POST",
      headers: platformHeaders(customHeaders, { "content-type": "application/json" }),
      body: JSON.stringify({ deviceCode: authorization.deviceCode }),
    });
    const tokenText = await tokenResponse.text();
    if (!tokenResponse.ok)
      throw new Error(`Platform login failed (${tokenResponse.status}): ${tokenText}`);
    const result = JSON.parse(tokenText);
    if (result.status === "pending") continue;
    if (result.status !== "complete" || typeof result.token !== "string") {
      throw new Error("Platform returned an invalid CLI token response");
    }
    await savePlatformToken(url, result.token, result.expiresAt, headerDefinitions);
    console.log(`Logged in to ${url.origin}`);
    return;
  }
  throw new Error("Platform login expired");
}

export async function platformWhoami(args) {
  const config = await loadConfig(process.cwd());
  const connection = await platformConnection(config, args);
  const result = await platformRequest(connection, "/_platform/auth/session");
  if (!result.authenticated || !result.user) throw new Error("Not logged in with a user token");
  console.log(
    `${result.user.email ?? result.user.name ?? result.user.id} (${result.role ?? "user"})`,
  );
}

export async function platformLogout(args) {
  const config = await loadConfig(process.cwd());
  const { url } = await platformUrl(config, args);
  const customHeaders = resolvePlatformHeaders(
    await platformHeaderDefinitions(url, readPlatformHeaderDefinitions(args)),
  );
  const token = await storedPlatformToken(url);
  if (token) {
    await fetch(new URL("/_platform/auth/cli/token", url), {
      method: "DELETE",
      headers: platformHeaders(customHeaders, { authorization: `Bearer ${token}` }),
    }).catch(() => undefined);
  }
  await deletePlatformToken(url);
  console.log(`Logged out from ${url.origin}`);
}

export async function platformCommand(args, usage) {
  const operation = args[0];
  const rawOperationArgs = args.slice(1);
  const operationArgs = withoutPlatformHeaders(rawOperationArgs);
  const cwd = process.cwd();
  const config = await loadConfig(cwd);
  const connection = await platformConnection(config, rawOperationArgs);
  const jsonOutput = operationArgs.includes("--json");

  if (operation === "tools") {
    const action = operationArgs.find((argument) => !argument.startsWith("-"));
    if (action !== "list") throw new Error(`tools requires list\n\n${usage}`);
    const catalog = await platformRequest(connection, "/_platform/tools", {
      signal: AbortSignal.timeout(30_000),
    }).catch((error) => {
      if (error?.name === "TimeoutError") {
        throw new Error("Platform tool catalog request timed out after 30 seconds");
      }
      throw error;
    });
    if (jsonOutput) {
      writePlatformResult(catalog, true);
      return;
    }
    if (!catalog.tools.length) {
      console.log("No Platform tools.");
      return;
    }
    for (const group of catalog.tools) {
      console.log(`${group.name}${group.available ? "" : " (unavailable)"}`);
      for (const tool of group.tools) {
        console.log(`  ${tool.name}${tool.description ? ` - ${tool.description}` : ""}`);
      }
    }
    return;
  }

  if (operation === "link") {
    const path = operationArgs[0];
    if (!path || path.startsWith("-"))
      throw new Error("platform link requires a Platform-visible path");
    const result = await platformRequest(connection, "/_platform/apps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (jsonOutput) {
      writePlatformResult(result.app, true);
      return;
    }
    console.log(`Linked: ${result.app.name}`);
    console.log(`Path: ${result.app.sourcePath}`);
    console.log(`Route: ${new URL(result.app.routePrefix, connection.url.origin)}`);
    return;
  }

  if (operation === "list") {
    const listed = await platformRequest(connection, "/_platform/apps");
    if (jsonOutput) {
      writePlatformResult(listed.apps, true);
      return;
    }
    if (!listed.apps.length) {
      console.log("No Apps.");
      return;
    }
    console.log("NAME\tID\tSTATUS\tTYPE\tROUTE");
    for (const app of listed.apps) {
      console.log(
        `${app.name}\t${app.id}\t${app.status}\t${app.activeVersionId ? "deployed" : "linked"}\t${app.routePrefix}`,
      );
    }
    return;
  }

  if (operation === "info") {
    const app = await findPlatformApp(connection, operationArgs[0]);
    const result = await platformRequest(
      connection,
      `/_platform/apps/${encodeURIComponent(app.id)}/info`,
    );
    if (jsonOutput) writePlatformResult(result.app, true);
    else printPlatformApp(result.app, connection.url.origin);
    return;
  }

  if (["start", "stop", "restart"].includes(operation)) {
    const app = await findPlatformApp(connection, operationArgs[0]);
    const result = await platformRequest(
      connection,
      `/_platform/apps/${encodeURIComponent(app.id)}/${operation}`,
      { method: "POST" },
    );
    if (jsonOutput) {
      writePlatformResult(result.app, true);
      return;
    }
    const completed = { start: "Started", stop: "Stopped", restart: "Restarted" }[operation];
    console.log(`${completed}: ${result.app.name}`);
    console.log(`Route: ${new URL(result.app.routePrefix, connection.url.origin)}`);
    return;
  }

  if (operation === "logs") {
    const app = await findPlatformApp(connection, operationArgs[0]);
    const result = await platformRequest(
      connection,
      `/_platform/apps/${encodeURIComponent(app.id)}/logs`,
    );
    if (jsonOutput) writePlatformResult(result, true);
    else if (result.logs.length) console.log(result.logs.join("\n"));
    else console.log("No logs.");
    return;
  }

  if (operation === "versions") {
    const app = await findPlatformApp(connection, operationArgs[0]);
    const result = await platformRequest(
      connection,
      `/_platform/apps/${encodeURIComponent(app.id)}/versions`,
    );
    if (jsonOutput) {
      writePlatformResult(result.versions, true);
      return;
    }
    if (!result.versions.length) {
      console.log("No versions (Linked Apps do not have version history).");
      return;
    }
    console.log("DIGEST\tCREATED\tACTIVE");
    for (const version of result.versions) {
      console.log(
        `${version.digest}\t${version.createdAt}\t${version.id === app.activeVersionId ? "yes" : ""}`,
      );
    }
    return;
  }

  if (operation === "activate") {
    const app = await findPlatformApp(connection, operationArgs[0]);
    const versionId = operationArgs[1];
    if (!versionId || versionId.startsWith("-"))
      throw new Error("platform activate requires an App name or ID and a version ID");
    const result = await platformRequest(
      connection,
      `/_platform/apps/${encodeURIComponent(app.id)}/versions/${encodeURIComponent(versionId)}/activate`,
      { method: "POST" },
    );
    if (jsonOutput) writePlatformResult(result.app, true);
    else {
      console.log(`Activated: ${result.app.name}`);
      console.log(`Version: ${result.app.activeDigest}`);
    }
    return;
  }

  if (operation === "secrets") {
    const action = operationArgs[0];
    if (!action || action.startsWith("-")) {
      throw new Error("platform secrets requires list, set, or delete");
    }
    const explicitApp = operationArgs[2] && !operationArgs[2].startsWith("-");
    const appReference =
      action === "list"
        ? operationArgs[1]?.startsWith("-")
          ? undefined
          : operationArgs[1]
        : explicitApp
          ? operationArgs[1]
          : undefined;
    const app = await findPlatformApp(connection, appReference);
    const path = `/_platform/apps/${encodeURIComponent(app.id)}/secrets`;
    if (action === "list") {
      const result = await platformRequest(connection, path);
      if (jsonOutput) writePlatformResult(result.secrets, true);
      else if (!result.secrets.length) console.log("No secrets.");
      else {
        console.log("NAME\tUPDATED");
        for (const secret of result.secrets) console.log(`${secret.name}\t${secret.updatedAt}`);
      }
      return;
    }
    const name = explicitApp ? operationArgs[2] : operationArgs[1];
    if (!name || name.startsWith("-")) {
      throw new Error(`platform secrets ${action} requires an App name or ID and secret name`);
    }
    const secretPath = `${path}/${encodeURIComponent(name)}`;
    if (action === "set") {
      const value = operationArgs.includes("--stdin")
        ? await readSecretFromStdin()
        : await readHiddenSecret(`Value for ${name}: `);
      if (!value) throw new Error("Secret value must not be empty");
      const result = await platformRequest(connection, secretPath, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value }),
      });
      const secret = result.secrets.find((candidate) => candidate.name === name);
      if (jsonOutput) writePlatformResult({ app: { id: app.id, name: app.name }, secret }, true);
      else console.log(`Set: ${app.name} ${name}`);
      return;
    }
    if (action === "delete") {
      if (!operationArgs.includes("--yes")) {
        throw new Error(`Refusing to delete ${app.name} ${name} without --yes`);
      }
      await platformRequest(connection, secretPath, { method: "DELETE" });
      if (jsonOutput) {
        writePlatformResult(
          { deleted: true, app: { id: app.id, name: app.name }, secret: { name } },
          true,
        );
      } else console.log(`Deleted: ${app.name} ${name}`);
      return;
    }
    throw new Error(`Unknown secrets command: ${action}`);
  }

  if (operation === "shared") {
    const kind = operationArgs[0];
    const action = operationArgs[1];
    if (!["env", "secrets"].includes(kind) || !["list", "set", "delete"].includes(action)) {
      throw new Error("platform shared requires env|secrets and list|set|delete");
    }
    const resource = kind === "env" ? "environment" : "secrets";
    if (action === "list") {
      const result = await platformRequest(connection, "/_platform/shared");
      const values = result[resource];
      if (jsonOutput) writePlatformResult(values, true);
      else if (!values.length) console.log(`No shared ${kind}.`);
      else {
        console.log(kind === "env" ? "NAME\tVALUE\tUPDATED" : "NAME\tUPDATED");
        for (const value of values) {
          console.log(
            kind === "env"
              ? `${value.name}\t${value.value}\t${value.updatedAt}`
              : `${value.name}\t${value.updatedAt}`,
          );
        }
      }
      return;
    }
    const name = operationArgs[2];
    if (!name || name.startsWith("-"))
      throw new Error(`platform shared ${kind} ${action} requires a name`);
    const path = `/_platform/shared/${resource}/${encodeURIComponent(name)}`;
    if (action === "set") {
      const value = operationArgs.includes("--stdin")
        ? await readSecretFromStdin()
        : await readHiddenSecret(`Value for ${name}: `);
      if (kind === "secrets" && !value) throw new Error("Secret value must not be empty");
      await platformRequest(connection, path, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value }),
      });
      if (jsonOutput) writePlatformResult({ set: true, kind, name }, true);
      else console.log(`Set shared ${kind}: ${name}`);
      return;
    }
    if (!operationArgs.includes("--yes")) {
      throw new Error(`Refusing to delete shared ${kind} ${name} without --yes`);
    }
    await platformRequest(connection, path, { method: "DELETE" });
    if (jsonOutput) writePlatformResult({ deleted: true, kind, name }, true);
    else console.log(`Deleted shared ${kind}: ${name}`);
    return;
  }

  if (operation === "delete") {
    const app = await findPlatformApp(connection, operationArgs[0]);
    if (!operationArgs.includes("--yes")) {
      throw new Error(`Refusing to delete ${app.name} without --yes`);
    }
    await platformRequest(connection, `/_platform/apps/${encodeURIComponent(app.id)}`, {
      method: "DELETE",
    });
    if (jsonOutput)
      writePlatformResult({ deleted: true, app: { id: app.id, name: app.name } }, true);
    else console.log(`Deleted: ${app.name}`);
    return;
  }

  throw new Error(`Unknown platform command: ${operation ?? "(missing)"}\n\n${usage}`);
}
