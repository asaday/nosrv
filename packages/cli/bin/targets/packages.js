import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const checkoutPackages = {
  "@nosrv/aws": {
    directory: "packages/aws",
    entry: "packages/aws/src/index.ts",
  },
  "@nosrv/azure": {
    directory: "packages/azure",
    entry: "packages/azure/src/index.ts",
  },
  "@nosrv/cloudflare": {
    directory: "packages/cloudflare",
    entry: "packages/cloudflare/src/index.ts",
  },
  "@nosrv/google-cloud": {
    directory: "packages/google-cloud",
    entry: "packages/google-cloud/src/index.ts",
  },
  "@nosrv/postgres": {
    directory: "packages/postgres",
    entry: "packages/postgres/src/index.ts",
  },
};

const cloudTargets = {
  cloudflare: {
    packageName: "@nosrv/cloudflare",
    installCommand: "npm install -D @nosrv/cloudflare",
    label: "Cloudflare",
  },
  "google-functions": {
    packageName: "@nosrv/google-cloud",
    installCommand: "npm install -D @nosrv/google-cloud",
    label: "Google Functions",
  },
  lambda: {
    packageName: "@nosrv/aws",
    installCommand: "npm install -D @nosrv/aws",
    label: "AWS Lambda",
  },
  azure: {
    packageName: "@nosrv/azure",
    installCommand: "npm install -D @nosrv/azure",
    label: "Azure Functions",
  },
};

function appRequire(cwd) {
  return createRequire(resolve(cwd, "__nosrv__.js"));
}

function checkoutRoot() {
  return resolve(import.meta.dirname, "../../../..");
}

function missingPackageError(context, packageName, installCommand) {
  return new Error(
    `${context} requires ${packageName}. Install it in the application with:\n\n  ${installCommand}`,
  );
}

function resolveFromCheckout(packageName) {
  if (process.env.NOSRV_DISABLE_CHECKOUT_FALLBACK === "1") return null;
  const checkoutPackage = checkoutPackages[packageName];
  if (!checkoutPackage) return null;
  const root = checkoutRoot();
  const packageJsonPath = resolve(root, checkoutPackage.directory, "package.json");
  if (!existsSync(packageJsonPath)) return null;
  return {
    entryPath: resolve(root, checkoutPackage.entry),
    packageJsonPath,
    require: createRequire(packageJsonPath),
  };
}

function packageJsonFromEntry(entryPath) {
  let directory = dirname(entryPath);
  while (directory !== dirname(directory)) {
    const packageJsonPath = resolve(directory, "package.json");
    if (existsSync(packageJsonPath)) return packageJsonPath;
    directory = dirname(directory);
  }
  throw new Error(`Unable to locate package.json for ${entryPath}`);
}

function resolveRequiredPackage(cwd, context, packageName, installCommand) {
  const requireFromApp = appRequire(cwd);
  try {
    const entryPath = requireFromApp.resolve(packageName);
    return {
      entryPath,
      packageJsonPath: packageJsonFromEntry(entryPath),
      require: requireFromApp,
    };
  } catch {
    const checkout = resolveFromCheckout(packageName);
    if (checkout) return checkout;
    throw missingPackageError(context, packageName, installCommand);
  }
}

export function resolveCloudPackage(cwd, target) {
  const configuration = cloudTargets[target];
  if (!configuration) throw new Error(`Unsupported target package resolution: ${target}`);
  return {
    ...resolveRequiredPackage(
      cwd,
      `${configuration.label} target`,
      configuration.packageName,
      configuration.installCommand,
    ),
    ...configuration,
  };
}

export function resolvePostgresPackage(cwd, context) {
  return resolveRequiredPackage(
    cwd,
    `${context} PostgreSQL support`,
    "@nosrv/postgres",
    "npm install -D @nosrv/postgres",
  );
}
