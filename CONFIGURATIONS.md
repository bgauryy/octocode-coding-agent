# Configurations

Use `~/.octocode/octocodecode/` for your global configuration and `.octocode/` for workspace configuration. Start Octocode in the workspace you want to configure. Run `/mcp config` to see the exact MCP paths, their read order, and whether workspace files are trusted.

`OCTOCODE_HOME` changes the shared configuration and runtime home. `OCTOCODE_CODING_AGENT_DIR` changes only the core configuration directory; native runtime files keep their own home. Explicit home overrides and custom SDK agent directories disable automatic Pi configuration fallback. See [configuration and compatibility](packages/coding-agent/docs/configuration.md).

## Where each configuration belongs

In this table, **global** means `~/.octocode/octocodecode/` unless overridden. Core workspace files are relative to the session's working directory. Native agent profiles and hooks use the repository root, including when you start from a subdirectory.

| Configure | Global location | Workspace location | Inspect or apply |
| --- | --- | --- | --- |
| General settings and default model selection | `settings.json` | `.octocode/settings.json` | `/settings`; `/reload` after file edits |
| MCP servers and tool exposure | `mcp.json` | `.octocode/mcp.json` | `/mcp`, `/mcp config`, `/mcp tools` |
| Providers, endpoints and model definitions | `models.json` | No automatically loaded workspace `models.json`; select a configured model in workspace settings | `/model` reloads model definitions; `/models` manages catalog and routing |
| Provider sign-in and API keys | `auth.json` | No workspace credential file | `/login`, `/logout` |
| MCP OAuth tokens | `mcp-auth.json` | No workspace token file | `/mcp login <server>`, `/mcp logout <server>` |
| Skills | `skills/<name>/SKILL.md`; also `~/.agents/skills/` | `.octocode/skills/<name>/SKILL.md`; also `.agents/skills/` | `/skills`, `/status`, `/reload` |
| Prompt templates | `prompts/*.md` | `.octocode/prompts/*.md` | `/help`, `/reload` |
| Extensions | `extensions/` | `.octocode/extensions/` | `/reload`; load diagnostics report conflicts |
| Local plugins | `plugins` entries in `settings.json` | `plugins` entries in trusted `.octocode/settings.json` | `/reload`; see [plugin component review](packages/coding-agent/docs/plugins.md) |
| Themes | `themes/*.json` | `.octocode/themes/*.json` | `/settings` → Theme |
| Keyboard shortcuts | `keybindings.json` | No workspace keybindings file | `/keys`, `/reload` |
| Base/additional system instructions | `SYSTEM.md`, `APPEND_SYSTEM.md` | `.octocode/SYSTEM.md`, `.octocode/APPEND_SYSTEM.md` | `/reload`; trusted workspace file takes precedence |
| Project instructions | `AGENTS.md` in the agent directory | `AGENTS.md` in the project and its ancestors | `/reload`; see [instruction loading](packages/coding-agent/docs/instructions.md) |
| Specialist agent profiles | `agents/*.md` | `.octocode/agents/*.md` at the repository root | `/agents`, `/reload` |
| Native command hooks | `hooks.json` in the runtime home | `.octocode/hooks.json` at the repository root | `/hooks`, `/reload` |

Trusted workspace settings override global settings. Objects merge recursively; arrays replace rather than append. Resource settings such as `skills`, `extensions`, `prompts`, and `themes` support additional paths and selection patterns through their loaders. [Settings schema](packages/coding-agent/schemas/settings.schema.json) lists the supported fields.

Settings, MCP configuration, and project trust saves replace the target file atomically, so a concurrent reader sees a complete old or new document. Settings saves also lock the read–merge–write operation, including first creation, so cooperating writers preserve each other's unrelated changes. An empty settings file or one whose root is not a JSON object is reported as invalid and is not overwritten by a settings change, including when the file becomes invalid after startup; repair the file, then run `/reload`.

Project resources require project trust, except project instruction files such as `AGENTS.md`, which load as text (see [instruction loading](packages/coding-agent/docs/instructions.md#user-instructions-and-subagent-roles)). `/trust` offers project resource trust and native configuration trust; these remain separate controls. Native hooks also read a documented subset of Claude/Codex JSON hook files; enable execution at startup with `OCTOCODE_HOOKS=1`. Adding `OCTOCODE_HOOKS_COMPAT=1` selects partial source-specific protocols and Codex TOML discovery. That compatibility flag also enables the [Claude permission-rule preview](packages/coding-agent/docs/permissions.md), independently of hook execution. `/hooks` inspects configuration rather than toggling it. See [command hooks](packages/coding-agent/docs/hooks.md) for discovery, trust, disable behavior and supported events. See [native features](packages/coding-agent/docs/native-features.md) and [instructions](packages/coding-agent/docs/instructions.md) for their behavior.

## Manage MCP servers

| Task | In an Octocode session | From a shell |
| --- | --- | --- |
| Open the manager | `/mcp` | — |
| Show connection state | `/mcp list` | `octocode mcp list` |
| Show configuration locations | `/mcp config` | `octocode mcp config` |
| List tools | `/mcp tools` or `/mcp tools <server>` | `octocode mcp tools [server]` |
| Inspect a tool's description and input schema | `/mcp tools <server> <tool>` | `octocode mcp tools <server> <tool>` |
| Enable / disable a server | `/mcp enable <server>` / `/mcp disable <server>` | `octocode mcp enable <server>` / `octocode mcp disable <server>` |
| Change tool exposure | `/mcp exposure <server> deferred` | `octocode mcp exposure <server> deferred` |
| Reconnect | `/mcp reconnect <server>` | `octocode mcp list` checks a fresh connection |
| Sign in / out | `/mcp login <server>` / `/mcp logout <server>` | `octocode mcp login <server>` / `octocode mcp logout <server>` |
| Add / remove a definition | Edit the file shown by `/mcp config`, then `/reload` | `octocode mcp add …` / `octocode mcp remove <server>` |

Add `--local` to enable, disable, or change exposure in a **trusted workspace**. Without it, an existing workspace definition or override remains the save target; otherwise global changes save to the canonical global file. The manager shows the exact target before you choose an action. Shell `add` and `remove` target the global native file by default, or the workspace native file with `--local`.

Enablement defaults to **true**. Disabling keeps the definition, stops its connection, and removes its callable tools. Exposure defaults to **auto**: small catalogs are declared directly. The combined eligible catalogs of configured servers, estimated at 10% or more of the selected model’s input space after its output reserve, cause automatic tools to be deferred when the provider supports native tool loading and discovery is available; otherwise tools remain direct. Deferred tools are discovered with `tool_search` and then called directly; `direct` declares them immediately; `hidden` prevents calls while leaving the server connected. A `toolExposure` map can override individual tools. Legacy `codemode` exposure values load as `deferred`. Stdio definitions accept `inheritEnv: false` to pass only explicitly configured environment variables; command and arguments work with binaries, Python, Node, and container launchers. See the [MCP reference](packages/coding-agent/docs/mcp.md#control-tool-exposure).

`/mcp tools` inspects the current connection snapshot without invoking tools or enabling disconnected servers. In the manager, select **Tools**, then a tool to inspect its complete description and input schema. The shell tool-list command connects enabled configured servers; selecting one server avoids connecting the others. `list`, `tools`, and `config` support `--json` in the shell.

The automatic Octocode research server is visible in session status and tool listings. `/mcp reconnect octocode`, or the model's [`mcp` tool](packages/coding-agent/docs/mcp.md#let-the-model-manage-servers), restarts it. Its local research tools (`localFetch`, `localSearch`, `structureSearch`, `astSearch`, `lspSearch`) are declared to the model and its GitHub and package tools load through `tool_search` when it is available; an explicit `octocode` entry in `mcp.json` gets the same split unless it sets `exposure` or `toolExposure`. Persistent enablement/exposure controls require an explicit `octocode` transport entry in `mcp.json`; a control-only entry has nothing to override when no configured transport exists. `OCTOCODE_MCP=0` turns off automatic startup. Shell MCP commands inspect configured servers and do not load native extensions.

After changing files or using shell configuration commands, run `/reload` in existing sessions. Session `/mcp` enable/disable/exposure actions apply immediately. Cached catalogs contain tool descriptions, schemas and server instructions in memory; disabling or disconnecting withdraws them, and reconnecting refreshes them.

### MCP precedence

With the default home, global files are read from lowest to highest priority:

1. `~/.pi/mcp.json`
2. `~/.pi/agent/mcp.json`
3. `~/.octocode/mcp.json`
4. `~/.octocode/agent/mcp.json`
5. `~/.octocode/octocodecode/mcp.json`

Trusted workspace files then apply in this order: `.pi/mcp.json`, `.mcp.json`, `.agents/mcp.json`, `.octocode/mcp.json`. Each path is relative to the session directory. A later transport definition replaces the earlier server with the same name; a later control-only entry changes enablement or exposure without copying credentials. `/mcp config` shows the actual paths when your home is overridden.

For example, after defining `docs` globally, this workspace `.octocode/mcp.json` disables it only for that workspace:

```json
{
  "mcpServers": {
    "docs": { "enabled": false }
  }
}
```

Removing an override can reveal an inherited server again. Use disable when you want an inherited server to remain off. [MCP configuration](packages/coding-agent/docs/mcp.md#configure-servers) owns the complete transport, authentication and override rules.

## Skills and prompts

Put a skill's instructions in `<name>/SKILL.md`, with `name` and `description` frontmatter. Configured, project, user, and Pi fallback skills take precedence over bundled defaults. Shared `~/.agents/skills/` and project `.agents/skills/` directories are supported, and from a subdirectory the repository root's `.octocode/skills/` is a project folder too; project ancestor discovery stops at the repository root. Native sessions also load `~/.claude/skills/` (without `synced/`), `$CODEX_HOME/skills/` and, in a trusted project, `.claude/skills/` up to the repository root; these load after the folders above, and `skills` patterns apply to them too. `/status` lists loaded skill paths and MCP connection status, while `/skills` offers a searchable picker.

Use `skills` patterns in settings to exclude or include discoveries, for example `"skills": ["!octocode-roast"]`. `--no-skills` disables automatic discovery. Setting `enableSkillCommands` to `false` hides autocomplete suggestions; it does **not** disable skills. See [skills](packages/coding-agent/docs/skills.md) for invocation, priority, bundled skills and access through Octocode local tools.

Prompt templates are Markdown files in `prompts/`. Skills and prompts get direct slash names when unambiguous, with `/skill:<name>` and `/prompt:<name>` fallbacks for collisions. See [prompt templates](packages/coding-agent/docs/prompt-templates.md), [extensions](packages/coding-agent/docs/extensions.md), and [packages](packages/coding-agent/docs/packages.md) for additional resource locations.

## Models and credentials

Use `/login` for provider access, `/model` to select a model, `/effort` to choose reasoning effort, and `/models` for model cycling, catalog and routing. Put custom endpoints and model definitions in the global `models.json`; the [models guide](packages/coding-agent/docs/models.md) has examples and the [models configuration reference](packages/coding-agent/docs/models-configuration.md) describes each field.

Default selection uses `defaultProvider` and `defaultModel` in settings. Authentication lives in global `auth.json` or environment variables; MCP OAuth uses the separate global `mcp-auth.json`. Keep credentials out of shared workspace files. Provider/model settings can select cache retention; paid cache warming is controlled by global settings. See [providers](packages/coding-agent/docs/providers.md), [environment variables](packages/coding-agent/docs/environment-variables.md), and [prompt caching](packages/coding-agent/docs/prompt-caching.md).

Pi settings and provider definitions are fallback inputs when using the default home; native values take precedence and writes go to Octocode files. Pi authentication and trust decisions are not imported. Details and historical migrations remain in [configuration and compatibility](packages/coding-agent/docs/configuration.md).
