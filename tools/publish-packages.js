import { orderedPackages, run } from "./release-packages.js";

const confirmed = process.argv.includes("--confirm");
const packages = orderedPackages();
const pending = [];
const published = [];

if (confirmed) run("npm", ["run", "check"]);

for (const pkg of packages) {
  const id = `${pkg.manifest.name}@${pkg.manifest.version}`;
  const result = run("npm", ["view", id, "version", "--json"], {
    capture: true,
    allowFailure: true,
  });
  if (result.status === 0) {
    published.push(id);
  } else if (result.stderr.includes("E404")) {
    pending.push(pkg);
  } else {
    process.stderr.write(result.stderr);
    throw new Error(`Could not determine whether ${id} is already published`);
  }
}

console.log("Publish order:");
for (const [index, pkg] of packages.entries()) {
  const id = `${pkg.manifest.name}@${pkg.manifest.version}`;
  console.log(`${index + 1}. ${id}${published.includes(id) ? " (already published)" : ""}`);
}

if (!confirmed) {
  console.log("\nDry run only. Re-run with --confirm to publish pending versions.");
  process.exit(0);
}

if (pending.length === 0) {
  console.log("\nAll package versions are already published.");
  process.exit(0);
}

for (const pkg of pending) {
  const id = `${pkg.manifest.name}@${pkg.manifest.version}`;
  console.log(`\nPublishing ${id}...`);
  run("npm", ["publish", "-w", pkg.manifest.name]);
}

console.log(`\nPublished ${pending.length} package versions.`);
