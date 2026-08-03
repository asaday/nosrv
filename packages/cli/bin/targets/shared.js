export function readOption(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

export async function bundleDeployment(entry, outfile, external = []) {
  const { build } = await import("esbuild");
  await build({
    stdin: {
      contents: entry,
      resolveDir: process.cwd(),
      sourcefile: "nosrv-entry.ts",
      loader: "ts",
    },
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    sourcemap: false,
    legalComments: "none",
    logLevel: "silent",
    external,
  });
}
