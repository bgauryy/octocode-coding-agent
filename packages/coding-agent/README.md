# octocode-code agent

The CLI and SDK for [octocode-code](../../README.md), a fork of [Pi](https://github.com/earendil-works/pi) with the former Octocode Pi extension integrated into the runtime.

Follow the [root setup instructions](../../README.md#run-from-source) for prerequisites and development commands. The package is `@octocodeai/octocodecode`; its executables are `octocode` and `octocode-api`. Registry publication is blocked while local sibling dependencies are configured.

## Native features

Native sessions read source files through Octocode MCP local tools, use `file` for guarded writes, edits and deletions, and `bash` for shell commands and background jobs. The unified `agent` tool handles delegation, external agents and team communication. `web` provides search and retrieval; the `browser` specialist handles browser interaction. Native features also include checkpoints, memory, backlog, hooks and session recovery. Run `/help` to discover commands available in the current session.

Native sessions do not register separate `read`, `edit`, `write`, `grep`, `find`, `ls` or `powershell` tools. PowerShell uses `bash` with `type: "powershell"`. Low-level SDK factories remain available to custom runtimes that disable native features; third-party extensions can register their own tools.

See [native features](docs/native-features.md) for ownership and migration details and the [documentation index](docs/index.md) for configuration, providers, extensions and embedding.

## Command hints

In the terminal editor, type a command and a space to see its available values. Tab accepts a suggestion; command and nested-command completions ending with a space show the next choices immediately. Arrow keys select an option and Escape dismisses hints. Tab reopens them. Free text stays free text; import and export offer file paths.

The installed `octocode` and `octocode-api` commands can also provide shell completions. Run the setup for your shell; add these lines to its startup file to keep them enabled:

```bash
# Bash
source <(octocode completion bash)
source <(octocode-api completion bash)
```

```zsh
# Zsh (after compinit, if your shell framework already initializes it)
autoload -Uz compinit && compinit
source <(octocode completion zsh)
source <(octocode-api completion zsh)
```

```fish
# Fish
octocode completion fish | source
octocode-api completion fish | source
```

Shell hints cover built-in flags, enum values, bundled model/provider names, configured MCP servers and resource paths. API hints also include running session IDs and watch event types. Completion does not start agents, connect to providers, or load extension code. Extension-defined flags and delegated `research`/`native` commands are outside these completion lists; arbitrary text, URLs and credentials have no fixed option list.

## Configuration

[CONFIGURATIONS.md](../../CONFIGURATIONS.md) maps global and workspace settings for skills, MCP, models, prompts, extensions and agents. `/mcp config` shows the active locations and trust state; `/mcp tools [server] [tool]` inspects tool names, descriptions and schemas. `/mcp enable <server>` and `/mcp disable <server>` control configured servers; add `--local` for a trusted workspace override. `/status` lists loaded skills and MCP connections. See the [MCP guide](docs/mcp.md) for automatic Octocode ownership, exposure and shell commands.

## Session API

Enable the local API from the repository root:

```sh
OCTOCODE_API=1 yarn start
```

In another terminal:

```sh
node packages/coding-agent/src/octocode/api/cli.ts list
node packages/coding-agent/src/octocode/api/cli.ts status --to <id>
```

Installed builds expose the same commands through `octocode-api`. Within the agent, `/api on` and `/api off` control the API. See [environment variables](docs/environment-variables.md) for opt-in transport settings.

The native SDK supports one active `AgentSession` per process. Sequential CLI/RPC reloads are supported; concurrent native sessions share session and database state and are not isolated.

MIT; original Pi copyright notices are retained in [LICENSE](../../LICENSE).
