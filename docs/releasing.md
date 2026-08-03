# Releasing npm packages

All publishable packages use the version in the root `package.json`. The root workspace is private and is not published; its version identifies the release train.

## Prepare a release

Start from a clean working tree. Increment the root version without creating a commit or Git tag:

```bash
npm version patch --no-git-tag-version
```

Use `minor` or `major` instead of `patch` when appropriate. Then synchronize every publishable package, internal `@nosrv/*` dependency, and the lockfile with the root version:

```bash
npm run release:sync
```

Review the resulting manifest and lockfile changes before continuing. Do not edit individual package versions by hand.

## Verify and publish

Run the complete release check:

```bash
npm run release:check
```

This checks formatting, builds publishable TypeScript packages, type-checks the workspace, runs all tests, verifies that package and internal dependency versions match the root version, and inspects every npm tarball.

Preview the dependency-ordered publish set without uploading anything:

```bash
npm run release:publish
```

After checking `npm whoami`, the version, and the displayed package order, publish all versions that are not already present in the registry:

```bash
npm run release:publish -- --confirm
```

The publish command skips an already-published `name@version`, so it can be rerun after a partial failure. npm does not permit replacing an existing version.

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
