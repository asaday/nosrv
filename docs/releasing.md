# Releasing npm packages

All publishable packages use the version in the root `package.json`. The root workspace is private and is not published; its version identifies the release train.

## Prepare a release

Start from a clean working tree. Increment the root version without creating a commit or Git tag:

This updates the root version without creating a Git commit or tag, then synchronizes every publishable package, internal `@nosrv/*` dependency, example dependency, CLI MCP client version, and the lockfile. Pass the intended semantic version explicitly, such as `0.3.1`, `0.4.0`, or `1.0.0`.

```bash
npm run set-version -- 0.3.0
```

Review the resulting manifest and lockfile changes before continuing. Do not edit individual package versions or example dependencies by hand.

## Verify and publish

Run the complete release check:

```bash
npm run check
```

This checks formatting, builds publishable TypeScript packages, type-checks the workspace, runs all tests, verifies that package and internal dependency versions match the root version, and inspects every npm tarball.

Preview the dependency-ordered publish set without uploading anything:

```bash
npm run publish
```

After checking `npm whoami`, the version, and the displayed package order, publish all versions that are not already present in the registry:

```bash
npm run publish -- --confirm
```

The publish command skips an already-published `name@version`, so it can be rerun after a partial failure. npm does not permit replacing an existing version.

After npm publishing succeeds, create the Git commit, annotated tag, push it, and create the GitHub Release page:

```bash
npm run release
```

This requires the reviewed release changes to be present, an unused `v<version>` tag, an authenticated `gh` CLI, and the `origin` remote. It stages all current changes, so unrelated changes must be removed before running it. It intentionally runs only after verification and npm publishing.

## Update nosrv Platform

After the npm release is available, update the pinned `nosrv` and `@nosrv/*` dependencies in the separate `nosrv-platform` repository to the new root release version. Regenerate its lockfile, run `npm run check`, and verify the clean Docker and Compose builds before deploying it.

## Verify the release

Check the registry and a clean CLI installation:

```bash
npm view @nosrv/core version
npm view nosrv version
npm install --global nosrv
nosrv --help
```
