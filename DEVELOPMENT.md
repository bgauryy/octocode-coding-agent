# Developing octocode-code

This page is for working on Octocode itself. To use it, read the [README](README.md).

octocode-code is a coding agent forked from [Pi](https://github.com/earendil-works/pi). It combines Pi's agent loop, provider integrations and terminal UI with native Octocode features for code research, guarded file changes, subagents, collaboration, browser work, memory and session recovery.

These features originated in `packages/octocode-pi-extension` in the sibling `octocode` repository. Their implementation now lives in [packages/coding-agent/src/octocode](packages/coding-agent/src/octocode/); this fork loads it automatically. Installing the original extension is unnecessary.

## Run from source

Use Node.js 24.15 or newer **within Node 24**: the sibling Octocode dependencies currently require `^24.15.0`. `.node-version` pins that line. This checkout depends on built packages at `../octocode/packages/octocode`, `../octocode/packages/octocode-mcp` and `../octocode/packages/octocode-native`, including their CLI artifacts and native platform binaries. Check out the sibling repository at the ref in [`.github/octocode-ref`](.github/octocode-ref), currently the `octocode-20.0.0` branch: its default branch does not have these packages. CI reads the same file.

From this repository's root:

```sh
yarn install --immutable
yarn run hydrate:model-data
yarn start
```

Hydration downloads the provider model catalog. Use `/login` to connect an AI account or API key, then `/model` to choose a model and enter a task. `yarn start --help` lists CLI options; `/help` lists the native feature commands. For compiled artifacts, run `yarn run build:offline` after hydration.

The package name is `@octocodeai/octocodecode`, and its agent executable is `octocode`. The research and native executables are available without name collisions through:

```sh
yarn start research --help
yarn start native --help
```

Local dependencies make this a development checkout. `@octocodeai/octocodecode` is the only package published to npm; everything else compiles into its one bundle file. `yarn run publish:dry` rehearses a release and `yarn run publish` runs it: both write the published manifest into the tarball with the exact npm versions in `octocodeRelease`, add this repository's `docs/` as `docs/project/` without internal reviews and audits, install that tarball from npm and run a real session against a scripted model, and refuse to publish if anything fails. Local packaging converts `link:` and `file:` dependencies to absolute `file:` references in disposable artifacts, preserving the development manifests. These artifacts still depend on the sibling checkout and are not portable releases.

## Validate a registry release candidate

Development keeps the three sibling `link:` dependencies. A registry candidate uses a separate staging command after `yarn run build:offline`; it does not rewrite development manifests or publish packages. Supply a reviewed JSON mapping with `schemaVersion: 1` and a `packages` object keyed by dependency name. Each mapped sibling package must have an exact `version`, its `sourceRevision`, and the registry's `sha512-…` `integrity`. Include reviewed native platform packages and other sibling transitive candidates in the mapping as applicable. Prepare candidate tarballs first, then seed a disposable registry with those exact tarballs and the reviewed sibling/platform tarballs; the verification phase will check the complete registry graph.

```sh
node scripts/stage-registry-release.mjs \
  --prepare \
  --map /path/to/reviewed-release-map.json \
  --registry http://127.0.0.1:4873/ \
  --out /tmp/octocode-registry-candidate

# After the registry serves the exact candidate and reviewed dependency tarballs:
node scripts/stage-registry-release.mjs \
  --verify \
  --map /path/to/reviewed-release-map.json \
  --registry http://127.0.0.1:4873/ \
  --out /tmp/octocode-registry-candidate
```

Preparation saves tarballs, their checksums and the mapping digest in `candidate.json`. Verification preserves these bytes on failure, checks registry metadata and resolved integrities, creates a dedicated npm installer lock under the output directory, then installs the **single** staged coding-agent tarball in a clean consumer without workspace overrides. It checks both CLI entries, every public entry's imports, roles, research skills, hydrated model data and native/research `--help` paths with isolated configuration. A candidate validated against a disposable registry is not a production installer lock; rerun `--verify` with `--registry https://registry.npmjs.org/` on the **same prepared tarballs** after the identical dependency tarballs are published. Verification discards any prior fixture lock and resolves afresh. Before promoting the coding-agent package, the verified production installer lock must be reviewed and copied through the release process; this command does not publish or alter the development install-lock directory. The generator refuses to write a fixture lock to the production installer-lock directory. Validate supported OS/CPU/libc variants separately so their optional native binaries are actually loaded. The existing `yarn run check:package-install` exercises the local multi-tarball development graph instead.

## Documentation

- [Every feature, with its owner and documentation](docs/FEATURES.md)
- [User documentation index](packages/coding-agent/docs/index.md)
- [Agent guide and runtime references](packages/coding-agent/README.md)
- [How to: short recipes for common tasks](packages/coding-agent/docs/how-to.md)
- [Native features and extension migration](packages/coding-agent/docs/native-features.md)
- [Configuration locations and controls](CONFIGURATIONS.md)
- [Running Octocode inside tmux](packages/coding-agent/docs/tmux.md)
- [Add hooks and plugins](PLUGINS.md)
- [Configuration and Pi compatibility](packages/coding-agent/docs/configuration.md)
- [Agent instructions](packages/coding-agent/docs/instructions.md)
- [Development guidance](AGENTS.md)
- [Security boundaries](SECURITY.md)

## Packages

| Directory                                       | Responsibility                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------- |
| [coding-agent](packages/coding-agent/README.md) | CLI, sessions and native Octocode features; RPC                      |
| [acp](packages/acp/README.md)                   | Private inbound/outbound ACP integration, compiled into coding-agent |
| [mcp](packages/mcp/README.md)                   | Private MCP client and host integration, compiled into coding-agent  |
| [agent](packages/agent/README.md)               | Agent loop and tool execution                                        |
| [ai](packages/ai/README.md)                     | Provider APIs and model catalog                                      |
| [tui](packages/tui/README.md)                   | Terminal UI                                                          |
| [webview](packages/webview/README.md)           | Browser workspace, board, Markdown/code rendering and UI state       |
| [contracts](packages/contracts/README.md)       | Shared entity contracts, schemas and workspace protocols             |
| [telemetry](packages/telemetry/README.md)       | Telemetry contracts and adapters                                     |
| [db](packages/db/README.md)                     | Private agent database: schema, connections, queries and retention   |
| [common](packages/common/README.md)             | Private host-free utilities, compiled into coding-agent              |

## Development

```sh
yarn run check
./test.sh
```

`check` runs TypeScript, Oxlint, the format check, browser imports, workspace bundle and favicon freshness, the package and database boundary checks and Knip, without rewriting files. `test.sh` runs the tests with isolated configuration and credentials. See [AGENTS.md](AGENTS.md) for focused checks and generated files, [scripts/README.md](scripts/README.md) for what each repository script does, and the [coding-agent suite rules](packages/coding-agent/test/suite/README.md) for harness-based session tests. The historical `octocode-test.sh` launcher runs the agent from source; it is not a test suite.

Run `yarn run check:unused` (Knip) from the root to inspect unused files, exports and dependencies across all workspaces. [knip.jsonc](knip.jsonc) identifies public APIs, dynamically loaded entrypoints, copied vendor assets and external system commands. Verify findings against those consumers before removing code; the package root exports only the CLI and RPC surface.

## License

[MIT](LICENSE). This is an independent fork; original Pi copyright notices are retained.
