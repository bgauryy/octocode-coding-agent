# Configurations

Use `~/.octocode/octocodecode/` for global core configuration and `.octocode/` for workspace configuration. MCP definitions are the exception: the canonical global file is `~/.octocode/mcp.json`, and the canonical workspace file is `.octocode/mcp.json`. Start Octocode in the workspace you want to configure. Run `/mcp config` to see the exact MCP paths, their read order, and whether workspace files are trusted.

`OCTOCODE_HOME` changes the shared configuration and runtime home. `OCTOCODE_CODING_AGENT_DIR` changes only the core configuration directory; native runtime files keep their own home. Explicit home overrides and custom SDK agent directories disable automatic Pi configuration fallback. See [configuration and compatibility](packages/coding-agent/docs/configuration.md).

`OCTOCODE_AGENT_DB` selects the native SQLite file. Shared connections are keyed by canonical path and remain open until process cleanup; selecting another file does not close existing borrowers. Interface runtime state stays in memory. See [runtime storage](packages/coding-agent/docs/configuration.md#runtime-storage) for the database and file boundaries.

## Where each configuration belongs

In this table, **global** means `~/.octocode/octocodecode/` unless overridden. Core workspace files are relative to the session's working directory. Native agent profiles and hooks use the repository root, including when you start from a subdirectory.

| Configure                                    | Global location                                                                 | Workspace location                                                                               | Inspect or apply                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| General settings and default model selection | `settings.json`                                                                 | `.octocode/settings.json`                                                                        | `/settings`; `/reload` after file edits                                                |
| MCP servers and tool exposure                | `~/.octocode/mcp.json`                                                          | `.octocode/mcp.json`                                                                             | `/mcp`, `/mcp config`, `/mcp tools`                                                    |
| Providers, endpoints and model definitions   | `models.json`                                                                   | No automatically loaded workspace `models.json`; select a configured model in workspace settings | `/model` reloads model definitions; `/modelsettings` manages catalog and routing       |
| Provider sign-in and API keys                | `auth.json`                                                                     | No workspace credential file                                                                     | `/providers` (`/login`), `/logout`                                                     |
| MCP OAuth tokens                             | `mcp-auth.json`                                                                 | No workspace token file                                                                          | `/mcp login <server>`, `/mcp logout <server>`                                          |
| GitHub sign-in for Octocode research         | Saved by the native Octocode CLI in Octocode's home and the OS credential store | No workspace credential file                                                                     | `/github`, `/github login`, `/github logout`; `octocode native auth status` in a shell |
| Skills                                       | `skills/<name>/SKILL.md`; also `~/.agents/skills/`                              | `.octocode/skills/<name>/SKILL.md`; also `.agents/skills/`                                       | `/skills`, `/skills info <name>`, `/skills enable <name>`, `/skills disable <name>`    |
| Prompt templates                             | `prompts/*.md`                                                                  | `.octocode/prompts/*.md`                                                                         | `/help`, `/reload`                                                                     |
| Extensions                                   | `extensions/`                                                                   | `.octocode/extensions/`                                                                          | `/reload`; load diagnostics report conflicts                                           |
| Local plugins                                | `plugins` entries in `settings.json`                                            | `plugins` entries in trusted `.octocode/settings.json`                                           | `/reload`; see [plugin component review](packages/coding-agent/docs/plugins.md)        |
| Themes                                       | `themes/*.json`                                                                 | `.octocode/themes/*.json`                                                                        | `/settings` → Theme                                                                    |
| Keyboard shortcuts                           | `keybindings.json`                                                              | No workspace keybindings file                                                                    | `/keys`, `/reload`                                                                     |
| Base/additional system instructions          | `SYSTEM.md`, `APPEND_SYSTEM.md`                                                 | `.octocode/SYSTEM.md`, `.octocode/APPEND_SYSTEM.md`                                              | `/reload`; trusted workspace file takes precedence                                     |
| Project instructions                         | `AGENTS.md` in the agent directory                                              | `AGENTS.md` in the project and its ancestors                                                     | `/reload`; see [instruction loading](packages/coding-agent/docs/instructions.md)       |
| Specialist agent profiles                    | `agents/*.md`                                                                   | `.octocode/agents/*.md` at the repository root                                                   | `/agents`, `/reload`                                                                   |
| Native command hooks                         | `hooks.json` in the runtime home                                                | `.octocode/hooks.json` at the repository root                                                    | `/hooks`, `/reload`                                                                    |

Trusted workspace settings override global settings. Objects merge recursively; arrays replace rather than append. Resource settings such as `skills`, `extensions`, `prompts`, and `themes` support additional paths and selection patterns through their loaders. The [settings reference](packages/coding-agent/docs/settings.md) lists every field with its default, including trust, telemetry, proxy and shell settings; the [settings schema](packages/coding-agent/schemas/settings.schema.json) validates them. Non-interactive modes are described in [CLI modes](packages/coding-agent/docs/cli.md) and [RPC mode](packages/coding-agent/docs/rpc.md).

Run `octocode config` to select built-in extensions as well as installed resources. Built-in names and enable/disable settings are described in [built-in features](packages/coding-agent/docs/configuration.md#built-in-features).

`/octocode` opens the local web workspace for the current session. Its private server registry is stored in `workspace-web/` beside the configured agent database and keyed by repository and session. Different sessions share repository entities in the database while keeping their live controls separate. See [the backlog view](packages/coding-agent/docs/native-features.md#backlog-view) for concurrent editing and reconnect behavior.

Inline terminal images use `terminal.showImages`, `terminal.images`, and `terminal.imageWidthCells`; automatic capability detection and explicit overrides are described in [terminal images](packages/coding-agent/docs/configuration.md#terminal-images).

Set `terminal.reduceMotion` to `true`, `false` or `"auto"` to freeze terminal animation; `"auto"` follows the `OCTOCODE_REDUCE_MOTION` environment variable (see [reduced motion](packages/coding-agent/docs/configuration.md#reduced-motion)).

Settings, MCP configuration, and project trust saves replace the target file atomically, so a concurrent reader sees a complete old or new document. Settings saves also lock the read–merge–write operation, including first creation, so cooperating writers preserve each other's unrelated changes. An empty settings file or one whose root is not a JSON object is reported as invalid and is not overwritten by a settings change, including when the file becomes invalid after startup; repair the file, then run `/reload`.

Project resources require project trust, except project instruction files such as `AGENTS.md`, which load as text (see [instruction loading](packages/coding-agent/docs/instructions.md#user-instructions-and-subagent-roles)). `/trust` offers project resource trust and native configuration trust; these remain separate controls. Native hooks also read a documented subset of Claude/Codex JSON hook files; enable execution at startup with `OCTOCODE_HOOKS=1`. Adding `OCTOCODE_HOOKS_COMPAT=1` selects partial source-specific protocols and Codex TOML discovery. That compatibility flag also enables the [Claude permission-rule preview](packages/coding-agent/docs/permissions.md), independently of hook execution. `/hooks` inspects configuration rather than toggling it. See [command hooks](packages/coding-agent/docs/hooks.md) for discovery, trust, disable behavior and supported events. See [native features](packages/coding-agent/docs/native-features.md) and [instructions](packages/coding-agent/docs/instructions.md) for their behavior.

## Manage MCP servers

| Task                                          | In an Octocode session                               | From a shell                                                     |
| --------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------- |
| Open the manager                              | `/mcp`                                               | —                                                                |
| Show connection state                         | `/mcp list`                                          | `octocode mcp list`                                              |
| Show configuration locations                  | `/mcp config`                                        | `octocode mcp config`                                            |
| List tools                                    | `/mcp tools` or `/mcp tools <server>`                | `octocode mcp tools [server]`                                    |
| Inspect a tool's description and input schema | `/mcp tools <server> <tool>`                         | `octocode mcp tools <server> <tool>`                             |
| Enable / disable a server                     | `/mcp enable <server>` / `/mcp disable <server>`     | `octocode mcp enable <server>` / `octocode mcp disable <server>` |
| Change tool exposure                          | `/mcp exposure <server> deferred`                    | `octocode mcp exposure <server> deferred`                        |
| Reconnect                                     | `/mcp reconnect <server>`                            | `octocode mcp list` checks a fresh connection                    |
| Sign in / out                                 | `/mcp login <server>` / `/mcp logout <server>`       | `octocode mcp login <server>` / `octocode mcp logout <server>`   |
| Add / remove a definition                     | Edit the file shown by `/mcp config`, then `/reload` | `octocode mcp add …` / `octocode mcp remove <server>`            |

Add `--local` to enable, disable, or change exposure in a **trusted workspace**. Without it, an existing workspace definition or override remains the save target; otherwise global changes save to the canonical global file. The manager shows the exact target before you choose an action. Shell `add` and `remove` target the global native file by default, or the workspace native file with `--local`.

Enablement defaults to **true**. Disabling keeps the definition, stops its connection, and removes its callable tools. Exposure defaults to **direct**: connected tools are declared with their full descriptions and input schemas, without a discovery step. Explicit `auto` opts into a catalog-size heuristic; `deferred` loads tools through `tool_search`; `hidden` prevents calls while leaving the server connected. A `toolExposure` map can override individual tools. Existing explicit settings remain effective, and legacy `codemode` exposure values load as `deferred`. See [exposure rules](packages/coding-agent/docs/mcp-reference.md#exposure-and-results).

Stdio servers receive only a minimal environment by default (the MCP SDK allow-list: `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER`; a Windows set on Windows) plus the configured `env`; `inheritEnv: true` passes the whole host environment, tokens included; command and arguments work with binaries, Python, Node, and container launchers.

`/mcp tools` inspects the current connection snapshot without invoking tools or enabling disconnected servers. In the manager, select **Tools**, then a tool to inspect its complete description and input schema. The shell tool-list command connects enabled configured servers; selecting one server avoids connecting the others. `list`, `tools`, and `config` support `--json` in the shell.

Octocode research is the default entry in the shared MCP host registry, implemented by the private [MCP workspace](packages/mcp/README.md). The `octocode` preset supplies launch and tool-presentation defaults; configured and registered servers use the same connection and management paths. `/mcp enable octocode`, `/mcp disable octocode` and `/mcp exposure octocode <mode>` save control-only overrides, so an explicit command is unnecessary. `OCTOCODE_MCP=0` disables the default unless configuration overrides it. The Octocode catalog is direct like other servers, except `ghSearchHistory`, `ghGetHistoryItem`, `clasify`, `artifactSearch` and `ghSearchRepo`, which the preset defers behind `tool_search`. Explicit `exposure` or `toolExposure` settings win (`exposure: "direct"` declares all of them). Shell MCP commands load the same default and configuration. `mcp({ intent: "stop", server: "octocode" })` stops it for this session; only an explicit connect/restart resumes it. The `browser` preset is a second default entry, powered by `@octocodeai/octocode-chrome-devtools`; `/mcp disable browser` saves the same kind of control-only override. See the [MCP reference](packages/coding-agent/docs/mcp.md#host-and-protocol-support) and the [browser preset](packages/coding-agent/docs/mcp-reference.md#configuration-and-precedence).

After changing files or using shell configuration commands, run `/reload` in existing sessions. Session `/mcp` enable/disable/exposure actions apply immediately. The host supports tools only; elicitation, resources and annotations are unsupported. Cached catalogs contain full tool descriptions, schemas and server instructions in memory; disabling or disconnecting withdraws them, and reconnecting refreshes them.

### MCP precedence

With the default home, global files are read from lowest to highest priority:

1. `~/.pi/mcp.json`
2. `~/.pi/agent/mcp.json`
3. `~/.octocode/agent/mcp.json`
4. `~/.octocode/octocodecode/mcp.json` (previous native location, still read)
5. `~/.octocode/mcp.json` (canonical global file)

Trusted workspace files then apply in this order: `.pi/mcp.json`, `.mcp.json`, `.agents/mcp.json`, `.octocode/mcp.json`. Each path is relative to the session directory. A later transport definition replaces the earlier server with the same name; a later control-only entry changes `enabled`, `exposure` or `toolExposure` without copying credentials. `/mcp config` shows the actual paths when your home is overridden. Workspace MCP files load only while `/trust`'s record of their exact content matches: after you add or edit one, its servers stay unloaded until you run `/trust` again. An SDK session loads none unless the host passes `projectTrusted: true`.

For example, after defining `docs` globally, this workspace `.octocode/mcp.json` disables it only for that workspace:

```json
{
	"mcpServers": {
		"docs": { "enabled": false }
	}
}
```

Removing an override can reveal an inherited server again. Use disable when you want an inherited server to remain off. [MCP configuration](packages/coding-agent/docs/mcp.md#configure-servers) owns the complete transport, authentication and override rules.

## ACP clients

An editor can launch `octocode --mode acp` to control Octocode through inbound ACP v1. It uses the normal host credentials, settings, project trust and `OCTOCODE_PERMISSION` policy; no separate ACP configuration file is required. The client supplies each session's working directory. Stdio, Streamable HTTP and legacy SSE MCP definitions supplied with `session/new`, `session/load` or `session/resume` are registered temporarily for that worker through the shared MCP host. Environment and header values are literal; definitions are not written to global or workspace `mcp.json`. In-protocol model or permission-mode changes are not supported. See the [ACP reference](packages/coding-agent/docs/acp.md) for invocation, permissions and session limits.

The native `agent` tool's `type: "external"` / `transport: "acp"` connection is outbound ACP to another agent. `/api` and `octocode-api` expose the separate [local session API](packages/coding-agent/docs/session-api.md).

## Skills and prompts

Put a skill's instructions in `<name>/SKILL.md`, with `name` and `description` frontmatter. The Octocode skills bundled with the build load by default and, on a same-name collision, beat user-level copies the Octocode CLI installed (`~/.agents/skills/`, `~/.claude/skills/`, `$CODEX_HOME/skills/`, `~/.pi/agent/skills/`); `--skill` paths, `skills` settings entries, packages, project `.octocode/skills/` and `.agents/skills/`, and the agent directory's `skills/` beat the bundle. Shared `~/.agents/skills/` and project `.agents/skills/` directories are supported, and from a subdirectory the repository root's `.octocode/skills/` is a project folder too; project ancestor discovery stops at the repository root. Native sessions also load `~/.claude/skills/` (without `synced/`), `$CODEX_HOME/skills/` and, in a trusted project, `.claude/skills/` up to the repository root; these load after the folders above, and `skills` patterns apply to them too. `/status` lists loaded skill paths and MCP connection status, while `/skills` offers a searchable picker.

Use `skills` patterns in settings to exclude or include discoveries, for example `"skills": ["!octocode-roast"]`. `--no-skills` disables automatic discovery. Setting `enableSkillCommands` to `false` hides autocomplete suggestions; it does **not** disable skills. See [skills](packages/coding-agent/docs/skills.md) for invocation, priority, bundled skills and access through Octocode local tools.

Prompt templates are Markdown files in `prompts/`. Skills and prompts get direct slash names when unambiguous, with `/skill:<name>` and `/prompt:<name>` fallbacks for collisions. See [prompt templates](packages/coding-agent/docs/prompt-templates.md), [extensions](packages/coding-agent/docs/extensions.md), and [packages](packages/coding-agent/docs/packages.md) for additional resource locations.

## Models and credentials

Use `/providers` (`/login`) for provider access, `/model` (`/models`) to select a model, `/thinking` (`/effort`) to choose reasoning effort, `/context size` for a session context budget, and `/modelsettings` for model shortcuts, catalog and routing. Put custom endpoints and model definitions in the global `models.json`; the [models guide](packages/coding-agent/docs/models.md) has examples and the [models configuration reference](packages/coding-agent/docs/models-configuration.md) describes each field.

Use `octocode models discover [--provider <id>] [--json]` to compare vendor lists with configured model IDs; `--offline` and `OCTOCODE_OFFLINE=1` use only local definitions. See [vendor model discovery](packages/coding-agent/docs/model-discovery.md). ChatGPT logout retains nonsecret account/client registrations in `auth.json` for returning login while removing tokens; these signed-out records do not mark the provider as configured.

Default selection uses `defaultProvider` and `defaultModel` in settings. Authentication lives in global `auth.json` or environment variables; MCP OAuth uses the separate global `mcp-auth.json`. Gemini recognizes both `GOOGLE_API_KEY` and `GEMINI_API_KEY`, with `GOOGLE_API_KEY` taking precedence; Meta recognizes `META_API_KEY` and the Model API's `MODEL_API_KEY`, with `META_API_KEY` taking precedence. Explicit Bedrock credential-chain and Vertex ADC login delegate credential resolution to their SDKs. Keep credentials out of shared workspace files. Provider/model settings can select cache retention; paid cache warming is controlled by global settings. See [providers](packages/coding-agent/docs/providers.md), [environment variables](packages/coding-agent/docs/environment-variables.md), and [prompt caching](packages/coding-agent/docs/prompt-caching.md).

Pi settings and provider definitions are fallback inputs when using the default home; native values take precedence and writes go to Octocode files. Pi authentication is imported only through explicit confirmation in `/providers pi`; trust decisions are not imported. Details and historical migrations remain in [configuration and compatibility](packages/coding-agent/docs/configuration.md).

Image-capable models use `"input": ["text", "image"]` in native or Pi-compatible provider model definitions and `modelOverrides`. Custom definitions without `input` default to text-only. Image request limits use the existing `inputLimits` fields; see [model input and caching](packages/coding-agent/docs/models.md#describe-model-input-and-caching) for examples and send-time validation.

Native workflow controls: `OCTOCODE_EDIT_DIAGNOSTICS=0` disables advisory edit diagnostics; `OCTOCODE_VERIFY_NUDGE=0` disables the one-time "run a check" note before a run that edited files settles with no passing `verify: true` receipt; `OCTOCODE_SUBAGENT_LINGER_SECONDS` retains finished workers for explicit follow-up within its bounded window; the `bashBackgroundAfterSeconds` setting (default 90, `0` off) or `OCTOCODE_BASH_BACKGROUND_AFTER_SECONDS` sets when a foreground `bash` command moves to the background. `debug` is active by default and can be removed through `defaultTools` or `--tools`; browsing uses the built-in `browser` MCP server, and the native `browser` tool is enabled with `--tools +browser` or `defaultTools`; `bash` accepts `verify: true` per invocation. See [native features](packages/coding-agent/docs/native-features.md) and the [environment reference](packages/coding-agent/docs/environment-variables.md).
