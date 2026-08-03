import { readFileSync, writeFileSync } from "node:fs";
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

for (const pkg of orderedPackages()) {
  const manifest = structuredClone(pkg.manifest);
  manifest.version = version;
  for (const field of dependencyFields) {
    const dependencies = manifest[field];
    if (!dependencies) continue;
    for (const name of Object.keys(dependencies)) {
      if (packageNames.has(name)) dependencies[name] = version;
    }
  }
  writeFileSync(pkg.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

console.log(`Synchronized ${packageNames.size} publishable packages to ${version}.`);
