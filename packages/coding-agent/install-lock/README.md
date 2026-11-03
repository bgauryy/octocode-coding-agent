# Registry installer artifacts

This checkout uses local `file:` dependencies. Registry installer manifests are
not available in this mode. The old upstream manifests were removed.

Publishing does not use these files: `yarn run publish` takes exact versions from
`octocodeRelease` in the package manifest. To generate an installer lock anyway, replace
local dependency paths with reviewed, exact registry versions, refresh the root lockfile,
and generate these files:

```sh
node scripts/generate-coding-agent-install-lock.mjs --require-registry
node scripts/generate-coding-agent-install-lock.mjs --check --require-registry
```

The generator writes `package.json` and `package-lock.json` for the Octocode
installer. Release scripts require those artifacts to pass validation.
