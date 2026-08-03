import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { orderedPackages, publishablePackages, root, run } from "./release-packages.js";

const releaseVersion = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
const packageNames = new Set(publishablePackages().keys());
for (const pkg of orderedPackages()) {
  if (pkg.manifest.version !== releaseVersion) {
    throw new Error(
      `${pkg.manifest.name} version ${pkg.manifest.version} does not match root version ${releaseVersion}`,
    );
  }
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    for (const [name, version] of Object.entries(pkg.manifest[field] ?? {})) {
      if (packageNames.has(name) && version !== releaseVersion) {
        throw new Error(
          `${pkg.manifest.name} ${field}.${name} must be ${releaseVersion}, received ${version}`,
        );
      }
    }
  }
}

for (const pkg of orderedPackages()) {
  const result = run("npm", ["pack", "--dry-run", "--json", "-w", pkg.manifest.name], {
    capture: true,
  });
  const packed = JSON.parse(result.stdout)[0];
  const files = new Set(packed.files.map(({ path }) => path));
  const required =
    pkg.manifest.name === "nosrv"
      ? ["package.json", "bin/nosrv.js"]
      : ["package.json", "dist/index.js", "dist/index.d.ts"];

  for (const path of required) {
    if (!files.has(path)) throw new Error(`${pkg.manifest.name}: tarball is missing ${path}`);
  }
  if ([...files].some((path) => path === "src/index.ts")) {
    throw new Error(`${pkg.manifest.name}: source TypeScript must not be published`);
  }
  console.log(
    `${pkg.manifest.name}@${pkg.manifest.version}: ${packed.entryCount} files, ${packed.unpackedSize} bytes`,
  );
}

console.log("All publishable package tarballs passed inspection.");
