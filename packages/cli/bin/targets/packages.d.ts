interface ResolvedPackage {
  entryPath: string;
  packageJsonPath: string;
  require: NodeJS.Require;
}

interface ResolvedCloudPackage extends ResolvedPackage {
  packageName: string;
  installCommand: string;
  label: string;
}

export function resolveCloudPackage(cwd: string, target: string): ResolvedCloudPackage;
export function resolvePostgresPackage(cwd: string, context: string): ResolvedPackage;
