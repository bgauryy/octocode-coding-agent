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

Hydration downloads the provider model catalog. Use `/login` to connect a provider, then enter a task. `npm start -- --help` lists CLI options; `/help` lists the native feature commands. For compiled artifacts, run `npm run build:offline` after hydration.

The package name is `@octocodeai/octocodecode`, and its agent executable is `octocode`. The research and native executables are available without name collisions through:

```sh
npm start -- research --help
npm start -- native --help
```

Local dependencies make this a development checkout. Publication is blocked while they remain configured; locally packed artifacts depend on the sibling checkout and are not portable releases.

## Documentation

- [Documentation index](packages/coding-agent/docs/index.md)
- [Agent guide and runtime references](packages/coding-agent/README.md)
- [Native features and extension migration](packages/coding-agent/docs/native-features.md)
- [Configuration locations and controls](CONFIGURATIONS.md)
- [Configuration and Pi compatibility](packages/coding-agent/docs/configuration.md)
- [Agent instructions](packages/coding-agent/docs/instructions.md)
- [Development guidance](AGENTS.md)
- [Security boundaries](SECURITY.md)

## Packages

| Directory | Responsibility |
| --- | --- |
| [coding-agent](packages/coding-agent/README.md) | CLI, sessions, native Octocode features and SDK |
| [agent](packages/agent/README.md) | Agent loop and tool execution |
| [ai](packages/ai/README.md) | Provider APIs and model catalog |
| [tui](packages/tui/README.md) | Terminal UI |
| [webview](packages/webview/README.md) | Browser workspace, board, Markdown/code rendering and UI state |
| [contacts](packages/contacts/README.md) | Shared entity contracts, schemas and workspace protocols |
| [mcp](packages/mcp/README.md) | MCP client |
| [telemetry](packages/telemetry/README.md) | Telemetry contracts and adapters |

## Development

```sh
npm run check
./test.sh
```

`check` runs TypeScript, browser imports, workspace bundle freshness and package-boundary checks without rewriting files. `test.sh` runs the tests with isolated configuration and credentials. See [AGENTS.md](AGENTS.md) for focused checks and generated files. The historical `octocode-test.sh` launcher runs the agent from source; it is not a test suite.

## License

[MIT](LICENSE). This is an independent fork; original Pi copyright notices are retained.
