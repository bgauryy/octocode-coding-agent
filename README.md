# octocode-code

octocode-code is a coding agent forked from [Pi](https://github.com/earendil-works/pi). It combines Pi's agent loop, provider integrations and terminal UI with native Octocode features for code research, guarded file changes, subagents, collaboration, browser work, memory and session recovery.

These features originated in `packages/octocode-pi-extension` in the sibling `octocode` repository. Their implementation now lives in [packages/coding-agent/src/octocode](packages/coding-agent/src/octocode/); this fork loads it automatically. Installing the original extension is unnecessary.

## Run from source

Use Node.js 24.15 or newer **within Node 24**: the sibling Octocode dependencies currently require `^24.15.0`. This checkout depends on built packages at `../octocode/packages/octocode`, `../octocode/packages/octocode-mcp` and `../octocode/packages/octocode-native`, including their CLI artifacts and native platform binaries.

From this repository's root:

```sh
npm install --ignore-scripts
npm run hydrate:model-data
npm start
```

Hydration downloads the provider model catalog. Use `/login` to connect a provider, then enter a task. `npm start -- --help` lists CLI options; `/octocode help` lists the native feature commands. For compiled artifacts, run `npm run build:offline` after hydration.

The package name is `@octocodeai/octocodecode`, and its agent executable is `octocode`. The research and native executables are available without name collisions through:

```sh
npm start -- research --help
npm start -- native --help
```

Local dependencies make this a development checkout. Publication is blocked while they remain configured; locally packed artifacts depend on the sibling checkout and are not portable releases.

## Documentation

- [Agent guide and runtime references](packages/coding-agent/README.md)
- [Native features and extension migration](packages/coding-agent/docs/native-features.md)
- [Configuration and Pi compatibility](packages/coding-agent/docs/configuration.md)
- [Agent instructions](packages/coding-agent/docs/instructions.md)
- [Development guidance](AGENTS.md)
- [Security boundaries](SECURITY.md)

## Packages

| Directory | Responsibility |
| --- | --- |
| `packages/coding-agent` | CLI, sessions, native Octocode features and SDK |
| `packages/agent` | Agent loop and tool execution |
| `packages/ai` | Provider APIs and model catalog |
| `packages/tui` | Terminal UI |
| `packages/mcp` | MCP client |
| `packages/codemode` | JavaScript tool sandbox |
| `packages/telemetry` | Telemetry contracts and adapters |

## Development

```sh
npm run check
./test.sh
```

`check` runs TypeScript and browser import checks without rewriting files. `test.sh` runs the tests with isolated configuration and credentials. See [AGENTS.md](AGENTS.md) for focused checks and generated files. The historical `octocode-test.sh` launcher runs the agent from source; it is not a test suite.

## License

[MIT](LICENSE). This is an independent fork; original Pi copyright notices are retained.
