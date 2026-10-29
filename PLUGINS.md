# Plugins, hooks and extensions

This guide shows how to add your own behavior to Octocode Code and which Claude, Codex and native formats it reads. The linked reference pages own the full contracts; this page explains how to start and what each format supports.

## Choose a mechanism

| You want to                                                                | Use                                                 | Runs as                                        |
| -------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------- |
| Run a script when a tool is called, a prompt is sent or a session starts   | [Command hook](#add-a-command-hook)                 | A separate process that receives JSON on stdin |
| Reuse an existing Claude Code or Codex plugin (skills, hooks, MCP servers) | [Local plugin](#add-a-claude-or-codex-plugin)       | Components loaded by their own loaders         |
| Add tools, slash commands, event handlers, providers or terminal UI        | [Native extension](#add-a-native-extension)         | TypeScript inside the Octocode process         |
| Share extensions, skills, prompts and themes through npm or git            | [Octocode package](#distribute-an-octocode-package) | The resources it contains                      |
| Give the model task instructions only                                      | [Skill](packages/coding-agent/docs/skills.md)       | Instructions in `SKILL.md`                     |

Hooks, plugins and extensions all run with your operating-system permissions and are not sandboxed. Project files load only after you trust the project with `/trust`.

## Format support at a glance

**Yes** means the format loads and its documented behavior works. **Partial** means it loads with the limits listed in its section. **No** means Octocode does not read it.

| Format                                                              | Support | Notes                                                                              |
| ------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------- |
| Native hooks: `<Octocode home>/hooks.json`, `.octocode/hooks.json`  | Yes     | Native profile                                                                     |
| Claude hooks in `settings.json` and `settings.local.json`           | Partial | Claude profile; see [hook events](packages/coding-agent/docs/hook-events.md)       |
| Codex `hooks.json` and `[hooks]` in `config.toml`                   | Partial | Codex profile; `[features] hooks = false` turns Codex hooks off                    |
| Claude plugin, `.claude-plugin/plugin.json`                         | Partial | Skills, plain prompt commands, hooks and MCP servers; added explicitly in settings |
| Codex plugin, `.codex-plugin/plugin.json`                           | Partial | Skills, hooks and MCP servers; added explicitly in settings                        |
| Portable root `plugin.json` (with optional `extensions.com.openai`) | Partial | Read with `"protocol": "codex"`; same components as Codex                          |
| Native extension (`.ts` or `.js` module exporting a factory)        | Yes     | Octocode `ExtensionAPI`                                                            |
| Octocode package (`package.json` with an `octocode` key)            | Yes     | Legacy `pi` key is still read                                                      |
| Agent Skills (`SKILL.md` directories)                               | Yes     | Also read from Claude and Codex skill folders                                      |
| Claude Code marketplaces, `enabledPlugins`, `/plugin install`       | No      | Add each plugin by local path instead                                              |
| Claude Mods modules                                                 | No      | Different API; not loaded through extensions                                       |
| Plugin agents, LSP servers, output styles, dependencies             | No      | Not activated; see [plugin limits](#plugin-component-support)                      |
| Hook handler `type: "agent"`                                        | No      | Reported as unsupported                                                            |

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
3. Run `/reload`, then `/hooks` to see each loaded command, its source file and profile, and any configuration diagnostics.

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

[Hook events](packages/coding-agent/docs/hook-events.md) lists, for every event, which handler types the Native, Claude and Codex profiles accept. An event a profile does not support is skipped with a diagnostic in `/hooks`; `PreMessageSend` and `PostMessageReceive` are Octocode's own message events.

### Handler types and fields by profile

| Handler                   | Native | Claude                        | Codex                       |
| ------------------------- | ------ | ----------------------------- | --------------------------- |
| `command`                 | Yes    | Yes                           | Yes                         |
| `http`                    | No     | Yes, except on `SessionStart` | No                          |
| `prompt` (one model call) | No     | Yes, on gate and stop events  | No                          |
| `mcp_tool`                | No     | Yes                           | Yes, except on `SessionEnd` |
| `agent`                   | No     | No                            | No                          |

Every profile accepts `type`, `command`, `timeout`, `failClosed` and `statusMessage` on a command handler. Claude adds `args`, `onFailure`, `async` and `asyncRewake`, and ignores `once`. Codex adds `commandWindows`, `async` and `additionalContextLimit`. Other fields, such as Claude's `if`, reject the handler. Native commands time out after 60 seconds by default; Claude and Codex commands after 600. No timeout can exceed 600 seconds.

[Hook events](packages/coding-agent/docs/hook-events.md) is generated from the hook catalog and lists every event, handler type, timeout and input field per profile, plus the upstream events Octocode does not implement yet; `/hooks events` shows the same table in a session. The [hooks reference](packages/coding-agent/docs/hooks.md) describes the input each event receives, the output it accepts and the differences from Claude Code and Codex.

## Add a Claude or Codex plugin

Octocode does not install plugins or read marketplaces. Point it at a plugin directory on disk, then approve its executable parts.

1. Add the plugin to the `plugins` array in `~/.octocode/octocodecode/settings.json`, or in `.octocode/settings.json` for a trusted project:

   ```json
   {
   	"plugins": [{ "path": "/absolute/path/to/review-kit", "protocol": "claude" }]
   }
   ```

   Use `"protocol": "codex"` for a `.codex-plugin/plugin.json` or a portable root `plugin.json`. The path must be absolute.

2. Run `/reload`. Skills (`/skill:review-kit:<skill>`) and plain prompt commands (`/review-kit:<command>`) are available immediately.
3. Hooks and MCP servers wait for review. `/hooks` reports a `hooksFingerprint`; the extension load errors shown at startup and after `/reload` report an `mcpFingerprint` for `settings.plugins`. Read the plugin's hook and MCP declarations, then copy each value into the same plugin entry:

   ```json
   {
   	"plugins": [
   		{
   			"path": "/absolute/path/to/review-kit",
   			"protocol": "claude",
   			"hooksFingerprint": "<value from /hooks>",
   			"mcpFingerprint": "<value from the load error>"
   		}
   	]
   }
   ```

4. Run `/reload`. A changed hook or MCP declaration invalidates its fingerprint and needs a new review. The fingerprint covers the declarations, not the scripts or programs they run.

Set `"enabled": false` and reload to remove a plugin's skills, commands, hooks and MCP servers. Its data directory is kept.

### Plugin component support

| Component                                        | Claude plugin                                                 | Codex or portable plugin                        |
| ------------------------------------------------ | ------------------------------------------------------------- | ----------------------------------------------- |
| Skills                                           | Yes, as `plugin-name:skill-name`                              | Yes, also `$plugin-name:skill-name`             |
| Commands                                         | Partial: instruction-only Markdown commands                   | No                                              |
| Hooks                                            | Partial: `command`, `http`, `prompt`, `mcp_tool` after review | Partial: `command`, `mcp_tool` after review     |
| MCP servers                                      | Partial: stdio and streamable HTTP after review               | Partial: stdio and streamable HTTP after review |
| Agents, LSP servers, output styles, dependencies | No                                                            | No                                              |

Commands that set a model, grant tools, use unsupported frontmatter or expand shell output are skipped with a diagnostic. MCP servers register as `plugin:<plugin-name>:<server-key>`. Hook commands receive `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA`; Codex hook commands also receive `PLUGIN_ROOT` and `PLUGIN_DATA`. The [plugins reference](packages/coding-agent/docs/plugins.md) has the complete rules.

## Add a native extension

An extension is a TypeScript or JavaScript module whose default export receives the `ExtensionAPI`. Use one when you need behavior that a hook script cannot provide, such as a new tool, a slash command or terminal UI.

1. Create `~/.octocode/octocodecode/extensions/hello.ts`, or `.octocode/extensions/hello.ts` in a project:

   ```typescript
   import type { ExtensionAPI } from "@octocodeai/octocodecode";

   export default function (octocode: ExtensionAPI) {
   	octocode.registerCommand("hello", {
   		description: "Show a greeting",
   		handler: async (name, ctx) => {
   			ctx.ui.notify(`Hello, ${name || "world"}!`, "info");
   		},
   	});

   	octocode.on("tool_call", async (event) => {
   		if (event.toolName === "bash" && String(event.input.command).includes("rm -rf /"))
   			return { block: true, reason: "Refusing to delete the filesystem root" };
   	});
   }
   ```

2. Run `/reload`, then `/hello`. TypeScript loads without a build step.

To try an extension without installing it, run `octocode --extension ./hello.ts`. A directory loads its top-level `.ts` and `.js` files, and each subdirectory loads through its `index.ts`, `index.js` or `package.json` `octocode.extensions` list. A directory containing `plugin.json`, `.claude-plugin`, `.codex-plugin` or `SKILL.md` is treated as a plugin or skill, not as an extension.

Extensions run in the Octocode process and can read prompts, files, credentials and session history. Load them only from sources you trust. The [extensions reference](packages/coding-agent/docs/extensions.md) lists every event, tool and UI API.

## Distribute an Octocode package

A package bundles extensions, skills, prompt templates and themes for npm or git. Declare its resources under the `octocode` key of `package.json`:

```json
{
	"name": "my-octocode-package",
	"octocode": {
		"extensions": ["./src/extension.ts"],
		"skills": ["./skills"],
		"prompts": ["./prompts/*.md"],
		"themes": ["./themes/*.json"]
	},
	"peerDependencies": { "@octocodeai/octocodecode": "*" }
}
```

Without the `octocode` key, Octocode reads the `extensions/`, `skills/`, `prompts/` and `themes/` directories. List host packages such as `@octocodeai/octocodecode` in `peerDependencies`, not `dependencies`.

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

- **A hook does not run.** In `/hooks`, check that the file is listed, the project is trusted, `disableAllHooks` is not set, the event and handler type are supported by that file's profile, and the matcher matches the tool name.
- **A plugin's hooks or MCP servers are missing.** Run `/plugins`: it shows each plugin's approval state and the fingerprint to copy into the plugin entry after reviewing the declarations. Then `/reload`.
- **A plugin component is ignored.** `/plugins` and the startup diagnostics name the components Octocode does not load yet, such as Claude agents or LSP servers.
- **Turn one off without editing its files.** Run `/plugins` and switch the plugin, extension, hook file or single hook off (Space in the terminal list, or `/plugins disable <id>`), then `/reload`. Claude and Codex files are never edited.
- **An extension does not load.** Check the load diagnostics shown at startup and after `/reload`, and that its directory does not contain a plugin or skill marker.

See [CONFIGURATIONS.md](CONFIGURATIONS.md) for every configuration file location and [docs/PLUGINS_MODS_HOOKS.md](docs/PLUGINS_MODS_HOOKS.md) for the compatibility matrix and remaining work.
