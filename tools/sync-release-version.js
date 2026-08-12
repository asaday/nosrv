import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { orderedPackages, publishablePackages, root } from "./release-packages.js";

const rootManifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const version = rootManifest.version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("Root package.json must contain a valid release version");
}

const packageNames = new Set(publishablePackages().keys());
const dependencyFields = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

function workspaceManifests(directory) {
  const manifests = [];
  for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
    const path = resolve(root, directory, entry.name);
    if (entry.isDirectory()) manifests.push(...workspaceManifests(`${directory}/${entry.name}`));
    else if (entry.name === "package.json") manifests.push(path);
  }
  return manifests;
}

function synchronizeManifest(manifestPath, { publishable = false } = {}) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (publishable) manifest.version = version;
  for (const field of dependencyFields) {
    const dependencies = manifest[field];
    if (!dependencies) continue;
    for (const name of Object.keys(dependencies)) {
      if (!packageNames.has(name)) continue;
      dependencies[name] = publishable ? version : `^${version}`;
    }
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

for (const pkg of orderedPackages()) {
  synchronizeManifest(pkg.manifestPath, { publishable: true });
}

for (const manifestPath of workspaceManifests("examples")) synchronizeManifest(manifestPath);

const mcpPath = resolve(root, "packages/cli/src/mcp.ts");
const mcpSource = readFileSync(mcpPath, "utf8");
const updatedMcpSource = mcpSource.replace(
  /(clientInfo:\s*\{\s*name:\s*"nosrv",\s*version:\s*")[^"]+("\s*\})/,
  `$1${version}$2`,
);
if (updatedMcpSource !== mcpSource) writeFileSync(mcpPath, updatedMcpSource, "utf8");

console.log(`Synchronized publishable packages and examples to ${version}.`);
