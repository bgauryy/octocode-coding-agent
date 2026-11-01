# octocode-code agent

The CLI and SDK for [octocode-code](../../README.md), a fork of [Pi](https://github.com/earendil-works/pi) with the former Octocode Pi extension integrated into the runtime.

Follow the [root setup instructions](../../README.md#run-from-source) for prerequisites and development commands. The package is `@octocodeai/octocodecode`; its executables are `octocode` and `octocode-api`. Registry publication is blocked while local sibling dependencies are configured.

## Native features

Native sessions read source files through Octocode MCP local tools, use `file` for guarded writes, edits and deletions, and `bash` for shell commands and background jobs. The unified `agent` tool handles delegation, external agents and team communication. `web` provides search and retrieval; the `browser` specialist handles browser interaction. Native features also include checkpoints, memory, backlog, hooks and session recovery. Run `/help` to discover commands available in the current session.

Octocode ships no separate `read`, `edit`, `write`, `grep`, `find`, `ls` or `powershell` tools. PowerShell uses `bash` with `type: "powershell"`. The only core tool, and the only SDK tool factory, is `bash` (`createBashTool()` and `createBashToolDefinition()`); third-party extensions and SDK callers register their own tools.

See [native features](docs/native-features.md) for ownership and migration details and the [documentation index](docs/index.md) for configuration, providers, extensions and embedding.

## Command hints

Use `/login` to connect an AI account or API key, manage saved credentials, or import Pi configuration. `/model` selects the model for this chat; `/modelsettings` manages model shortcuts, catalog details and agent routing. `/effort` changes reasoning effort and `/context size` selects a session context budget. `/github` connects code-search access separately from AI providers.

Each command has one name: start over with `/new` (or its equivalents `/clear` and `/reset`), leave with `/quit`, and open settings with `/settings`. Session workflows include `/btw`, `/compact [instructions]`, `/context`, `/diff` and native `/plan`. The [complete command reference](docs/commands.md) lists all built-in commands, bundled skills, command operations and shell entry points.

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

## Running inside tmux

Octocode detects tmux and adapts, so keys, links, notifications, images and forks keep working in a multiplexer. Most of it needs no setup:

- Shift+Enter and other modified keys, with a startup warning when `extended-keys` is off
- Multi-line paste, including control keys tmux re-encodes
- Mouse tracking that does not flood tmux
- Clickable links, when your terminal reports hyperlink support
- "Answer ready" notifications for Kitty, iTerm2, Ghostty and WezTerm, with a bell fallback
- Kitty images in Kitty and Ghostty, re-sent when a terminal reattaches
- Synchronized-output renewal so long redraws do not tear
- `/fork pane`, `/fork pane down` and `/fork window` to open a fork beside the current session

Octocode only reads your tmux options and never changes them. For the full feature set, add these to `~/.tmux.conf`:

```tmux
set -g extended-keys on
set -g allow-passthrough on
set -g focus-events on
set -as terminal-features ',*:hyperlinks'
set -as terminal-features ',*:RGB'
```

See [Running Octocode inside tmux](docs/tmux.md) for what each option unlocks, limits, troubleshooting and checks.

## Configuration

[CONFIGURATIONS.md](../../CONFIGURATIONS.md) maps global and workspace settings for skills, MCP, models, prompts, extensions and agents. `/mcp config` shows the active locations and trust state; `/mcp tools [server] [tool]` inspects tool names, descriptions and schemas. `/mcp enable <server>` and `/mcp disable <server>` control configured servers; add `--local` for a trusted workspace override. `/status` lists loaded skills and MCP connections. See the [MCP guide](docs/mcp.md) for the default Octocode preset, exposure and shell commands.

## Session API

Enable the local API from the repository root:

```sh
OCTOCODE_API=1 yarn start
```

In another terminal:

```sh
yarn node packages/coding-agent/src/octocode/api/cli.ts list
yarn node packages/coding-agent/src/octocode/api/cli.ts status --to <id>
yarn node packages/coding-agent/src/octocode/api/cli.ts send --to <id> --wait -- "Reply with ACK."
```

Installed builds expose the same commands through `octocode-api`. Within the agent, `/api on` and `/api off` control the API. See the [local session API guide](docs/session-api.md) for session guards, message keys, event watching, external peers and runnable checks, and [environment variables](docs/environment-variables.md) for opt-in transport settings.

The native SDK supports one active `AgentSession` per process. Sequential CLI/RPC reloads are supported; concurrent native sessions share session and database state and are not isolated.

For an existing session, `getApplicationPort(session)` returns the shared application service. Its `getSnapshot()` and `subscribeState(listener)` methods expose copied runtime snapshots through the `ApplicationStateSource` contract. Read once for the initial value, then unsubscribe when the view closes. The service's Zustand vanilla store also supplies terminal semantic events and serialized web snapshots. Commands still pass through the service and execution owners. See [interface architecture](../../docs/INTERFACE_ARCHITECTURE.md#runtime-state-and-database-ownership) for state lifetimes and [runtime storage](docs/configuration.md#runtime-storage) for persistence.

MIT; original Pi copyright notices are retained in [LICENSE](../../LICENSE).
