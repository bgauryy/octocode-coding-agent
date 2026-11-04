# Plugins

A plugin packages components under one identity. It may contain skills, hooks, MCP servers or executable integrations. A plugin is a container; each component needs its own loader and runtime support.

## Current support

Explicit local plugin configuration activates namespaced skills, supported Claude prompt commands, Claude [plugin agents](#plugin-agents), reviewed MCP server declarations and reviewed hooks. Other component activation is unfinished. Native [Octocode packages](packages.md) are supported and use a separate distribution contract.

| Manifest                     | Reader behavior                                                                                                                    | Runtime activation                                                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `.claude-plugin/plugin.json` | Preserves Claude identity and declarations                                                                                         | Skills; plain prompt commands; agents; reviewed command, HTTP, prompt and configured-server MCP hooks; reviewed MCP servers |
| `.codex-plugin/plugin.json`  | Reads the legacy Codex format                                                                                                      | Skills; reviewed command and MCP hooks; reviewed MCP server subset                                                          |
| Root `plugin.json`           | Reads portable identity; inline `extensions.com.openai` replaces the Codex overlay, otherwise the overlay supplies OpenAI settings | Skills; reviewed command and MCP hooks; reviewed MCP server subset                                                          |

Readers check real-path containment, including symlinks. Component discovery currently normalizes skill directories, Claude command declarations, and hook file/inline references. Claude skills add to the default directory; explicit commands replace their default; Claude hooks merge with their default file. Nonempty explicit Codex hook declarations replace the default; an empty array falls back to `hooks/hooks.json`. Skills enter the native skill loader; reviewed hook declarations enter the existing command-hook dispatcher. Plain Claude commands also enter the prompt loader; other executable command features and components remain incomplete.

## Separate component systems

- **[Skills](skills.md)** contain task instructions in `SKILL.md`. Their existing discovery and invocation work independently of plugins.
- **Native code** is not a plugin component. Plugins carry skills, commands, hooks and MCP servers; Claude Mods (in-process code) are not supported.
- **[Hooks](hooks.md)** run at supported events through the separately enabled hook subsystem. Adding or enabling a plugin approves its hooks.

## Configure a local plugin

Add an absolute local path and the source protocol to the `plugins` array in Octocode settings:

```json
{
	"plugins": [{ "path": "/absolute/path/to/review-kit", "protocol": "claude" }]
}
```

Use `"protocol": "codex"` for legacy Codex or portable OpenAI manifests. Selecting a protocol is explicit when a directory has both manifests. An explicitly selected Claude directory may omit its manifest and use the directory name; a present invalid manifest never falls back. Legacy Codex manifests with a missing or blank name use the directory name. Safe non-kebab identifiers are accepted, but whitespace, namespace/path separators and control characters remain invalid locally. Plugin skills use `plugin-name:skill-name`; `/skill:plugin-name:skill-name` explicitly invokes them. Eligible Codex plugin skills also support [`$plugin-name:skill-name` mentions](skills.md#select-skills-with-codex-mentions). Set `"enabled": false` and reload to remove the plugin's loaded skills, commands and hooks. `--no-skills` also disables plugin skills. Project plugin settings are loaded only after project resource trust. Relative plugin roots are rejected. Malformed entries are diagnosed and skipped without failing resource reload. Skill discovery rejects directory cycles and escaping links across the entire declared skill tree, including hidden and ignored descendants; this is stricter than ordinary skill scanning.

For supported command, Claude HTTP/prompt and configured-server MCP hooks, review the referenced plugin manifests and hook definitions (`/harness` lists them), then add or enable the plugin and reload: enabling approves them. Project plugins follow folder trust. Approval covers declarations, not the contents of scripts or external programs those commands invoke.

Plugin command hooks receive `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA`; allowed HTTP header interpolation uses the same plugin identity. Codex command hooks also receive `PLUGIN_ROOT` and `PLUGIN_DATA`. Skills and commands use the same `CLAUDE_PLUGIN_DATA` path. Data is stored under `<Octocode home>/plugins/data/<identity hash>/`, outside the plugin directory, and is created when a reviewed command hook executes or a reviewed stdio MCP declaration activates. Instruction expansion and HTTP header interpolation only resolve the path. Moving the plugin root changes its identity, approval and data location. Disabling a plugin preserves its data; uninstall/data cleanup management is not implemented yet.

## Plugin MCP servers

Local plugins can supply stdio and streamable HTTP servers to the existing MCP runtime. Claude discovery reads `.mcp.json` first, then declared `mcpServers` JSON paths or inline maps in order; later server names replace earlier definitions. Legacy Codex explicit paths or inline maps replace the default `.mcp.json`. Configuration files must stay inside the plugin, including symlink resolution. Other transports, bundles, remote bundle URLs and unsupported configuration fields produce diagnostics.

Review the manifest and MCP declarations, then add or enable the plugin and reload: enabling approves its servers. Approval covers declarations, not external executables or script contents. Project declarations are registered only after project settings are trusted. Disabling the plugin and reloading removes its registrations through the existing runtime.

Servers register as `plugin:<plugin-name>:<server-key>`. Claude tool namespaces preserve the plugin name and server key, for example `mcp__plugin_review-kit_check__policy`; use the scoped server name in an `mcp_tool` hook. This follows the [Claude plugin MCP naming contract](https://code.claude.com/docs/en/mcp#plugin-provided-mcp-servers). Codex currently uses this local scoped naming too; its full naming, portable overlays and policy semantics remain unverified.

Plugin-root, plugin-data and project-root placeholders resolve before registration. Stdio activation creates the shared plugin data directory and exports these variables. The supported declaration subset is `type`, `command`, `args`, `env`, `cwd`, `url` and `headers`; Claude HTTP entries require an explicit type. Native MCP authentication and transport behavior still apply. This adapter does not yet import vendor OAuth policy, dynamic header helpers, user configuration, environment overlays, SSE or WebSocket transports. Sessions load the built-in MCP owner (none with `--no-mcp`); registration alone does not prove a connection succeeded. Existing server configuration can override extension registrations.

## Inspect and switch plugins, extensions and hooks

Run `/harness` to list every plugin, extension, hook, skill and MCP server Octocode loads, grouped by the host that defines it: Claude Code, Codex, Octocode and packages. In the terminal it opens a list with the keys of `octocode config`: type to filter, ↑↓ and PgUp/PgDn move, Space or Enter switches the selected row on or off, → and ← open and close a hook file's hooks, Tab chooses global or project scope, and Esc closes, offering to reload when something changed. The row under the cursor shows its full detail and ID below the list; a row that cannot be switched in the current scope is dimmed and says why. Other modes print the same list with an ID per row; `/harness list [plugins|hooks|skills|mcp|extensions|<text>]` prints one section or the rows matching the text. Switch items with `/harness enable|disable <id|name>... [--local] [--force]`: an item is matched by its exact ID or a unique name, and several at once cost one reload. `/harness hooks [events]` inspects hooks and `/harness config` shows the loaded configuration with its sources; neither switches anything. The old `/plugins`, `/hooks` and `/config` names print a hint naming these forms. Changes to plugins, hooks, skills and extensions apply after `/reload` (the terminal offers it; the next request rebuilds the prompt cache once). MCP switches apply at once, without a reload: in the terminal list, when it closes.

- Rows nest as host, hook file and single hook; the most specific switch wins, so a single hook can stay on while the rest of its host is off.
- Plugins and hooks are stored in the `toggles` setting by ID (`plugin:<path>`, `hooks:<host>`, `hooks:<host>:<file>`, `hook:<id>`). Extensions and skills (rows `skill:<path>`) use the settings patterns `octocode config` writes, so both tools show the same state. MCP servers (rows `mcp:<name>`) are switched through the MCP owner and written to `mcp.json`, or to the project override with `--local`; `/mcp` keeps its own subcommands. Skills supplied only by a plugin are not rows: switch them through their plugin or `/skills`. Skills from Claude, Codex or Octocode-home skill folders (symlinked ones included) are listed as one read-only `skills-folder:<folder>` row per folder, naming its skills; `/skills` switches them.
- A project switch (`--local`, Tab) only reaches items inside the repository: a committed `.octocode/settings.json` cannot switch off your own hooks or plugins. `/harness` lists project keys it ignored.
- Switching on never skips project trust, and `disableAllHooks` still turns every hook off. Switching off a gate hook (one that denies when it fails) needs a second Space or `--force`.
- Editing a hook changes its `hook:` ID; the old switch then appears under "Stale switches" and `/harness enable <id>` removes it.

Plugins that Claude Code (`~/.claude/plugins/installed_plugins.json`, enabled state from `enabledPlugins`) or Codex (`[plugins."name@marketplace"]` in `config.toml`, files under `plugins/cache/`) installed appear as "installed in Claude Code" or "installed in Codex" rows. Listing them reads those records and runs nothing. Switching one on adds a `plugins` entry with the protocol of the manifest it ships; its skills and commands load after `/reload`, and its hooks and MCP servers still need the fingerprint review below. `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_PLUGIN_CACHE_DIR` and `CODEX_HOME` select the locations read.

Each plugin row also shows its manifest format, how many skills load from its declared skill folders (a declared folder may hold none), its command sources, whether hooks and MCP servers load or failed (when a host or hook switch turns some of its hooks off, `hooks 1 of 3 on (hooks:codex off)` names how many are on and the switch; the `[x]` stays the plugin's own switch), the MCP servers its `mcp_tool` hooks call that neither the plugin nor the session's MCP registry provides (a bare key matching the plugin's own server is shown as `echo (did you mean plugin:<name>:echo?)`; hooks need the scoped name), and the components Octocode does not load. A plugin that declares or ships such a component, for example Claude `.lsp.json`, `output-styles/`, `monitors`, `userConfig` or `bin/`, or Codex `commands` and `.app.json`, loads without it and reports a warning instead of dropping it silently. `UNSUPPORTED_PLUGIN_COMPONENTS` in `src/core/plugin-components.ts` is the complete list.

## Plugin agents

A Claude plugin's agents become subagent profiles that the `agent` tool can start, named `<plugin>:<agent>`.

- **Where they come from.** The manifest `agents` key (a path or an array of `.md` files; directories are not accepted) replaces the default scan. Without it, every `.md` file under the plugin's `agents/` is read, recursively. A disabled plugin contributes none, and a project-scope plugin contributes agents only when the folder is trusted (project settings do not load otherwise).
- **Names.** `<agent>` is the frontmatter `name`, else the file name without `.md`. In the default scan the subfolders of `agents/` are part of the name, as in Claude Code: `agents/review/security.md` in `my-plugin` is `my-plugin:review:security`, and `name: audit` in that file makes it `my-plugin:review:audit`. A file listed in the manifest `agents` key carries no subfolder names (`./custom/review/security.md` is `my-plugin:security`). A frontmatter `name` with spaces, a colon or more than 256 characters is replaced by the file name; a file or folder name with spaces is skipped and reported. (Source: Claude Code [plugin components](https://code.claude.com/docs/en/plugins/components#agents) and [sub-agents](https://code.claude.com/docs/en/sub-agents) pages, checked 2026-11-01.)
- **Precedence.** A plugin agent never replaces a bundled, user or project profile: when one has the same name, the plugin agent is not used and the startup notice says so.
- **Fields carried over:** `description`; `model` (`inherit` means the parent's model, anything else is passed on as the model preference); `maxTurns` as `maxRequests`; `skills`; `tools` and `disallowedTools`, translated: `Bash` selects `bash`, `WebFetch` and `WebSearch` select `web`, `mcp__` entries are kept, and the read, search and edit names need no entry because every child has local research and `file`. A `tools` list without a file-writing tool (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`) makes the profile read-only, and so does a denied one, so an agent never gets more than its Claude definition allowed. `permissions:` is kept: the spawn still asks the user, as for any profile. `readOnly` is kept.
- **Reported as unsupported and ignored:** `hooks` (ship hooks in the plugin's `hooks/hooks.json`), `mcpServers`, `permissionMode`, `initialPrompt`, `effort`, `background`, `memory`, `omitClaudeMd`, `isolation`, `color`, `autoCompactWindow`, `experimental`, tool entries with a specifier (`Bash(git *)`) or without an Octocode equivalent, and every Octocode-only profile field a plugin agent cannot be trusted with (`lean`, `headless`, `linger`, `excludeTools`, `hooks: true`). The report is a startup notice (interactive sessions) naming the file and fields; the agent's row in the startup screen and `/harness config` shows source `plugin <name>`.
- **Frontmatter that does not parse.** Claude Code still loads such an agent under its file name with every field ignored. Octocode skips it and reports the failure, and the `agent` tool names the reason for that profile.
- **Approval.** Adding or enabling the plugin approves its agents. An agent's prompt is an instruction, like a skill's; a change to the file is a new profile identity for the spawn permission prompt.

## Marketplaces

A marketplace is a folder or git repository with `.claude-plugin/marketplace.json` (`name` and a `plugins` array; each entry needs a `name` and a `source`), the Claude Code format. Octocode reads these entry sources: a relative path (`./plugins/x`, or a bare name under `metadata.pluginRoot`), `github` (`repo`, `ref`, `sha`), `url` (`url`, `ref`, `sha`) and `git-subdir` (`url`, `path`, `ref`, `sha`). `npm`, `archive` and `command` sources are refused (the last would run a command at install). Entry fields that declare components inline (`hooks`, `mcpServers`, `commands`, ...) are ignored; the plugin's own files are used.

```
octocode marketplace add <path | owner/repo[@ref] | git-url[#ref]>
octocode marketplace list | update [name] | remove <name>
octocode plugin install <plugin@marketplace> [--yes]
octocode plugin update [plugin@marketplace] [--yes]
octocode plugin remove <plugin@marketplace>
octocode plugin list
```

`/harness install|update|remove <plugin@marketplace> [--yes]` do the same inside a session (run `/reload` after). The package commands `octocode install|remove|update|list` are unchanged and manage packages.

- **Registry.** `marketplaces` in the user `settings.json` (global only: a project file cannot register one). A marketplace name must be unique and may not start with `claude-`, `anthropic-` or `claudeai-` or be another reserved Claude name. A local folder that holds `marketplace.json` is read in place; a local bare or working git repository is cloned.
- **Fetching.** A shallow clone (`--depth 1 --no-recurse-submodules`) with `GIT_TERMINAL_PROMPT=0`, `GIT_LFS_SKIP_SMUDGE=1`, only the https, ssh, git and file transports (`ext::` and other remote helpers are refused), no repository hooks, and a 120 s timeout. URLs with embedded credentials are refused; use SSH or a git credential helper. Nothing from the repository runs on add, install or update.
- **Install.** The plugin tree is copied (no `.git`) to `plugins/cache/<marketplace>/<plugin>/<sha>/` under the Octocode home, and a `plugins[]` entry is written with `source: {marketplace, plugin, sha}`. A symlink that leaves the plugin directory stops the install. Without its own `plugin.json`, the entry's `name` names the plugin.
- **Approval.** A plugin that declares hooks or MCP servers is listed and needs approval before it is enabled: a prompt in a terminal, `--yes` otherwise (without it the command exits 1). An update asks again only when the hook or MCP declarations change (what the file lists, not the scripts it points to); other updates apply silently. Project plugins still follow folder trust.
- **Remove.** `plugin remove` deletes the entry, its cache and `plugins/data/<id>`; `marketplace remove` first removes the marketplace's plugins. The data folder is keyed by marketplace and plugin, so an update keeps it.

## Remaining limits

Advanced command execution, remaining MCP capabilities, LSP components, dependencies, the `command`, `archive` and `npm` marketplace sources, and Claude Mods are unfinished. A plugin hook file containing `modules` is reported and its hooks are not loaded. There is no claim of vendor service or full protocol equivalence.

See the [design](../../../docs/PLUGINS_MODS_HOOKS.md) for what is not implemented and how compatibility is checked.

## Claude prompt commands

Instruction-only commands load from standard `commands/*.md` files, declared files/directories, or manifest command maps. `/plugin-name:command-name` expands through the existing prompt-template runtime. Inline and file-backed commands support descriptions, argument hints and Claude argument placeholders. `$0` and `$ARGUMENTS[0]` select the first argument; `$ARGUMENTS` preserves the original argument string. Markdown `arguments` names map to positions. Missing indexed values stay literal, named missing values become empty, and arguments are appended when no placeholder consumes them. Native prompt templates keep their own one-based numbering. `${CLAUDE_PLUGIN_ROOT}` resolves to the plugin root after argument insertion. Session invocations also substitute `${CLAUDE_SESSION_ID}` and `${CLAUDE_PROJECT_DIR}` with current values. Disabling the plugin and reloading removes its commands; `--no-prompt-templates` disables them separately from skills.

Commands with model overrides, tool grants, unsupported frontmatter or dynamic shell expansion are diagnosed and skipped. Those execution contracts must be implemented before such commands can run faithfully. Duplicate names are diagnosed, and command file symlinks must stay inside the plugin. This is a prompt-command subset, not full Claude command execution.
