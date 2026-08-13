# Releasing npm packages

All publishable packages use the version in the root `package.json`. The root workspace is private and is not published; its version identifies the release train.

## Prepare a release

Start from a clean working tree. Increment the root version without creating a commit or Git tag:

This prompts for the intended semantic version, then updates the root version without creating a Git commit or tag and synchronizes every publishable package, internal `@nosrv/*` dependency, example dependency, CLI MCP client version, and the lockfile.

```bash
npm run set-version
```

For non-interactive use, pass the version explicitly, such as `npm run set-version -- 0.3.1`.

Review the resulting manifest and lockfile changes before continuing. Do not edit individual package versions or example dependencies by hand.

## Verify and publish

Run the complete release check:

```bash
npm run check
```

This checks formatting, builds publishable TypeScript packages, type-checks the workspace, runs all tests, verifies that package and internal dependency versions match the root version, and inspects every npm tarball.

Display the dependency-ordered publish set, then confirm interactively whether to upload the pending versions:

```bash
npm run publish
```

For non-interactive use, publish all versions that are not already present in the registry with:

```bash
npm run publish -- --confirm
```

The publish command skips an already-published `name@version`, so it can be rerun after a partial failure. npm does not permit replacing an existing version.

After npm publishing succeeds, commit all reviewed release changes, push `dev`, and run this from `dev`. It verifies that local `dev` exactly matches `origin/dev`, creates a PR to `main`, squash-merges it, updates local `main`, creates the annotated tag and GitHub Release page, then merges the updated `main` back into the long-lived `dev` branch:

```bash
npm run release
```

`release` does not create a commit, push release commits, or run npm publishing. Run `npm run publish` first. It requires a clean working tree, the current branch to be `dev`, local `dev` to exactly match `origin/dev`, an unused `v<version>` tag, an authenticated `gh` CLI, and the `origin` remote. Starting from `main`, having uncommitted changes, or having unpushed, unpulled, or diverged commits is an error. After creating the release, it merges `main` back into `dev`, so `dev` remains the long-lived development branch and no force-push or re-derivation from `main` is needed.

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
