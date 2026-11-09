# Installer lock

This development checkout uses local `file:`/`link:` dependencies, so no registry installer manifests are kept here. Publishing does not use this folder: `yarn run publish` takes exact versions from `octocodeRelease` in the package manifest ([DEVELOPMENT.md](../../../DEVELOPMENT.md#release)).

To generate an installer lock anyway, replace local dependency paths with reviewed exact registry versions, refresh the root lockfile, then run from the repository root:

```sh
node scripts/generate-coding-agent-install-lock.mjs --require-registry
node scripts/generate-coding-agent-install-lock.mjs --check --require-registry
```

It writes `package.json` and `package-lock.json` for the Octocode installer; release scripts require them to validate. The root scripts `install-lock:coding-agent` and `check:install-lock:coding-agent` run the same generator without `--require-registry`.
