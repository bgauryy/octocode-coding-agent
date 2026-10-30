# Plugins

A plugin packages components under one identity. It may contain skills, hooks, MCP servers or executable integrations. A plugin is a container; each component needs its own loader and runtime support.

## Current support

Explicit local plugin configuration activates namespaced skills, supported Claude prompt commands, reviewed MCP server declarations and reviewed hooks. Other component activation is unfinished. Native [Octocode packages](packages.md) are supported and use a separate distribution contract.

| Manifest                     | Reader behavior                                                                                                                    | Runtime activation                                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `.claude-plugin/plugin.json` | Preserves Claude identity and declarations                                                                                         | Skills; plain prompt commands; reviewed command, HTTP, prompt and configured-server MCP hooks; reviewed MCP servers |
| `.codex-plugin/plugin.json`  | Reads the legacy Codex format                                                                                                      | Skills; reviewed command and MCP hooks; reviewed MCP server subset                                                  |
| Root `plugin.json`           | Reads portable identity; inline `extensions.com.openai` replaces the Codex overlay, otherwise the overlay supplies OpenAI settings | Skills; reviewed command and MCP hooks; reviewed MCP server subset                                                  |

Readers check real-path containment, including symlinks. Component discovery currently normalizes skill directories, Claude command declarations, and hook file/inline references. Claude skills add to the default directory; explicit commands replace their default; Claude hooks merge with their default file. Nonempty explicit Codex hook declarations replace the default; an empty array falls back to `hooks/hooks.json`. Skills enter the native skill loader; reviewed hook declarations enter the existing command-hook dispatcher. Plain Claude commands also enter the prompt loader; other executable command features and components remain incomplete.

## Separate component systems

- **[Skills](skills.md)** contain task instructions in `SKILL.md`. Their existing discovery and invocation work independently of plugins.
- **[Extensions](extensions.md)** execute code through Octocode's native API. Claude Mods use a different API; no compatible bridge is implemented yet.
- **[Hooks](hooks.md)** run at supported events through the separately enabled hook subsystem. Plugin hook references require a reviewed definition fingerprint.

## Configure a local plugin

Add an absolute local path and the source protocol to the `plugins` array in Octocode settings:

```json
{
	"plugins": [{ "path": "/absolute/path/to/review-kit", "protocol": "claude" }]
}
```

Use `"protocol": "codex"` for legacy Codex or portable OpenAI manifests. Selecting a protocol is explicit when a directory has both manifests. An explicitly selected Claude directory may omit its manifest and use the directory name; a present invalid manifest never falls back. Legacy Codex manifests with a missing or blank name use the directory name. Safe non-kebab identifiers are accepted, but whitespace, namespace/path separators and control characters remain invalid locally. Plugin skills use `plugin-name:skill-name`; `/skill:plugin-name:skill-name` explicitly invokes them. Eligible Codex plugin skills also support [`$plugin-name:skill-name` mentions](skills.md#select-skills-with-codex-mentions). Set `"enabled": false` and reload to remove the plugin's loaded skills, commands and hooks. `--no-skills` also disables plugin skills. Project plugin settings are loaded only after project resource trust. Relative plugin roots are rejected. Malformed entries are diagnosed and skipped without failing resource reload. Skill discovery rejects directory cycles and escaping links across the entire declared skill tree, including hidden and ignored descendants; this is stricter than ordinary skill scanning.

For supported command, Claude HTTP/prompt and configured-server MCP hooks, inspect `/hooks`, review the referenced plugin manifests and hook definitions, and copy the reported `hooksFingerprint` into the same plugin entry only after that review. Reload. A changed manifest or hook definition requires a new fingerprint; enabling a plugin alone does not approve its hook handlers. This fingerprint covers declarations, not the contents of arbitrary scripts or external programs those commands invoke.

Plugin command hooks receive `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA`; allowed HTTP header interpolation uses the same plugin identity. Codex command hooks also receive `PLUGIN_ROOT` and `PLUGIN_DATA`. Skills and commands use the same `CLAUDE_PLUGIN_DATA` path. Data is stored under `<Octocode home>/plugins/data/<identity hash>/`, outside the plugin directory, and is created when a reviewed command hook executes or a reviewed stdio MCP declaration activates. Instruction expansion and HTTP header interpolation only resolve the path. Moving the plugin root changes its identity, approval and data location. Disabling a plugin preserves its data; uninstall/data cleanup management is not implemented yet.

## Plugin MCP servers

Local plugins can supply stdio and streamable HTTP servers to the existing MCP runtime. Claude discovery reads `.mcp.json` first, then declared `mcpServers` JSON paths or inline maps in order; later server names replace earlier definitions. Legacy Codex explicit paths or inline maps replace the default `.mcp.json`. Configuration files must stay inside the plugin, including symlink resolution. Other transports, bundles, remote bundle URLs and unsupported configuration fields produce diagnostics.

Review the manifest and MCP declarations, then add the diagnostic's `mcpFingerprint` to the plugin's settings entry and reload. This approval is independent of `hooksFingerprint`; neither grants the other. Changing a contributing manifest or MCP definition invalidates approval. The fingerprint covers declarations, not external executables or script contents. Project declarations are registered only after project settings are trusted. Disabling the plugin and reloading removes its registrations through the existing runtime.

Servers register as `plugin:<plugin-name>:<server-key>`. Claude tool namespaces preserve the plugin name and server key, for example `mcp__plugin_review-kit_check__policy`; use the scoped server name in an `mcp_tool` hook. This follows the [Claude plugin MCP naming contract](https://code.claude.com/docs/en/mcp#plugin-provided-mcp-servers). Codex currently uses this local scoped naming too; its full naming, portable overlays and policy semantics remain unverified.

Plugin-root, plugin-data and project-root placeholders resolve before registration. Stdio activation creates the shared plugin data directory and exports these variables. The supported declaration subset is `type`, `command`, `args`, `env`, `cwd`, `url` and `headers`; Claude HTTP entries require an explicit type. Native MCP authentication and transport behavior still apply. This adapter does not yet import vendor OAuth policy, dynamic header helpers, user configuration, environment overlays, SSE or WebSocket transports. Normal sessions load the built-in MCP owner, while SDK sessions that disable native features must provide an owner; registration alone does not prove a connection succeeded. Existing server configuration can override extension registrations.

## Inspect and switch plugins, extensions and hooks

Run `/plugins` to list every plugin, extension and hook Octocode loads, grouped by the host that defines it: Claude Code, Codex, Octocode and packages. In the terminal it opens a list with the keys of `octocode config`: type to filter, ↑↓ and PgUp/PgDn move, Space or Enter switches the selected row on or off, → and ← open and close a hook file's hooks, Tab chooses global or project scope, and Esc closes, offering to reload when something changed. The row under the cursor shows its full detail and ID below the list; a row that cannot be switched in the current scope is dimmed and says why. Other modes print the same list with an ID per row; switch one with `/plugins enable|disable <id> [--local] [--force]`. Changes apply after `/reload`.

- Rows nest as host, hook file and single hook; the most specific switch wins, so a single hook can stay on while the rest of its host is off.
- Plugins and hooks are stored in the `toggles` setting by ID (`plugin:<path>`, `hooks:<host>`, `hooks:<host>:<file>`, `hook:<id>`). Extensions use the `extensions` patterns `octocode config` writes, so both tools show the same state.
- A project switch (`--local`, Tab) only reaches items inside the repository: a committed `.octocode/settings.json` cannot switch off your own hooks or plugins. `/plugins` lists project keys it ignored.
- Switching on never skips project trust or the plugin fingerprint review, and `disableAllHooks` still turns every hook off. Switching off a gate hook (one that denies when it fails) needs a second Space or `--force`.
- Editing a hook changes its `hook:` ID; the old switch then appears under "Stale switches" and `/plugins enable <id>` removes it.

Plugins that Claude Code (`~/.claude/plugins/installed_plugins.json`, enabled state from `enabledPlugins`) or Codex (`[plugins."name@marketplace"]` in `config.toml`, files under `plugins/cache/`) installed appear as "installed in Claude Code" or "installed in Codex" rows. Listing them reads those records and runs nothing. Switching one on adds a `plugins` entry with the protocol of the manifest it ships; its skills and commands load after `/reload`, and its hooks and MCP servers still need the fingerprint review below. `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_PLUGIN_CACHE_DIR` and `CODEX_HOME` select the locations read.

Each plugin row also shows its manifest format, skill and command sources, hook and MCP approval state (including the fingerprint to review and copy), and the components Octocode does not load. A plugin that declares or ships such a component, for example Claude `agents/`, `.lsp.json`, `output-styles/`, `monitors`, `userConfig` or `bin/`, or Codex `commands` and `.app.json`, loads without it and reports a warning instead of dropping it silently. `UNSUPPORTED_PLUGIN_COMPONENTS` in `src/core/plugin-components.ts` is the complete list.

## Remaining limits

Advanced command execution, remaining MCP capabilities, LSP components, agents, dependencies, marketplaces, update management and Claude Mods are unfinished. Mixed hook files containing `modules` are diagnosed and cannot receive an approval fingerprint. There is no claim of vendor service or full protocol equivalence. Plugin or skill markers prevent implicit native extension entry discovery; see [extension directory discovery](extensions.md#extension-directory-discovery). A directly supplied native module still executes through the extension API.

See the [compatibility matrix and implementation plan](../../../docs/PLUGINS_MODS_HOOKS.md) for each subsystem's implemented and outstanding contracts.

## Claude prompt commands

Instruction-only commands load from standard `commands/*.md` files, declared files/directories, or manifest command maps. `/plugin-name:command-name` expands through the existing prompt-template runtime. Inline and file-backed commands support descriptions, argument hints and Claude argument placeholders. `$0` and `$ARGUMENTS[0]` select the first argument; `$ARGUMENTS` preserves the original argument string. Markdown `arguments` names map to positions. Missing indexed values stay literal, named missing values become empty, and arguments are appended when no placeholder consumes them. Native prompt templates keep their own one-based numbering. `${CLAUDE_PLUGIN_ROOT}` resolves to the plugin root after argument insertion. Session invocations also substitute `${CLAUDE_SESSION_ID}` and `${CLAUDE_PROJECT_DIR}` with current values. Disabling the plugin and reloading removes its commands; `--no-prompt-templates` disables them separately from skills.

Commands with model overrides, tool grants, unsupported frontmatter or dynamic shell expansion are diagnosed and skipped. Those execution contracts must be implemented before such commands can run faithfully. Duplicate names are diagnosed, and command file symlinks must stay inside the plugin. This is a prompt-command subset, not full Claude command execution.
