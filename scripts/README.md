# Repository scripts

Run these through the root `yarn run` scripts where one exists; the others are manual tools or modules the scripts share.

## Through `yarn run`

| Script | Run with | Does |
|---|---|---|
| `check-max-lines-baseline.mjs` | `lint` | Fails while a file on the `max-lines` baseline in `.oxlintrc.json` fits 400 lines; `--update` removes split files |
| `check-browser-smoke.mjs` | `check:browser-smoke` | Bundles the browser-facing exports with Rolldown: no Node imports, selective-provider tree shaking (entries: `browser-smoke-entry.ts`, `agent-treeshake-smoke-entry.ts`) |
| `build-workspace-state.mjs` | `generate:workspace`, `check:workspace` | Builds the webview page bundle into `packages/webview/src/state.generated.ts` |
| `check-package-boundaries.mjs` | `check:boundaries` | Package import boundaries |
| `build-coding-agent-bundle.mjs` | `build` in `packages/coding-agent` | The packaged CLI bundle (Rolldown) and its lazy entries |
| `stage-bash-parser.mjs` | coding-agent `copy-assets` | Stages the Bash parser for the package |
| `stage-binary.mjs` | coding-agent `build:binary`; `build-binaries.sh` | Stages everything a compiled binary reads next to itself (themes, export template, roles, skills via `stage-coding-agent-skills.mjs`, native helpers) |
| `generate-coding-agent-install-lock.mjs` | `install-lock:coding-agent`, `check:install-lock:coding-agent` | The coding-agent installer lock |
| `diff-model-catalog.mjs` | `diff:model-catalog` | Compares model catalogs |
| `profile-coding-agent-node.mjs` | `profile:tui`, `profile:rpc` | Profiles the CLI under Node |
| `pack-packages.mjs` | `pack:packages` | Packs the public packages |
| `check-package-install.mjs` | `check:package-install` | Installs the packed packages and smoke-tests the CLI (needs registry-installable dependencies) |
| `local-release.mjs` | `release:local` | A local release candidate |
| `test-workspaces.mjs` | `test` (through `./test.sh`) | Runs the script tests and every workspace's tests, continuing past a failing suite, then lists the failures |
| `release.mjs`, `sync-versions.js`, `publish.mjs`, `release-notes.mjs` | `release:*`, `version:*`, `publish`, `release:fix-links` | Versioning, publishing and release notes |

## Manual tools

| Script | Does |
|---|---|
| `auto-octocode.sh` | Runs octocode from this checkout's latest build (install instructions in its header) |
| `build-binaries.sh` | Builds the platform binaries |
| `create-source-archive.sh` | Creates the deterministic source archive for a GitHub release |
| `publish-release-announcement.mjs` | Publishes the release announcement |
| `stage-registry-release.mjs` | Stages a release in a disposable registry |
| `use-local-packages.mjs` | Points a consumer project at locally packed packages |
| `generate-thinking-capabilities.mjs` | Generates thinking-capability data from a model catalog |
| `profile-render-backpressure.mjs` | Compares TUI render schedulers against a slow terminal |

The coding-agent package also includes [export-agent-prompts.ts](../packages/coding-agent/scripts/export-agent-prompts.ts), a manual fixture exporter for native role prompts and tool declarations. From the repository root, run `yarn exec node --import ./packages/coding-agent/src/experimental/source-resolver.ts packages/coding-agent/scripts/export-agent-prompts.ts <output-directory> [captured-mcp-catalog.json]`. It uses isolated configuration and makes no model calls; the optional catalog adds captured MCP declarations without executing their tools.

## Shared modules

`coding-agent-smoke.mjs`, `local-package-install.mjs`, `local-dependencies.mjs`, `npm-command.mjs`, `package-artifacts.mjs`, `package-workspaces.mjs`, `registry-release.mjs`, `release-packages.mjs` and `yarn-command.mjs` are imported by the scripts above. `*.test.mjs` files run with `yarn run test:scripts`.
