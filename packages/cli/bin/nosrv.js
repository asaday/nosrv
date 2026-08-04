#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import packageManifest from "../package.json" with { type: "json" };
import { loadConfig, projectName, resolveApp, resolvePermissions } from "./project.js";
import {
  deployPlatform,
  platformCommand,
  platformLogin,
  platformLogout,
  platformWhoami,
  studioImport,
} from "./platform.js";
import { buildArtifact, runArtifact } from "./artifact.js";
import { dev } from "./dev-node.js";
import { runWranglerDeploy } from "./targets/cloudflare.js";
import { runGoogleDeploy } from "./targets/google-functions.js";
import { runLambdaDeploy } from "./targets/lambda.js";
import { runAzureDeploy } from "./targets/azure.js";

const usage = `nosrv v${packageManifest.version}

Usage:
  nosrv create <directory> [--template <basic|react>]
  nosrv studio import <directory> [--mode <copy|link>] [--name <name>]
  nosrv build [--output <directory>]
  nosrv run <artifact-directory> [--port <number>] [--host <hostname>]
  nosrv dev [--target <node|cloudflare|google-functions|lambda>] [--port <number>] [--host <hostname>]
  nosrv deploy [--target <platform|cloudflare|google-functions|lambda|azure>] [target options]
  nosrv login [--url <platform-url>] [--header <name:value>...]
  nosrv whoami
  nosrv logout
  nosrv link <platform-path>
  nosrv list [--json]
  nosrv info [name-or-id] [--json]
  nosrv <start|stop|restart> [name-or-id] [--json]
  nosrv logs [name-or-id] [--json]
  nosrv versions [name-or-id] [--json]
  nosrv activate [name-or-id] <version-id> [--json]
  nosrv secrets <list|set|delete> [name-or-id] [secret-name] [--stdin|--yes|--json]
  nosrv shared <env|secrets> <list|set|delete> [name] [--stdin|--yes|--json]
  nosrv delete [name-or-id] --yes [--json]

Platform options:
  --header, -H <name:value>  Save a Platform header at login; repeatable
  nosrv --help`;

async function createProject(directoryArgument, template = "basic") {
  if (!directoryArgument || directoryArgument.startsWith("-")) {
    throw new Error(`create requires a directory\n\n${usage}`);
  }
  if (template !== "basic" && template !== "react")
    throw new Error(`Unknown template: ${template}`);
  const directory = resolve(process.cwd(), directoryArgument);
  const cliPath = fileURLToPath(import.meta.url);
  const checkoutRoot = resolve(dirname(cliPath), "../../..");
  const checkoutCore = resolve(checkoutRoot, "packages/core");
  const usesCheckout = existsSync(resolve(checkoutCore, "package.json"));
  const coreDependency = usesCheckout
    ? `file:${relative(directory, checkoutCore).split(sep).join("/")}`
    : `^${packageManifest.version}`;
  const localCliCommand = (command) => `node ${JSON.stringify(cliPath)} ${command}`;
  const scripts = {
    dev: usesCheckout ? localCliCommand("dev") : "nosrv dev",
    deploy: usesCheckout ? localCliCommand("deploy") : "nosrv deploy",
  };
  const agentInstructions = `# nosrv application\n\n- Use Web Standard Request and Response.\n- Export the application with defineApp().\n- Declare required database, KV, and storage capabilities and access them through ctx.\n- Use runtime-provided ctx.env, ctx.secrets, ctx.resources, and ctx.user without declaring them.\n- Put immutable private files under resources/ and read them with ctx.resources; use public/ only for browser-visible assets.\n- Do not import cloud-provider SDKs into portable application code.\n- Keep backend routes under /api when serving a frontend.\n- Use relative browser URLs such as ./app.js and api/items so Platform route prefixes keep working.\n- Validate request data at runtime.\n- For cron work, export scheduled(event, ctx), declare five-field UTC schedules in nosrv.yaml, and keep the work short and idempotent.\n- Default to plain HTML, CSS, and JavaScript unless UI complexity justifies a framework.\n- Run the application with nosrv dev and verify important success and error responses.\n- Deploy with nosrv deploy for Platform or nosrv deploy --target cloudflare. Keep non-development Platform tokens in NOSRV_TOKEN, not nosrv.yaml. Lambda and Google deployment are not automated yet.\n`;
  const basicFiles = {
    "src/app.ts": `import { defineApp } from "@nosrv/core";\n\nexport default defineApp({\n  async fetch(request) {\n    const { pathname } = new URL(request.url);\n    if (pathname === "/api/hello") {\n      return Response.json({ message: "Hello from nosrv!" });\n    }\n    return Response.json({ error: "Not found" }, { status: 404 });\n  },\n});\n`,
    "public/index.html": `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width">\n  <title>nosrv App</title>\n  <link rel="stylesheet" href="./style.css">\n</head>\n<body>\n  <main>\n    <h1>nosrv</h1>\n    <p id="message">Loading...</p>\n  </main>\n  <script type="module" src="./app.js"></script>\n</body>\n</html>\n`,
    "public/app.js": `const response = await fetch("api/hello");\nconst data = await response.json();\ndocument.querySelector("#message").textContent = data.message;\n`,
    "public/style.css": `:root { font-family: system-ui, sans-serif; color-scheme: light dark; }\nbody { margin: 0; min-height: 100vh; display: grid; place-items: center; }\nmain { text-align: center; }\n`,
    "package.json": `${JSON.stringify(
      {
        name: projectName(directory),
        private: true,
        type: "module",
        scripts,
        dependencies: { "@nosrv/core": coreDependency },
      },
      null,
      2,
    )}\n`,
    "AGENTS.md": agentInstructions,
    ".gitignore": `.nosrv/\nnode_modules/\n.env\n`,
  };
  const reactFiles = {
    "src/app.ts": `import { defineApp } from "@nosrv/core";\n\nexport default defineApp({\n  async fetch(request) {\n    const { pathname } = new URL(request.url);\n    if (pathname === "/api/hello") {\n      return Response.json({ message: "Hello from nosrv!" });\n    }\n    return Response.json({ error: "Not found" }, { status: 404 });\n  },\n});\n`,
    "web/main.jsx": `import { StrictMode, useEffect, useState } from "react";\nimport { createRoot } from "react-dom/client";\nimport "./style.css";\n\nfunction App() {\n  const [message, setMessage] = useState("Loading...");\n  useEffect(() => {\n    fetch("api/hello").then((response) => response.json()).then((data) => setMessage(data.message));\n  }, []);\n  return <main><h1>nosrv + React</h1><p>{message}</p></main>;\n}\n\ncreateRoot(document.querySelector("#root")).render(<StrictMode><App /></StrictMode>);\n`,
    "web/style.css": `:root { font-family: system-ui, sans-serif; color-scheme: light dark; }\nbody { margin: 0; min-height: 100vh; display: grid; place-items: center; }\nmain { text-align: center; }\n`,
    "index.html": `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width">\n  <title>nosrv + React</title>\n</head>\n<body>\n  <div id="root"></div>\n  <script type="module" src="/web/main.jsx"></script>\n</body>\n</html>\n`,
    "vite.config.js": `import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\n\nexport default defineConfig({\n  base: "./",\n  plugins: [react()],\n  build: { outDir: "public", emptyOutDir: true },\n  server: {\n    proxy: { "/api": "http://127.0.0.1:8787" },\n  },\n});\n`,
    "nosrv.yaml": `app: ./src/app.ts\nspa: true\n\ndev:\n  host: 127.0.0.1\n  port: 8787\n`,
    "package.json": `${JSON.stringify(
      {
        name: projectName(directory),
        private: true,
        type: "module",
        scripts: { ...scripts, "dev:web": "vite", build: "vite build" },
        dependencies: { "@nosrv/core": coreDependency, react: "^19.2.0", "react-dom": "^19.2.0" },
        devDependencies: { "@vitejs/plugin-react": "^6.0.3", vite: "^8.1.5" },
        engines: { node: ">=24" },
      },
      null,
      2,
    )}\n`,
    "AGENTS.md": agentInstructions,
    ".gitignore": `.nosrv/\nnode_modules/\npublic/\n.env\n`,
  };
  const files = template === "react" ? reactFiles : basicFiles;
  const conflicts = Object.keys(files).filter((path) => existsSync(resolve(directory, path)));
  if (conflicts.length) {
    throw new Error(
      `Refusing to overwrite existing files:\n${conflicts.map((path) => `  ${path}`).join("\n")}`,
    );
  }
  await Promise.all([
    mkdir(resolve(directory, "src"), { recursive: true }),
    mkdir(resolve(directory, template === "react" ? "web" : "public"), { recursive: true }),
  ]);
  await Promise.all(
    Object.entries(files).map(([path, contents]) =>
      writeFile(resolve(directory, path), contents, "utf8"),
    ),
  );

  const displayDirectory = directoryArgument === "." ? "." : directoryArgument;
  console.log(`Created ${displayDirectory}`);
  console.log("\nNext:");
  if (displayDirectory !== ".") console.log(`  cd ${displayDirectory}`);
  console.log("  npm install");
  if (template === "react") {
    console.log("  npm run dev:web");
    console.log("\nIn another terminal:");
  }
  console.log("  npm run dev");
}

function readOption(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function readTarget(args, fallback = "node") {
  return readOption(args, "--target") ?? readOption(args, "-t") ?? fallback;
}

function hasTargetOption(args) {
  return ["--target", "-t"].some((name) => args.includes(name));
}

function deploymentTargetLabel(target) {
  const labels = {
    platform: "nosrv Platform",
    cloudflare: "Cloudflare Workers",
    "google-functions": "Google Cloud Functions",
    lambda: "AWS Lambda",
    azure: "Azure Functions",
  };
  return labels[target] ?? target;
}

async function deploy(args) {
  const cwd = process.cwd();
  const config = await loadConfig(cwd);
  const appPath = resolveApp(cwd, config.app, {
    allowStatic: true,
  });
  const target = readTarget(args, "platform");
  console.log(
    `Target: ${deploymentTargetLabel(target)}${hasTargetOption(args) ? "" : " (default)"}`,
  );
  const permissions = resolvePermissions(config.permissions);
  if (permissions && target !== "platform") {
    throw new Error("Apps with host permissions can only deploy to nosrv Platform, not " + target);
  }
  if (target === "platform") {
    await deployPlatform(cwd, config, args, buildArtifact);
    return;
  }
  if (target === "google-functions") {
    await runGoogleDeploy(cwd, appPath, config, args);
    return;
  }
  if (target === "lambda") {
    await runLambdaDeploy(cwd, appPath, config, args);
    return;
  }
  if (target === "azure") {
    await runAzureDeploy(cwd, appPath, config, args);
    return;
  }
  if (target !== "cloudflare") {
    throw new Error(
      `Unsupported deployment target: ${target}. Currently supported: cloudflare, platform, google-functions, lambda, azure`,
    );
  }
  await runWranglerDeploy(cwd, appPath, config, args);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(usage);
    return;
  }
  if (args[0] === "create") {
    await createProject(args[1], readOption(args, "--template") ?? "basic");
    return;
  }
  if (args[0] === "studio" && args[1] === "import") {
    await studioImport(args.slice(2), usage);
    return;
  }
  if (args[0] === "build") {
    await buildArtifact(args.slice(1));
    return;
  }
  if (args[0] === "run") {
    await runArtifact(args.slice(1), dev);
    return;
  }
  if (args[0] === "deploy") {
    await deploy(args.slice(1));
    return;
  }
  if (args[0] === "login") {
    await platformLogin(args.slice(1));
    return;
  }
  if (args[0] === "whoami") {
    await platformWhoami(args.slice(1));
    return;
  }
  if (args[0] === "logout") {
    await platformLogout(args.slice(1));
    return;
  }
  if (
    [
      "link",
      "list",
      "info",
      "start",
      "stop",
      "restart",
      "logs",
      "versions",
      "activate",
      "secrets",
      "shared",
      "delete",
    ].includes(args[0])
  ) {
    await platformCommand(args, usage);
    return;
  }
  if (args[0] !== "dev") {
    throw new Error(`Unknown command: ${args[0]}\n\n${usage}`);
  }
  await dev(args.slice(1));
}

main().catch((error) => {
  const detail =
    error && typeof error === "object" && error.code === "ERR_ACCESS_DENIED"
      ? ` (${[error.permission, error.resource].filter(Boolean).join(": ")})`
      : "";
  console.error(`nosrv: ${error instanceof Error ? error.message : String(error)}${detail}`);
  process.exitCode = 1;
});
