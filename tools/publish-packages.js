import { createInterface } from "node:readline/promises";
import { orderedPackages, run } from "./release-packages.js";

let confirmed = process.argv.includes("--confirm");
const packages = orderedPackages();
const pending = [];
const published = [];

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

if (pending.length === 0) {
  console.log("\nAll package versions are already published.");
  process.exit(0);
}

if (!confirmed && process.stdin.isTTY && process.stdout.isTTY) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(
      `\nPublish ${pending.length} pending package versions? [y/N] `,
    );
    confirmed = /^(?:y|yes)$/i.test(answer.trim());
  } catch (error) {
    if (error?.code !== "ABORT_ERR") throw error;
    console.error("\nPublish cancelled.");
    process.exit(1);
  } finally {
    prompt.close();
  }
}

if (!confirmed) {
  console.log("\nPublish cancelled. For non-interactive use, pass --confirm.");
  process.exit(0);
}

run("npm", ["run", "check"]);

for (const pkg of pending) {
  const id = `${pkg.manifest.name}@${pkg.manifest.version}`;
  console.log(`\nPublishing ${id}...`);
  run("npm", ["publish", "-w", pkg.manifest.name]);
}

console.log(`\nPublished ${pending.length} package versions.`);
