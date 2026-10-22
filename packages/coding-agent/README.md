# octocode-code agent

The CLI and SDK for [octocode-code](../../README.md), a fork of [Pi](https://github.com/earendil-works/pi) with the former Octocode Pi extension integrated into the runtime.

Follow the [root setup instructions](../../README.md#run-from-source) for prerequisites and development commands. The package is `@octocodeai/octocodecode`; its executables are `octocode` and `octocode-api`. Registry publication is blocked while local sibling dependencies are configured.

## Native features

Native sessions use `read` for files and images, `file` for guarded writes, edits and deletions, and `bash` for commands and background jobs. They also provide code research through Octocode MCP, subagents and collaboration, web and browser tools, checkpoints, memory, backlog, hooks and session recovery. Run `/octocode help` to discover commands available in the current session.

Native sessions do not register separate `edit`, `write`, `grep`, `find` or `ls` tools. Low-level SDK factories remain available to custom runtimes that disable native features; third-party extensions can register their own tools.

See [native features](docs/native-features.md) for ownership and migration details and the [documentation index](docs/index.md) for configuration, providers, extensions and embedding.

## Session API

Enable the local API from the repository root:

```sh
OCTOCODE_API=1 npm start
```

In another terminal:

```sh
node packages/coding-agent/src/octocode/api/cli.ts list
node packages/coding-agent/src/octocode/api/cli.ts status --to <id>
```

Installed builds expose the same commands through `octocode-api`. Within the agent, `/octocode api on` and `/octocode api off` control the API. See [environment variables](docs/environment-variables.md) for opt-in transport settings.

The native SDK supports one active `AgentSession` per process. Sequential CLI/RPC reloads are supported; concurrent native sessions share session and database state and are not isolated.

MIT; original Pi copyright notices are retained in [LICENSE](../../LICENSE).
