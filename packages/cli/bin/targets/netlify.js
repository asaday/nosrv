import { mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import {
  copyPublicDirectory,
  resolveEnvironment,
  resolvePublicConfig,
  resolveResourcesDirectory,
  resolveSchedules,
} from "../project.js";
import { bundleDeployment, readOption } from "./shared.js";

async function generateNetlifyDeployment(cwd, appPath, config) {
  const schedules = resolveSchedules(config.schedules);
  if (schedules.length) {
    throw new Error(
      "Netlify schedule generation is not automated yet; deploy without schedules or configure Scheduled Functions explicitly",
    );
  }
  const output = resolve(cwd, ".nosrv/netlify/deploy");
  await rm(output, { recursive: true, force: true });
  await Promise.all([
    mkdir(resolve(output, "functions"), { recursive: true }),
    mkdir(resolve(output, "public"), { recursive: true }),
  ]);
  const publicConfig = resolvePublicConfig(cwd, config.spa === true);
  if (publicConfig) await copyPublicDirectory(publicConfig.directory, resolve(output, "public"));
  const resourcesDirectory = resolveResourcesDirectory(cwd);
  if (resourcesDirectory) {
    await copyPublicDirectory(resourcesDirectory, resolve(output, "functions/resources"));
  }
  if (appPath) {
    const require = createRequire(import.meta.url);
    const adapterPath = require.resolve("@nosrv/adapter-netlify");
    const resourceProviderPath = require.resolve("@nosrv/provider-filesystem");
    const netlifyOptions = [
      resolveEnvironment(config.env)
        ? "env: " + JSON.stringify(resolveEnvironment(config.env))
        : undefined,
      resourcesDirectory
        ? 'resources: new FilesystemResources(new URL("./resources", import.meta.url).pathname)'
        : undefined,
    ]
      .filter(Boolean)
      .join(", ");
    const options = netlifyOptions ? ", { " + netlifyOptions + " }" : "";
    const entry = `import { createNetlifyHandler } from ${JSON.stringify(adapterPath)};\nimport { FilesystemResources } from ${JSON.stringify(resourceProviderPath)};\nimport app from ${JSON.stringify(appPath)};\nexport default createNetlifyHandler(app${options});\n`;
    await bundleDeployment(entry, resolve(output, "functions/nosrv.mjs"));
  }
  const netlifyConfig = [
    "[build]",
    '  publish = "public"',
    '  functions = "functions"',
    ...(appPath
      ? [
          "",
          "[[redirects]]",
          '  from = "/*"',
          '  to = "/.netlify/functions/nosrv"',
          "  status = 200",
        ]
      : []),
    "",
  ].join("\n");
  await writeFile(resolve(output, "netlify.toml"), netlifyConfig, "utf8");
  return output;
}

export async function runNetlifyDeploy(cwd, appPath, config, args) {
  const output = await generateNetlifyDeployment(cwd, appPath, config);
  console.log(`Generated Netlify deployment: ${output}`);
  if (args.includes("--dry-run")) return;
  const deployment = config.deploy?.netlify ?? {};
  const commandArgs = ["deploy", "--dir", "public", "--functions", "functions"];
  if (args.includes("--prod") || deployment.prod === true) commandArgs.push("--prod");
  const site = readOption(args, "--site") ?? deployment.site;
  if (site) commandArgs.push("--site", String(site));
  const alias = readOption(args, "--alias") ?? deployment.alias;
  if (alias) commandArgs.push("--alias", String(alias));
  const child = spawn("netlify", commandArgs, { cwd: output, stdio: "inherit" });
  const code = await new Promise((done, reject) => {
    child.once("error", (error) =>
      reject(
        error.code === "ENOENT"
          ? new Error(
              "Netlify CLI is required for Netlify deployment; install netlify-cli and run netlify login",
            )
          : error,
      ),
    );
    child.once("exit", (value, signal) => done(signal ? 1 : (value ?? 1)));
  });
  if (code !== 0) process.exitCode = code;
}
