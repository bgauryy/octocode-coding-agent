# Plugins and hooks

This guide shows how to add your own behavior to Octocode Code and which Claude, Codex and native formats it reads. The linked reference pages own the full contracts; this page explains how to start and what each format supports.

## Choose a mechanism

| You want to                                                                | Use                                                 | Runs as                                        |
| -------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------- |
| Run a script when a tool is called, a prompt is sent or a session starts   | [Command hook](#add-a-command-hook)                 | A separate process that receives JSON on stdin |
| Reuse an existing Claude Code or Codex plugin (skills, hooks, MCP servers) | [Local plugin](#add-a-claude-or-codex-plugin)       | Components loaded by their own loaders         |
| Share skills, prompts and themes through npm or git                        | [Octocode package](#distribute-an-octocode-package) | The resources it contains                      |
| Give the model task instructions only                                      | [Skill](packages/coding-agent/docs/skills.md)       | Instructions in `SKILL.md`                     |

Hooks and plugins run with your operating-system permissions and are not sandboxed. Project files load only after you trust the project with `/trust`. User code extensions are not supported: `--extension <code path>` exits 2, and code named by a setting or a package is ignored with a warning.

## Format support at a glance

**Yes** means the format loads and its documented behavior works. **Partial** means it loads with the limits listed in its section. **No** means Octocode does not read it.

| Format                                                              | Support | Notes                                                                                                                     |
| ------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------- |
| Native hooks: `<Octocode home>/hooks.json`, `.octocode/hooks.json`  | Yes     | Native profile                                                                                                            |
| Claude hooks in `settings.json` and `settings.local.json`           | Partial | Claude profile; see [hook events](packages/coding-agent/docs/hook-events.md)                                              |
| Codex `hooks.json` and `[hooks]` in `config.toml`                   | Partial | Codex profile; `[features] hooks = false` turns Codex hooks off                                                           |
| Claude plugin, `.claude-plugin/plugin.json`                         | Partial | Skills, plain prompt commands, hooks and MCP servers; added explicitly in settings                                        |
| Codex plugin, `.codex-plugin/plugin.json`                           | Partial | Skills, hooks and MCP servers; added explicitly in settings                                                               |
| Portable root `plugin.json` (with optional `extensions.com.openai`) | Partial | Read with `"protocol": "codex"`; same components as Codex                                                                 |
| Octocode package (`package.json` with an `octocode` key)            | Yes     | Legacy `pi` key is still read                                                                                             |
| Agent Skills (`SKILL.md` directories)                               | Yes     | Also read from Claude and Codex skill folders                                                                             |
| Plugins installed by Claude Code or Codex                           | Partial | Listed in `/harness`; switching one on adds it                                                                            |
| Plugins from a Claude-compatible marketplace                        | Partial | `octocode marketplace add`, `octocode plugin install`; [marketplaces](packages/coding-agent/docs/plugins.md#marketplaces) |
| Claude Mods modules                                                 | No      | Different API; not loaded                                                                                                 |
| Plugin LSP servers, output styles, dependencies                     | No      | Not activated; see [plugin limits](#plugin-component-support)                                                             |
| Hook handler `type: "agent"`                                        | No      | Reported as unsupported                                                                                                   |

## Add a command hook

Hooks are on in every main session; no flag turns them on. Each file is read with the profile of the host that defined its format, so a Claude hook keeps Claude's matcher rules and output handling.

1. Save this file as `<repository-root>/.octocode/hooks.json`:

   ```json
   {
   	"hooks": {
   		"PreToolUse": [
   			{
   				"matcher": "Bash",
   				"hooks": [{ "type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/scripts/check-bash.sh", "timeout": 10 }]
   			}
   		]
   	}
   }
   ```

   The script receives the event as JSON on stdin. Exit with code 2 and a reason on stderr to deny the call. Add `"failClosed": true` to deny when the script crashes or times out; by default such failures let the call through.

2. Run `/trust` and accept the native project configuration. User-level files (`<Octocode home>/hooks.json`, `~/.claude/settings.json`, `~/.codex/hooks.json`) do not need this step.
3. Run `/reload`, then `/harness hooks` to see each loaded command, its source file and profile, and any configuration diagnostics.

Hooks you already configured for Claude Code or Codex load automatically from their usual files. To turn every hook off, set `"disableAllHooks": true` in any loaded hook file. A subagent runs hooks only when its profile sets `hooks: true`.

Octocode reads these files, in this order, when a session starts:

| Scope   | File                                                                    | Profile           |
| ------- | ----------------------------------------------------------------------- | ----------------- |
| User    | `settings.json` in `CLAUDE_CONFIG_DIR` (default `~/.claude/`)           | Claude            |
| User    | `hooks.json`, then `config.toml`, in `CODEX_HOME` (default `~/.codex/`) | Codex             |
| User    | `<Octocode home>/hooks.json` (default `~/.octocode/octocodecode/`)      | Native            |
| Project | `.claude/settings.json`, then `.claude/settings.local.json`             | Claude            |
| Project | `.codex/hooks.json`, then `.codex/config.toml`                          | Codex             |
| Project | `.octocode/hooks.json`                                                  | Native            |
| Plugin  | Hook files of a configured plugin, after review                         | Plugin's protocol |

Project files are read from the repository root, even when Octocode starts in a subdirectory. Entries from all files are merged.

### Hook events by profile

[Hook events](packages/coding-agent/docs/hook-events.md) lists, for every event, which handler types the Native, Claude and Codex profiles accept. An event a profile does not support is skipped with a diagnostic in `/harness hooks`; `PreMessageSend` and `PostMessageReceive` are Octocode's own message events.

### Handler types and fields by profile

| Handler                   | Native | Claude                        | Codex                       |
| ------------------------- | ------ | ----------------------------- | --------------------------- |
| `command`                 | Yes    | Yes                           | Yes                         |
| `http`                    | No     | Yes, except on `SessionStart` | No                          |
| `prompt` (one model call) | No     | Yes, on gate and stop events  | No                          |
| `mcp_tool`                | No     | Yes                           | Yes, except on `SessionEnd` |
| `agent`                   | No     | No                            | No                          |

Every profile accepts `type`, `command`, `timeout`, `failClosed` and `statusMessage` on a command handler. Claude adds `args`, `shell` (`bash` or `powershell`; ignored with `args`), `onFailure`, `async` and `asyncRewake`, rejects `if` (a hook with `if` is skipped with a diagnostic, never run unfiltered), and ignores `once`. Codex adds `commandWindows`, `async` and `additionalContextLimit`. Other fields, such as Claude's `if`, reject the handler. Native commands time out after 60 seconds by default; Claude and Codex commands after 600. No timeout can exceed 600 seconds.

[Hook events](packages/coding-agent/docs/hook-events.md) is generated from the hook catalog and lists every event, handler type, timeout and input field per profile, plus the upstream events Octocode does not implement yet; `/harness hooks events` shows the same table in a session. The [hooks reference](packages/coding-agent/docs/hooks.md) describes the input each event receives, the output it accepts and the differences from Claude Code and Codex.

## Add a Claude or Codex plugin

To install from a marketplace, run `octocode marketplace add <source>` and `octocode plugin install <plugin@marketplace>` ([marketplaces](packages/coding-agent/docs/plugins.md#marketplaces)). Plugins Claude Code or Codex already installed appear in `/harness` as "installed in Claude Code" or "installed in Codex"; switching one on adds it to your settings with the right protocol, and its hooks and MCP servers still wait for review (step 3). For any other plugin, point Octocode at its directory on disk, then approve its executable parts.

1. Add the plugin to the `plugins` array in `~/.octocode/octocodecode/settings.json`, or in `.octocode/settings.json` for a trusted project, as an entry with an absolute `path` and a `protocol` (the [configuration example](packages/coding-agent/docs/plugins.md#configure-a-local-plugin) shows one).
   Use `"protocol": "codex"` for a `.codex-plugin/plugin.json` or a portable root `plugin.json`. The path must be absolute.

2. Run `/reload`. Skills (`/skill:review-kit:<skill>`) and plain prompt commands (`/review-kit:<command>`) are available immediately.
3. Adding or enabling a plugin approves its hooks and MCP servers, so read the plugin's hook and MCP declarations first (`/harness` lists them). Project plugins follow folder trust. The scripts and programs the declarations run are not reviewed.
4. Run `/reload`. The hooks and MCP servers load as the plugin declares them.

   `hooksFingerprint` and `mcpFingerprint` from older versions are no longer settings: leftover values are ignored and never stop a plugin from loading.

Set `"enabled": false` and reload to remove a plugin's skills, commands, hooks and MCP servers. Its data directory is kept.

### Plugin component support

| Component                                | Claude plugin                                                                                           | Codex or portable plugin                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Skills                                   | Yes, as `plugin-name:skill-name`                                                                        | Yes, also `$plugin-name:skill-name`             |
| Commands                                 | Partial: instruction-only Markdown commands                                                             | No                                              |
| Hooks                                    | Partial: `command`, `http`, `prompt`, `mcp_tool` after review                                           | Partial: `command`, `mcp_tool` after review     |
| MCP servers                              | Partial: stdio and streamable HTTP after review                                                         | Partial: stdio and streamable HTTP after review |
| Agents                                   | Yes, as `plugin-name:agent-name` ([plugin agents](packages/coding-agent/docs/plugins.md#plugin-agents)) | No                                              |
| LSP servers, output styles, dependencies | No                                                                                                      | No                                              |

Commands that set a model, grant tools, use unsupported frontmatter or expand shell output are skipped with a diagnostic. MCP servers register as `plugin:<plugin-name>:<server-key>`. Hook commands receive `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA`; Codex hook commands also receive `PLUGIN_ROOT` and `PLUGIN_DATA`. The [plugins reference](packages/coding-agent/docs/plugins.md) has the complete rules.

## Distribute an Octocode package

A package bundles skills, prompt templates and themes for npm or git. Declare its resources under the `octocode` key of `package.json`:

```json
{
	"name": "my-octocode-package",
	"octocode": {
		"skills": ["./skills"],
		"prompts": ["./prompts/*.md"],
		"themes": ["./themes/*.json"]
	},
	"peerDependencies": { "@octocodeai/octocodecode": "*" }
}
```

Without the `octocode` key, Octocode reads the `skills/`, `prompts/` and `themes/` directories. List host packages such as `@octocodeai/octocodecode` in `peerDependencies`, not `dependencies`.

Install, list and remove packages:

```bash
octocode install npm:@example/octocode-tools@1.0.0
octocode install git:github.com/example/octocode-tools@v1
octocode install ./local-package --local
octocode list
octocode remove npm:@example/octocode-tools
```

`--local` writes the package to the project's `.octocode/settings.json`, which loads only in a trusted project. A package's `hooks/hooks.json` and Claude or Codex plugin manifests are not loaded through a package; add the directory as a [plugin](#add-a-claude-or-codex-plugin) instead. The [packages reference](packages/coding-agent/docs/packages.md) covers sources, resource filters and dependency rules.

## Troubleshoot

- **A hook does not run.** In `/harness hooks`, check that the file is listed, the project is trusted, `disableAllHooks` is not set, the event and handler type are supported by that file's profile, and the matcher matches the tool name.
- **A plugin's hooks or MCP servers are missing.** Run `/harness`: it shows whether each plugin's hooks and MCP servers load or failed (see diagnostics). Then `/reload`.
- **A plugin component is ignored.** `/harness` and the startup diagnostics name the components Octocode does not load yet, such as LSP servers.
- **Turn one off without editing its files.** Run `/harness` and switch the plugin, hook file or single hook off (Space in the terminal list, or `/harness disable <id>`), then `/reload`. Claude and Codex files are never edited.

See [CONFIGURATIONS.md](CONFIGURATIONS.md) for every configuration file location and [docs/PLUGINS_MODS_HOOKS.md](docs/PLUGINS_MODS_HOOKS.md) for the design, what is not implemented and how compatibility is checked.
