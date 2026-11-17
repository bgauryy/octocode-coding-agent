# Configuration

One page for where configuration lives, what wins, what needs trust and how to change it. Field lists: [settings](settings.md), [models.json](models-configuration.md), [environment variables](environment-variables.md).

```mermaid
flowchart LR
    F["--enable / --disable / --set<br/>(this run)"] --> M[merged configuration]
    P[".octocode/ (trusted project)"] --> M
    G["~/.octocode/octocodecode/ (global)"] --> M
    I["Pi files (read-only fallback)"] --> M
    M --> S[session]
```

Left beats right: a run flag beats the project, the project beats global, global beats Pi.

Two settings choose editors. Both are global or trusted-project settings, like any other.

| Setting           | Used by                                                                                                                                   | Default                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `externalEditor`  | Ctrl+G prompt editing and editor dialogs: Octocode waits for the editor to exit (a Code-family editor, Zed or Sublime Text gets `--wait`) | `VISUAL`, then `EDITOR`, then Notepad on Windows or Nano elsewhere |
| `referenceOpener` | Opening a file reference (`/links`, a clicked reference) and `/diff --editor`                                                             | `auto`                                                             |

| `referenceOpener` value | Opens with                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto`                  | The IDE whose integrated terminal runs Octocode (VS Code, Insiders, VSCodium, Cursor), in the current window; else the first of `code`, `cursor`, `code-insiders`, `codium`, `zed`, `subl` on PATH; else the system's default app for the file (`open`, `xdg-open`). Over SSH and on Linux without a display: the prompt editor |
| `editor`                | The prompt editor (`externalEditor`, `VISUAL`, `EDITOR`)                                                                                                                                                                                                                                                                        |
| any other text          | That command, for example `cursor` or `"/opt/My Editor/bin/edit" --flag`                                                                                                                                                                                                                                                        |

Code-family editors, Zed and Sublime Text open beside the session: Octocode keeps the terminal and does not wait. Any other editor, such as Vim or Nano, takes the terminal until it exits. Configure editors in the environment running Octocode, including SSH or WSL. See [editor workflows](tui.md#editor-and-vs-code-workflows).

## Headless and external-agent runs

Text, JSON and RPC runs use the same configuration precedence as terminal sessions. Start the worker in the target project so it finds that project's settings and instructions. Headless startup refuses an untrusted folder; `--trust` explicitly records trust, including permission to load project hooks and MCP configuration.

| Automation choice             | Configure it with                                                                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Model                         | `--model <provider/model-id>`; pick an available model whose plan permits unattended use                                                  |
| Credentials                   | Provider environment variables or preconfigured global sign-in; never committed workspace secrets                                         |
| Permission policy             | `--permission-mode workspace` for routine work with asks refused when nobody can answer; `full` is the broader default, not a sandbox     |
| Per-run settings              | `--set <key>=<value>`, `--enable <id>`, `--disable <id>`; these do not save settings                                                      |
| Tool restrictions             | `--tools`, `--exclude-tools`, `--no-mcp`; check subagent inheritance in [tool selection](native-features.md#tool-selection-and-migration) |
| Conversation storage          | `--no-session` for an in-memory conversation, or a distinct `--session-id` for recoverable work; neither isolates tool side effects       |
| Separate worker configuration | `OCTOCODE_HOME` and, when needed, `OCTOCODE_CODING_AGENT_DIR`; provision credentials and trust for that environment too                   |

Do not change global defaults for every delegated task. Prefer run flags, and keep caller deadlines and output limits in the launching program. The [external-agent guide](external-agents.md) has working invocation patterns and RPC lifecycle requirements; [providers](providers.md) covers authentication.

Octocode configuration and the [Pi fallback](#pi-configuration-fallback) are available by default. Each native child can use a different enabled `provider/model`; it inherits the configuration sources, rather than being limited to the coordinator’s provider. A credential supplied only with `--api-key` is not forwarded to children: configure the provider in the shared user configuration instead.

Installed [external runners](native-features.md#external-runners), including OpenCode, require opt-in. Open `/providers` → **External agents**, select a CLI and choose **Enable this CLI for agent tasks**, then `/reload`. Discovery starts no CLI processes; opening a runner's page or using it checks its own sign-in. Vendor CLIs keep their own configuration and credentials.

| Global setting                                                         | Meaning                                                    |
| ---------------------------------------------------------------------- | ---------------------------------------------------------- |
| `externalAgents: false` (default)                                      | External delegation is off.                                |
| `externalAgents: true`, `enabledExternalAgents: ["codex", "opencode"]` | Offer only these installed, runnable CLIs.                 |
| `externalAgents: true`, `enabledExternalAgents: []`                    | Offer no vendor CLI.                                       |
| Explicit `externalAgents: true`, selection omitted                     | Preserve the legacy choice to offer all installed runners. |

Project settings cannot change these choices. Pausing external tasks keeps the selection; signing in never enables a CLI or changes the default model. Manual `/agents external` commands remain explicit, permission-checked user actions; a configured selection also constrains their ACP connections.

## Agent directory

Global configuration and runtime state live in `~/.octocode/octocodecode/` ("global" below). Project configuration lives in `.octocode/` of the workspace. MCP definitions are the exception: `~/.octocode/mcp.json` and `.octocode/mcp.json`.

| Override                    | Moves                                                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `OCTOCODE_HOME`             | The shared configuration and runtime home                                                                                                |
| `OCTOCODE_CODING_AGENT_DIR` | Only the core configuration directory; native runtime files keep their own home                                                          |
| `OCTOCODE_AGENT_DB`         | The agent database file (default `<octocode home>/agent/workspaces.db`); its transcript mirror sits beside it as `<name>.transcripts.db` |

An explicit `OCTOCODE_HOME` or `OCTOCODE_CODING_AGENT_DIR` also turns off the [Pi fallback](#pi-configuration-fallback) and moves the user MCP file to `mcp.json` in that directory. `/mcp config` prints the exact MCP paths, their read order and trust state without connecting servers.

## Where each configuration belongs

Workspace files are relative to the session's working directory; agent profiles and hooks use the repository root, also when you start in a subdirectory. Workspace files need a trusted folder.

| Configure                 | Global                                                                 | Workspace                                           | Inspect or apply                                                      |
| ------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------- |
| Settings, default model   | `settings.json`                                                        | `.octocode/settings.json`                           | `/configuration`; `/reload` after file edits                          |
| MCP servers, exposure     | `~/.octocode/mcp.json`                                                 | `.octocode/mcp.json`                                | `/mcp config`; [MCP](mcp.md)                                          |
| Providers, model defs     | `models.json`                                                          | none; select a model in workspace settings          | `/model` reloads definitions; `/modelsettings`                        |
| Provider sign-in, keys    | `auth.json`                                                            | none                                                | `/providers`, `/logout`                                               |
| MCP OAuth tokens          | `mcp-auth.json`                                                        | none                                                | `/mcp login\|logout <server>`                                         |
| Derived context files     | `context-optimization/` (project ones under `projects/<repo>-<hash>/`) | none in the repository                              | Rewritten on change; `octocode context`, `octocode mcp compact`       |
| Skills                    | `skills/<name>/SKILL.md`, `~/.agents/skills/`                          | `.octocode/skills/`, `.agents/skills/`              | `/harness list skills`; [skills](skills.md)                           |
| Prompt templates          | `prompts/*.md`                                                         | `.octocode/prompts/*.md`                            | [prompt templates](prompt-templates.md)                               |
| Themes                    | `themes/*.json`                                                        | `.octocode/themes/*.json`                           | `/configuration` → Interface and session → Theme; [themes](themes.md) |
| Keyboard shortcuts        | `keybindings.json`                                                     | none                                                | `/keys`, `/reload`; [keybindings](keybindings.md)                     |
| System prompt             | `SYSTEM.md`, `APPEND_SYSTEM.md`                                        | `.octocode/SYSTEM.md`, `.octocode/APPEND_SYSTEM.md` | `/reload`; the workspace file wins                                    |
| Project instructions      | `AGENTS.md` in the agent directory                                     | `AGENTS.md` in the project and its ancestors        | [instructions](instructions.md)                                       |
| Agent profiles            | `agents/*.md`                                                          | `.octocode/agents/*.md` at the repository root      | `/agents`, `/reload`                                                  |
| Hooks                     | `hooks.json` in the runtime home                                       | `.octocode/hooks.json` at the repository root       | `/harness hooks`; [hooks](hooks.md)                                   |
| Plugins                   | `plugins` in `settings.json`                                           | `plugins` in `.octocode/settings.json`              | `/harness`; [plugins](plugins.md)                                     |
| Plugin marketplaces       | `marketplaces` in `settings.json` (global only)                        | not read                                            | `octocode marketplace add`                                            |
| Extensions                | `extensions/` (ignored with a warning)                                 | `.octocode/extensions/` (ignored)                   | User code extensions are not supported; use plugins and hooks         |
| GitHub sign-in (research) | The Octocode CLI's own store                                           | none                                                | `/octocode auth login\|status\|logout`                                |

## Precedence

| Kind        | Order, lowest to highest                                                                                                                                                                                                                                                                                                                                                                           |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Settings    | Pi files, global, trusted project, `--set`. Objects merge recursively, arrays replace                                                                                                                                                                                                                                                                                                              |
| MCP files   | `~/.pi/mcp.json`, `~/.pi/agent/mcp.json`, `~/.octocode/agent/mcp.json`, `~/.octocode/octocodecode/mcp.json`, `~/.octocode/mcp.json`; then trusted `.pi/mcp.json`, `.mcp.json`, `.agents/mcp.json`, `.octocode/mcp.json`                                                                                                                                                                            |
| Skills      | By harness: Octocode > `.agents` > Pi > Claude Code > Codex > Cursor; then project before global. Losers are listed as shadowed                                                                                                                                                                                                                                                                    |
| Credentials | Environment or ambient cloud credentials, `apiKey` in Pi's `models.json`, Pi's `auth.json`, `apiKey` in Octocode's `models.json`, Octocode's `auth.json`, then runtime `--api-key` (highest). A `models.json` field Octocode does not know (a misspelled `apikey`) or an `api` no built-in serves loads with a warning naming the file and provider, shown on that provider's page in `/providers` |
| Keybindings | Pi's `~/.pi/keybindings.json` and `~/.pi/agent/keybindings.json`, then the agent directory's `keybindings.json`, action by action; no project file                                                                                                                                                                                                                                                 |

- A later MCP definition replaces a server of the same name; a later control-only entry (`enabled`, `exposure`, `toolExposure`, `defaultActive`) changes it without copying credentials. Details: [MCP](mcp.md#configure-servers), [MCP reference](mcp-reference.md#configuration-and-precedence).
- Keys the settings schema does not define still load and are preserved on save, with no effect; startup warns once per load naming each (a removed key says what replaced it).
- Settings, MCP and trust files are saved by atomic replacement, and settings saves lock the read-merge-write step, so concurrent writers keep each other's changes. An empty settings file, or one whose root is not a JSON object, is reported as invalid and never overwritten, also if it turns invalid after startup: repair it, then `/reload`.

## Changing configuration

Provider visibility switches are global. An invalid `disabledProviders` value is reported as a settings-load error; an edit does not replace the currently loaded switches until the file is valid.

`defaultProvider` and `defaultModel` choose the starting model for new sessions. Saving or clearing them through configuration reports **next session**; `/reload` does not replace the current chat's model. Use `/model` to switch it. The model picker's **Ctrl+S** action (or **D** while the filter is empty) selects the model and saves the paired default together, after the write is acknowledged. In a trusted project it asks whether to save globally or for this project only (the same project settings file as `/configuration set --local`); in an untrusted project it saves globally. The picker header shows the startup default and whether it comes from global settings, the project or a run override. A trusted project default takes precedence over a global one, so a global save in such a project says that the project default wins.

The web Settings page saves or clears the startup provider and model as one pair in the chosen global or trusted workspace file. Its source badges show the effective precedence; changing the pair keeps the current chat's model.

`/configuration` in a session and `octocode configuration` in a shell are one mechanism over one catalog: tools, MCP servers, harnesses, plugins, hooks, skills, extensions, prompts, themes, providers, sources and every settings key.

```text
/configuration [list|get|enable|disable|set|unset|add mcp|remove] [--local] [--force]
octocode configuration ... [--local] [--trust] [--json]
```

Ids are `kind:name` (`tool:`, `mcp:`, `harness:`, `plugin:`, `hook:`, `skill:`, `extension:`, `prompt:`, `theme:`, `provider:`, `source:`) or a bare settings key such as `retry.maxRetries`.

| Verb                                | Does                                                                   | Example                                                     |
| ----------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------- |
| `list [kind\|text]`, `get <id>`     | Show entries and their state                                           | `/configuration list mcp`                                   |
| `enable\|disable <id>...`           | Switch entries                                                         | `/configuration disable tool:backlog`                       |
| `set <key> <value>`, `unset <key>`  | Change or reset a settings key                                         | `/configuration set retry.maxRetries 4`                     |
| `add mcp <name> ...`, `remove <id>` | Add an MCP server (arguments of `octocode mcp add`) or remove an entry | `/configuration add mcp docs --url https://example.com/mcp` |

Without a verb a terminal opens a selector; otherwise the CLI lists. `--json` prints JSON; a refused change prints its reason with suggested ids and exits 1. Retired, each printing a hint: `/settings`, `/config`, `octocode config`, `/mcp enable|disable|assign|exposure`, `/harness enable|disable`, `octocode mcp enable|disable`.

| Scope   | Selected by                                                       | Written to                                                                                        | Lasts         |
| ------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------- |
| global  | default                                                           | `settings.json` (MCP: `mcp.json`)                                                                 | every session |
| project | `--local` (`-l`)                                                  | `.octocode/settings.json` (MCP: `.octocode/mcp.json`); trusted folder only (`--trust` records it) | this project  |
| run     | `octocode --enable <id>`, `--disable <id>`, `--set <key>=<value>` | nothing                                                                                           | this process  |

Each result says when it applies: now (MCP switches, live settings), after `/reload`, or in the next session. Run flags are repeatable, apply before tools and resources load, survive `/reload` and are never written: `octocode --disable tool:backlog --set retry.maxRetries=4`. A refused id or key prints the reason and exits 1; `mcp:` ids have no run form (use `--no-mcp`). `--tools` and `--exclude-tools` still choose tools for one run. Features register no CLI flags, so unknown flags such as `--extension` fail at startup.

MCP is always on and cannot be switched through `extensions`; a `-builtin:mcp` entry is ignored with a warning. Only `builtin:<id>` entries of `extensions` act (`-builtin:llama.cpp` switches the llama.cpp provider off). Octocode is the default MCP server: `/configuration disable mcp:octocode` turns it off and `enable` brings it back (`OCTOCODE_MCP=0` also turns it off, unless configuration overrides it).

### Harnesses

A harness is one source of configuration. `/harness` opens on an **Overview** tab with one row per section (**Skills**, **MCPs**, **Hooks**, **Sources**, **Extensions**): how many items are on and off (`N on · M off`) and how many wait for approval in `/security`. Empty sections stay visible. **Sources** contains the harness switches below.

| Command                                            | Opens                                                             |
| -------------------------------------------------- | ----------------------------------------------------------------- |
| `/harness`, `/harness overview`                    | The Overview                                                      |
| `/harness skills\|mcp\|hooks\|sources\|extensions` | That section (outside the terminal it prints the section instead) |
| `/harness list [section]`                          | A plain list, for example `/harness list sources`                 |

| Key                               | Action                                                             |
| --------------------------------- | ------------------------------------------------------------------ |
| Enter on the Overview             | Open the selected section.                                         |
| ← / →, Ctrl+← / Ctrl+→            | Change section (plain arrows only while the filter is empty).      |
| Enter; Space with an empty filter | Toggle the selected item, following its approval and trust checks. |
| Tab                               | Change global/project scope.                                       |
| F2                                | Open full details; arrows and PgUp/PgDn scroll.                    |
| Esc                               | Leave details or close the list.                                   |
| Ctrl+R on a load failure          | Retry.                                                             |

Changing section, scope, selection or filter clears an armed disable confirmation. Loading and failures appear in the selector, which remains cancellable.

**Turning on a source.** Switching a source such as Claude Code, Codex or Cursor on first shows **Turn on `<source>`?** with every skill, MCP server and hook it would bring, each scanned by the [security review](#security-review) (static: nothing runs), worst rating first. Enter switches the source on; Esc writes nothing. The items stay off until you approve them in `/security`. `/configuration enable harness:<id>` prints the same list and then switches.

**MCP servers.** In the **MCPs** section Space switches a server on or off. Enter or → on a server opens its tools:

| Row               | Meaning                                                                                                           | Change with                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Available to      | `every agent`, or `only agents whose profile tools: names mcp__<server>__` (the server's `defaultActive` setting) | Space                                                            |
| Default for tools | The server's exposure (`direct`, `deferred` or `hidden`) for tools without a pin                                  | Tab                                                              |
| Each tool         | The tool's state; a pin overrides the server default                                                              | Space hides or unpins, Tab cycles `direct`, `deferred`, `hidden` |

← or Esc goes back. A server that is not connected lists its pinned tools and tells you to connect to list the rest. Changes apply from the next session. Details: [MCP tool exposure](mcp.md#control-tool-exposure).

| Harness    | Reads                                   | Default   |
| ---------- | --------------------------------------- | --------- |
| Octocode   | Its own files                           | always on |
| `agents`   | `.agents/skills`, `.agents/mcp.json`    | on        |
| `mcp-json` | root `.mcp.json`                        | on        |
| `pi`       | Pi skills, prompts, themes, MCP         | on        |
| `claude`   | Claude Code skills, MCP, hooks, plugins | off       |
| `codex`    | Codex skills, MCP, hooks, plugins       | off       |
| `cursor`   | Cursor skills, MCP                      | off       |

Switch one with `/configuration enable|disable harness:<id> [--local]` (writes `toggles["harness:<id>"]`, removed when it equals the default), or on the Harness panel of the [web Settings page](web-workspace.md#settings-page).

- A project key reaches only that harness's project items, so a committed file cannot enable your global Claude Code content.
- MCP servers connect or disconnect at once, also in running subagents; skills, hooks and prompts apply after `/reload`.
- A plugin listed in `plugins` is your explicit choice and loads whatever its harness switch says.
- `harness:claude:memory` (off, global only, trusted folders only) adds Claude Code's auto memory for this repository (`~/.claude/projects/<repository>/memory/MEMORY.md`, first 200 lines or 25 KB; when the file is longer, the note says so and names the file) as notes; `AGENTS.md` and Octocode memories win; the file is never written.
- Project instructions come only from `AGENTS.override.md` and `AGENTS.md`; `CLAUDE.md` is not read.

The startup screen and read-only `/harness config` show each kind with its count and sources (`octocode global`, `pi project`, `plugin <name>`, `builtin`, `command line`, `settings path`), shadowed copies with their winner, project items in an untrusted folder as "folder not trusted", and Pi code that is not run as "Not loaded". `ctrl+o` expands paths. The view refreshes on `/reload` or a new session; items of a switched-off harness are neither counted nor warned about.

### Tool exposure

A session declares each tool to the model in one of four states. The state is fixed when the session starts, so the cached prompt does not change while it runs.

| State      | The model gets                                                                                                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `direct`   | The tool's full description and parameter schema                                                                                                                                   |
| `deferred` | The description and the field names with their types (an MCP tool also names the fields of its objects and lists); the tool stays callable, and a rejected call returns the schema |
| `onDemand` | Only a line in the prompt's tool index; the tool is callable, and its first call or a read with the `mcp` tool declares it from the next request on, after the cached prompt       |
| `hidden`   | Nothing: the tool cannot be called (MCP tools only)                                                                                                                                |

What decides the state, first match wins:

| Tools                                     | Decided by                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| An MCP tool                               | Its `toolExposure` entry in `mcp.json` (a pin), then its server's `exposure`, then the `mcpExposure` setting |
| `web`, `archive`, `models`, `backlogPlan` | Its `nativeToolExposure` entry in `settings.json` (a pin: `direct` or `deferred`), then `mcpExposure`        |
| Every other native tool                   | Always `direct`                                                                                              |

`mcpExposure` is `"recent"` by default: a tool without a pin is `direct` while this working directory called it in the last 24 hours and `deferred` otherwise, so a tool unused for a day is deferred again. A resumed session in the same folder keeps the MCP and native tool states it started with ([MCP reference](mcp-reference.md#exposure-and-results)). A pin beats that rule. `"direct"` declares every tool without a pin in full, as earlier versions did.

| `mcpExposure`    | A tool without a pin is                                                              |
| ---------------- | ------------------------------------------------------------------------------------ |
| `"recent"`       | `direct` if this working directory called it in the last 24 hours, else `deferred`   |
| `"direct"`       | `direct`                                                                             |
| `"deferred"`     | `deferred`, and an MCP server's block lists only each tool's name and trigger        |
| `"auto:<bytes>"` | MCP servers `direct` in name order while their text fits the budget, then `deferred` |

```json
{
	"mcpExposure": "direct",
	"nativeToolExposure": { "web": "direct", "models": "deferred" }
}
```

`onDemand` applies only where the model's provider can add a tool after the cached prompt (Anthropic and OpenAI models that support it); elsewhere such a tool is `deferred`, and a switch to such a model declares the unused ones `deferred`. The bundled Octocode server sets it for its GitHub, package-registry and security tools, and `web`, `archive` and `models` take it whenever they would be `deferred`; a `nativeToolExposure` pin opts one out. A resumed session declares again what it had loaded. The Tools panel shows `onDemand` tools as `deferred`.

See each tool's state and pin it on the Tools panel of the [web Settings page](web-workspace.md#settings-page), or edit the files; `/harness mcp` → the server → **Default for tools** sets a whole server. A pin applies from the next session. Details: [MCP tool exposure](mcp.md#control-tool-exposure).

## Trust

Octocode opens no session in a folder you have not trusted. Before the decision nothing is read from the folder (no `AGENTS.md`, settings, MCP, hooks, skills, agents, plugins or `SYSTEM.md`), no model is called and no tool exists.

```mermaid
flowchart TD
    A[octocode starts in a folder] --> B{Trusted?}
    B -- yes --> R[load project configuration]
    B -- refused before --> X["exit with hint: /trust or octocode trust add"]
    B -- undecided --> C{Interactive?}
    C -- yes --> D["prompt: folder, parent, grandparent, Not now, Do not trust"]
    C -- "print / JSON / RPC" --> E["exit non-zero (use --trust)"]
    D -- trust --> R
    D -- Not now --> X2[exit, nothing recorded]
    D -- Do not trust --> X
```

| Rule          | Behavior                                                                                                                                                                                                                                                                                              |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Grants        | The folder, its parent or its grandparent (a subtree); future contents are covered. A grant follows the folder by file identity (survives rename, move, reboot). `$HOME`, `/` and filesystem roots never get a session or grant; nothing above `$HOME` gets a subtree grant                           |
| ACP           | `session/new` answers a per-session `-31000` error whose `data.command` names the fix                                                                                                                                                                                                                 |
| `--trust`     | Records a grant (source `flag`) and runs; not for `--mode acp`                                                                                                                                                                                                                                        |
| In a session  | `trust add\|remove` and `--trust` refuse when `OCTOCODE_SESSION_ID` is set: trust is your decision, run them in your own terminal                                                                                                                                                                     |
| Moving folder | `/resume`, `/import`, a new session or `/worktree switch` with a `cwd`, and RPC `switch_session` check trust first; declining keeps the old session                                                                                                                                                   |
| Instructions  | `AGENTS.override.md` and `AGENTS.md` load from the grant's folder down to the working folder, never from a parent repository above the working folder's own ([instructions](instructions.md))                                                                                                         |
| Worktrees     | A new one (`/worktree`, `--worktree`, isolated subagents) asks once before creation (headless: `--trust`); yes records a `worktree` grant that removing the worktree revokes. An isolated subagent's worktree is granted without asking when its source repository is trusted. Subagents never prompt |
| Old files     | `trust.json` and `pi-trust.json` from earlier releases are not read: run `octocode trust add <path>`                                                                                                                                                                                                  |

| Command                                                                                             | Does                                               |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `/trust`, `/trust list`                                                                             | Menu; list grants, refusals, ignored grants        |
| `/trust add [path] [--scope folder\|parent\|grandparent]`                                           | Grant                                              |
| `/trust remove <number\|path>`                                                                      | Revoke                                             |
| `octocode trust list [--json]`, `add [path] [--scope ...] [--yes]`, `remove <number\|path> [--yes]` | Same without a session; `--yes` skips confirmation |

Project resources need trust, except `AGENTS.md`-style instruction files, which load as text. Octocode hook files always load; Claude Code and Codex hook files load once that harness is on (`/configuration enable harness:claude`), each under its own profile; `disableAllHooks: true` in a loaded hook file turns them all off; [Claude permission rules](permissions.md#claude-permission-rules) always apply. See [hooks](hooks.md).

## Security review

Trust lets a folder's configuration load; the security review decides each hook, MCP server and skill that Octocode did not ship. Such an item stays off until you have checked its report and approved its exact content. Octocode's own skills and MCP server always load, and a session never waits for a decision.

```mermaid
flowchart TD
    L[A session loads a hook, MCP server or skill] --> S{Shipped with Octocode?}
    S -- yes --> ON[loads]
    S -- no --> D{Your decision for this exact content}
    D -- approved --> ON
    D -- "not checked, denied, or approved but changed since" --> OFF["off; counted in the start-up line and /security"]
```

| Rule           | Behavior                                                                                                                                                                                                                                                                                                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| States         | `not checked`, `approved`, `denied`; an approved item whose content changed shows `not checked · changed` and is off until you approve it again                                                                                                                                                                                                                                         |
| What is pinned | A hook: its definition and the script files its command names. An MCP server: command, arguments, URL, variable/header names, and digests of configured `NODE_OPTIONS` and `PATH` values; other literal values and resolved environment values are not pinned. A skill: every file of its folder, including linked files (up to 500 files, 8 MB); linked directories cannot be approved |
| Rating         | `LOW` to `CRITICAL` from what the item can do and a static scan (download-and-run, decoded code, credential paths, edits to agent configuration, hidden characters, unpinned packages, plain HTTP). The report says what was checked; it never calls an item safe                                                                                                                       |
| Upgrade        | The first run with the review records the global hooks, MCP servers and skills already present as approved and prints one line; repository items are never recorded this way                                                                                                                                                                                                            |
| Scope          | A repository's items are decided once for all its worktrees; global items once for every folder                                                                                                                                                                                                                                                                                         |
| Plugins        | Plugin MCP servers are reviewed when the plugin is installed; plugin hooks are reviewed here                                                                                                                                                                                                                                                                                            |
| The agent      | Cannot approve: not through a tool, its shell, `--trust` or bypass mode                                                                                                                                                                                                                                                                                                                 |
| Store fault    | If the decisions cannot be read, items load and a warning says so                                                                                                                                                                                                                                                                                                                       |

| Setting            | Default                      | Does                                                                                                                                                      |
| ------------------ | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `security.enforce` | `["hooks", "mcp", "skills"]` | The kinds that stay off until approved. A kind left out is still rated and listed but loads unchecked. Global only: a project settings file cannot set it |

| Command                                              | Does                                                                                                                                     |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `/security`                                          | Page: not checked, approved and denied items; Enter opens a report with Approve and Deny. Decisions apply with one reload when you leave |
| `/security list [text]`, `show <id>`, `check`        | List items, show one report, or list what is not approved with ratings and findings                                                      |
| `/security approve <id>`, `deny <id>`, `forget <id>` | Record or remove a decision                                                                                                              |
| `/security approve --all [--kind hooks,mcp,skills]`  | Approve every waiting item at its current content, except `CRITICAL` items and items not read in full                                    |
| `octocode security ...`                              | The same verbs without a session. `approve`, `deny` and `forget` refuse inside a session's shell                                         |

For a headless run, approve in a setup step on a checkout you trust, before the run: `octocode security approve --all`. Do not run it after checking out someone else's changes, which would approve their hooks and servers.

## Pi configuration fallback

Octocode and Pi provider sources are enabled by default; no import step is required. With the default home, Octocode also reads `~/.pi/agent/` and `~/.pi/` (in that order); Octocode wins.

For providers only, the Octocode Pi extension's folders come first: `models.json` and `auth.json` are read, read only, from `~/.octocode/agent/` and `~/.octocode/`, then from Pi's folders. Nothing else is read there. The order for a provider is Octocode's home, `~/.octocode/agent/`, `~/.octocode/`, `~/.pi/agent/`, `~/.pi/`; the first definition wins. Turning the `pi` provider source off stops all of these.

| Item                    | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `models.json`           | Providers missing from Octocode come from Pi; an Octocode provider replaces the whole Pi provider                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `settings.json`         | Inherited lowest first: Pi global, trusted `<project>/.pi/settings.json`, Octocode global, trusted `.octocode/settings.json`. Not inherited: resource keys (`packages`, `extensions`, `skills`, `prompts`, `themes`) and per-install keys (`sessionDir`, `deviceId`, `trackingId`, `enableAnalytics`, `defaultProjectTrust`); a project `.pi/settings.json` cannot set `remote.autoStart`. Pi settings are read-only: a save writes only Octocode's values. A Pi file that does not parse is a startup warning                                                                       |
| `mcp.json`              | Inherited under the [MCP order](#precedence); control changes save native overrides                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Credentials             | A provider with no Octocode credential and no `apiKey` in Octocode's `models.json` uses Pi's `auth.json` entry, read only. Secret-command keys, entries Octocode does not recognize and account sign-ins Octocode cannot use (Pi's Claude Pro/Max) are skipped; an unreadable file or entry is a startup warning naming the file. Login, logout and refresh write Octocode's file only. `/providers pi` copies a credential after confirmation ([providers](providers.md#use-pi-configuration)). Sessions, trust decisions, device identity and telemetry consent are never imported |
| Skills, prompts, themes | Pi directories are read like Octocode's, under the `pi` harness switch; missing Pi packages are not installed                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Instruction files       | Pi's global `AGENTS.md` loads only when the Octocode directory has none; `SYSTEM.md` and `APPEND_SYSTEM.md` apply when no Octocode file does; project `AGENTS.md` is shared. In a trusted folder `.pi/skills`, `.pi/prompts`, `.pi/themes`, `.pi/SYSTEM.md`, `.pi/APPEND_SYSTEM.md` are read; nothing in `.pi/` is read in an untrusted folder                                                                                                                                                                                                                                       |
| Pi code                 | Never runs. TypeScript in Pi's `extensions/` and `hooks/` folders and Pi extension packages are listed as "Pi extension, not loaded" with a hint to use `hooks.json` or a plugin. A package's `package.json` declares its resources under `octocode`; Pi's `pi` key is not read                                                                                                                                                                                                                                                                                                      |
| Switch                  | Pi skills, prompts, themes and MCP follow `harness:pi`; models, settings and keybindings load regardless                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Same name in both products:

| Files                                                                | Order, winner first                                                                                         |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Collections (skills, prompts, themes)                                | Scope first, then product: project Octocode, project Pi, global Octocode, global Pi (skills: harness first) |
| Single-valued (global context file, `SYSTEM.md`, `APPEND_SYSTEM.md`) | Product first: Octocode project, Octocode global, Pi project, Pi global                                     |

A Pi item in an untrusted folder shadows nothing. The first start that finds Pi items prints a one-line notice once, recorded in `pi-notice.json` in the agent directory (delete it to see it again). `/harness config` lists `models.json`, `settings.json` and `mcp.json`, agent profiles, hooks and plugins with product, scope, source file and shadowing item; layered files (`models.json`, `settings.json`) are read in full, so none shows as shadowed. An MCP `enabled` or `exposure` entry without `command` or `url` is a control-only override, listed apart from definitions.

## Terminal images

Inline images are on when the terminal supports them; `/configuration` (**Interface and session**) exposes **Show images** and **Image width**. Model image input is separate: [models](models.md#describe-model-input-and-caching).

```json
{ "terminal": { "showImages": true, "images": "auto", "imageWidthCells": 60 } }
```

Detection recognizes Kitty (`TERM=xterm-kitty`) and queries interactive terminals at startup; a negative reply falls back to text, silence keeps the environment-based choice. `terminal.images` set to `"kitty"` or `"iterm2"` forces a protocol, `false` disables graphics, and beats `OCTOCODE_IMAGE_PROTOCOL` (`kitty`, `iterm2`, `none`, `auto`). In tmux, Kitty images are enabled only for a Kitty or Ghostty client with `allow-passthrough` on and 24-bit colour reaching the client; other tmux sessions, screen and Rex stay off. iTerm2 images work in regular mode; fullscreen uses text placeholders.

## Terminal output and pacing

Octocode asks the terminal at startup whether it supports synchronized output (mode 2026). When it confirms, each fullscreen frame is shown whole and pointer scrolling paints up to 120 frames a second; when it does not answer (Terminal.app), frames are written without the markers and paced to one per 60 Hz refresh, the rate such a terminal paints. The period runs from the start of one frame to the start of the next. While a large output streams, pointer frames keep this pace until the queue reaches the limit below; other frames wait once 256 KiB are queued.

A terminal that stops reading (a paused tmux pane, a stalled SSH link) would otherwise collect every frame painted meanwhile. Once more than `fullscreenFrameQueueLimitKiB` (default 512) is queued, new fullscreen frames are dropped and the screen is repainted whole when the terminal reads again; mode, restore and status bytes are always written, and regular mode never drops output because its rows become scrollback. `0` keeps every frame.

```json
{ "fullscreenFrameQueueLimitKiB": 512 }
```

### Redraws in regular mode

In regular mode the transcript lives in the terminal's scrollback, which the terminal cannot edit. When the width changes, when Octocode returns from the background (`fg` after Ctrl+Z), or when a row above the screen changes size, Octocode clears the screen and scrollback and writes the transcript again. `terminal.replayRows` (default 5000) bounds that redraw: only the last rows are written, after one marker row that says how many earlier rows were left out. The screen shows the same rows either way. Set it to `0` to write every row.

```json
{ "terminal": { "replayRows": 5000 } }
```

## No color

A non-empty `NO_COLOR` or `TERM=dumb` removes every ANSI color sequence (foreground, background, tints, diff tints, shimmer); bold, dim, underline and inverse stay. An empty `NO_COLOR` is ignored. It does not reduce motion. `terminal.trueColor` and `OCTOCODE_TRUE_COLOR` choose only the color depth. HTML exports made with these set are plain text on the themed page.

## Reduced motion

`terminal.reduceMotion` is `true`, `false` or `"auto"` (default): spinners stay on their first frame and the shimmer is plain; elapsed times and retry countdowns still tick. `"auto"` follows `OCTOCODE_REDUCE_MOTION` (`1` or `true`); an explicit value wins. `/configuration` exposes **Reduce motion** and applies it at once.

```json
{ "terminal": { "reduceMotion": "auto" } }
```

## Shell completion

A line that starts with `!` (or `!!`) is a shell command. **Tab** opens completions from your own shell: subcommands, options with their descriptions, branches, paths, everything your `.zshrc` or `.bashrc` set up. While you type, **ghost text** shows the rest of a likely command; **Right** or **End** accepts it, **Alt+Right** (word right) accepts its next word.

```mermaid
flowchart LR
  T[Tab on a ! line] --> Trust{Folder trusted?}
  Trust -->|yes| Shell[Your shell's completion]
  Shell -->|nothing| Path[Program names, git branches]
  Trust -->|no| Path
  Path -->|nothing| Carapace[carapace, if installed and trusted]
  Carapace -->|nothing| Files[File paths]
  Y[Typing after !] --> Reply[Command from the agent's last reply]
  Reply -->|none| History[Your earlier ! commands]
  History -->|none, after a pause| Model[Cheapest connected model]
```

| Setting                        | Default  | Effect                                                                                                                                                                                                                                                                                                         |
| ------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `terminal.completion.shell`    | `"auto"` | Which shell answers Tab: `"auto"` follows your login shell (`$SHELL`; PowerShell on Windows without it), or `"zsh"`, `"bash"`, `"fish"`, `"pwsh"`. `"none"` starts no shell.                                                                                                                                   |
| `terminal.completion.loadRc`   | `true`   | Start that shell with your startup files, so plugin completions work. `false` loads only the shell's own completion system.                                                                                                                                                                                    |
| `terminal.completion.carapace` | `true`   | Ask [carapace](https://carapace.sh) for a command your shell cannot complete, when `carapace` is on `PATH`.                                                                                                                                                                                                    |
| `terminal.suggestions.history` | `true`   | Ghost text from the agent's last reply and your `!` history.                                                                                                                                                                                                                                                   |
| `terminal.suggestions.model`   | `true`   | When nothing matches, ask the cheapest model among the providers you are signed in to (the `small` tier). Each pause in typing costs one small call, recorded in the session's usage. With no cheaper model connected nothing is asked. Read from the global settings: a project file can turn it off, not on. |

```json
{ "terminal": { "completion": { "shell": "auto", "loadRc": true }, "suggestions": { "model": false } } }
```

- **Trust:** completion functions run programs (git completion runs `git`, which a repository's configuration can turn into running other programs), so the shell and carapace run only in a trusted folder. Elsewhere Tab offers program names, branch names read from `.git` and paths.
- **One shell per session:** it starts on the first Tab, in the session's folder, with the same environment as `!` commands, and stops with the session. A shell that hangs is restarted; one that cannot start (a startup file that waits for input or replaces the shell) is left off for the session and Tab falls back to paths. Nothing it does reaches your shell history.
- **Startup files:** the shell starts with `OCTOCODE_SHELL_COMPLETION=1`, so a startup file can skip work it does not need there, and with oh-my-zsh's update prompt and tmux auto-start turned off (`DISABLE_AUTO_UPDATE`, `DISABLE_UPDATE_PROMPT`, `ZSH_TMUX_AUTOSTART=false`). A startup file that waits for input or `exec`s another program prevents completion for that session.
- **History:** your `!` commands are kept per folder in the agent database (the newest 5,000), ranked by folder, frequency, recency and whether they last succeeded.

## Runtime storage

Session writers keep JSONL transcripts, the record of every session, and mirror the header and ordered entries, with the compaction summaries, to the transcript mirror (`transcripts.db`): a derived index of the session files, rebuilt from them when it is missing or behind. The agent database (`workspaces.db`) holds what every Octocode process coordinates through: workspace identities, session metadata, backlogs, history, memories, team coordination and command receipts. Settings and credentials stay in files. One connection is shared per database file; each file has one background database thread per process, which writes after the transcript (so a busy database never pauses input) and checkpoints the file's write-ahead log, shrinking it once its writes stop. The separate agents-communication database (`~/.octocode/agents-communication/`) is read-only to Octocode.

Each workspace declares its UUID in `.octocode/code/workspace/id`: starting in a subdirectory uses the nearest declaration, a new Git worktree gets its own, names are display labels that may repeat, a same-filesystem rename keeps the id, and copying a marker cannot claim another database's records.

| Location                                                  | Contents                                                                                                                    |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `<octocode home>/agent/workspaces.db`                     | All registered workspaces and their coordination                                                                            |
| `<octocode home>/agent/transcripts.db`                    | The transcript mirror: session entries and compaction summaries, rebuildable from the JSONL transcripts                     |
| `.octocode/code/sessions/`                                | Default JSONL transcripts (explicit session directories win)                                                                |
| `.octocode/code/session-data/<session>/`                  | Per-session artifacts: compaction archives, checkpoints                                                                     |
| `.octocode/code/temp/`                                    | Scratch, tool output, child handoffs                                                                                        |
| `.octocode/code/agents.txt`, `backlog.md`, `backlog.html` | Generated activity and exported backlog snapshots                                                                           |
| `<octocode home>/child-credentials/`, `agent/job-owners/` | Child credentials, background process ownership; job output stays in scratch                                                |
| `<octocode home>/archive/`                                | Gzip JSONL history archives (below)                                                                                         |
| `<octocode home>/web/`                                    | Web daemon: its record, and one owner-only attach record per running session ([web workspace](web-workspace.md#web-daemon)) |

Sessions written before the move live in `<octocode home>/sessions/--<working directory>--/`; `/resume`, `--continue` and `--session <id>` still list those whose header names the current directory (`/resume all` lists every such folder), and opening one keeps writing beside it. `octocode --fork <full-session-id>` recreates a session in the current workspace from stored entries when its file is gone. Team coordination and project-scoped memories span linked worktrees; backlogs and workspace memories belong to one workspace. The catalog keeps entries after a checkout is removed.

**Database versions.** Octocode does not convert a database from another version. A database at the current version is used as it is. One at an older version is renamed to `<file>.v<version>.retired` (with its `-wal` and `-shm` files) and a new, empty one is created, so backlog items, memories and history start empty; the retired file is never read again and can be deleted. One at a newer version is refused with a message and left unchanged: update Octocode, or point `OCTOCODE_AGENT_DB` at another file. Session files follow the same rule without the rename: a transcript written in another session format is refused when opened and stays as it is.

**Retention.** `0` keeps a class forever. A project file cannot set either value; the environment wins; a non-whole-number or negative value is ignored (a bad setting is a warning).

| Setting (global)        | Default | Environment                       | Governs                                                                                                                                                                  |
| ----------------------- | ------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `retention.days`        | 30      | `OCTOCODE_CLEANUP_DAYS`           | Output, bash logs, checkpoints, folders of unlisted sessions, subagent scratch and screenshots, `.octocode/tmp` entries, compaction detail copies, database history rows |
| `retention.sessionDays` | 90      | `OCTOCODE_SESSION_RETENTION_DAYS` | Transcripts in `.octocode/code/sessions/` and the legacy folders                                                                                                         |

One sweep runs at session start, off the start path, at most every 6 hours, over every registered workspace whose root exists (`.octocode/code` and `.octocode/tmp` only), the global session folder and the legacy folders. An expired transcript goes with its session folders and rows, as with the delete commands. The current session, a running session, an unreadable directory and a live bash job are never removed; symlinks are not followed; a listing failure removes nothing. One summary line is shown as a warning when something was removed or failed.

**History archive.** Rows of the backlog audit, configuration audit and workspace command histories older than 14 days move to owner-only gzip JSONL files per table family and UTC month in `<octocode home>/archive/`; archived rows older than `retention.days` are dropped. Agent runs and agent events older than `retention.days` are dropped without an archive; each workspace keeps its newest event. Backlog items, notes and comments are never deleted by age. A main session runs this at most once a day per process, after the first backlog access, in short write transactions; each batch is archived before it is deleted. Every process also stores a memory sample every 5 minutes (deleted after 7 days; `OCTOCODE_PROCESS_SAMPLE_MINUTES`, `0` stops it) for `/processes`.

Positive process sample intervals are bounded to 1–2,147,483,647 milliseconds; invalid or negative values use the default. A slow process listing skips elapsed intervals rather than queuing further work.

## Retries

A transient model failure is retried up to `retry.maxRetries` times (default 3), waiting `retry.baseDelayMs` (default 2000) doubled per attempt, never more than `retry.maxAgentDelayMs`. `retry.maxRetries: 0` and `retry.enabled: false` turn retries off; account quota and billing errors fail at once.

| Failure class                                                                                                                                                                                                                                    | Policy                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rate limits (`429`, "too many requests") and capacity or transport failures (`overloaded`, `502`, `503`, `504`, `520`, `524`, `529`, `server_busy`, "at capacity", connection reset, closed socket or websocket, `terminated`, early stream end) | At least six retries even if `retry.maxRetries` is lower (those beyond the configured count only within three minutes of the first failure). Wait spreads by up to half again the backoff, is at least the provider's `retry-after` plus up to 1 s, and stays capped by `retry.maxAgentDelayMs` |
| No route to the network (`ENETUNREACH`, `EHOSTUNREACH`, `ENETDOWN`, `EAI_AGAIN`: sleep, VPN drop, network switch)                                                                                                                                | Retried for up to ten minutes from the first failure, at most 30 s apart, so a run continues when the connection returns. `ENOTFOUND` (a host that does not exist) keeps the configured count                                                                                                   |
| Other retryable errors                                                                                                                                                                                                                           | Configured count and exact backoff (some never clear, and each attempt resends the context)                                                                                                                                                                                                     |

### When a model keeps failing

Three failures move the turn to another model when you list models in `retry.fallbackModels`:

| Failure                                                                                  | Example                                                                                                | Skipped afterwards           |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------- |
| Usage limit (quota, plan or billing limit, no funds): not retried, it resets after hours | `429 insufficient_quota`, `FreeUsageLimitError`                                                        | That model                   |
| Refused credential: not retried                                                          | `401`, `403 Forbidden`, `invalid api key`, an expired sign-in (`OAuth refresh failed … invalid_grant`) | Every model of that provider |
| Outage that outlasts the retries above                                                   | `503` after six retries, `fetch failed` after three                                                    | That model                   |

List models to continue on in order, as `provider/id` with an optional `:thinking` level:

```json
{ "retry": { "fallbackModels": ["openrouter/some-model", "openai/other-model:high"] } }
```

```mermaid
flowchart LR
  E[Usage limit, refused credential<br/>or outage after retries] --> L{Next listed model:<br/>signed in, not skipped,<br/>window holds the context?}
  L -->|yes| S[Becomes the session model<br/>with a notice] --> C[Turn continues]
  L -->|none left| F[Turn ends with the error]
```

| Behavior        | Detail                                                                                                                                                                                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Default         | Empty list: the turn ends with the error                                                                                                                                                                                                                                                                                             |
| Stays selected  | The session keeps the fallback model; `/model` switches back. Switching back by itself would pay for a cold prompt cache twice                                                                                                                                                                                                       |
| Skipped entries | No credentials, a failure within `retry.fallbackCooldownMs` (default 15 minutes; `0` retries a failed model at once) (for a refused credential, any model of that provider), or a context window that cannot hold the conversation plus the room kept free for compaction (compacting first would run on the model that just failed) |
| Billing         | The notice says when the switch moves from a subscription plan to per-token billing, or back: `billed per token instead of by plan`                                                                                                                                                                                                  |
| Virtual models  | A usage limit goes to the router once per failing model, so it can pick another model; the selection stays virtual and the list is not used. Other failures end the turn                                                                                                                                                             |
| Subagents       | A subagent whose model a purpose (`small`, `medium`) chose gets its own list instead: up to two models the same purpose resolves to on other providers, skipping refused ones. A subagent given a named model uses your list. New routes avoid a provider that reported a usage limit or refused its credential                      |
| Rate limits     | A plain `429` is not a usage limit: it is retried on the same model as above                                                                                                                                                                                                                                                         |

Compaction and branch summaries use the same policy; Esc stops a wait. After a subagent fails on a rate limit, the parent holds new subagent starts for 5 seconds, doubling to 30 for each further failure, and resets after a quiet minute.

## Compaction

Automatic compaction is always on; `/compact` runs the same flow by hand. No setting, CLI flag or RPC command changes it, and legacy `compaction` settings are ignored.

| Part               | Rule                                                                                                                                                                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kept               | Up to 20,000 recent tokens (a quarter of smaller windows)                                                                                                                                                                                                 |
| Reserve            | The larger of 16,384 tokens (an eighth of smaller windows) and the thinking budget plus 12,288, capped at a sixth of the window. A 200,000-token window compacts at 183,616 tokens with thinking off, 171,328 at `high`                                   |
| Failures           | Automatic compaction stops after three in a row; a successful manual one resets the count; cancelling is not a failure                                                                                                                                    |
| Summary cache      | Reuses the session transcript and cache preferences when the summary model is the session's and it is not an overflow. A cold cache, a physical-model switch since the last reply or an instruction or tool update sends it with `cacheRetention: "none"` |
| Standalone summary | After a downshift, overflow or failed cache-sharing: no cache markers or routing id (OpenCode keeps its required `x-opencode-session` header)                                                                                                             |
| Old tool results   | Cleared when the cache is rewritten anyway or when re-sending them costs more than one cache rewrite, only when enough space is recovered, and only after saving a readable copy ([rule](native-features.md#clearing-old-tool-results))                   |
| Transcript         | Every original entry stays on disk; compaction also saves searchable Markdown archives for the `archive` tool                                                                                                                                             |
| Summary output     | A standalone summary (compaction, split-turn prefix, branch summary) may write up to 32,768 tokens, or the model's own limit when lower; one that reaches it fails and saves nothing. The cache-shared summary keeps its cap of 80% of the reserve        |
| Summary thinking   | A standalone summary thinks at the session's level up to `low` (`off` and `minimal` stay). The cache-shared summary keeps the session's level, since changing it would discard the cached messages                                                        |
| Progress           | The status line shows how long the summary has been written and about how many tokens arrived, updated once a second                                                                                                                                      |
| Silent summary     | An attempt that receives nothing for `httpIdleTimeoutMs` (default 5 minutes; `0` disables) is cancelled and retried by the `retry` policy; a summary that keeps arriving is never cut off                                                                 |

## Prompt cache warming

Global `cacheWarming`: `"off"`, `"streaming"` (refresh while the agent is active) or `"idle"` (default; also after it settles). Project settings cannot enable paid warming.

```json
{ "cacheWarming": "idle", "cacheRetention": "long" }
```

A refresh replays the request with a one-token cap, needs a known cache lifetime and a replay-safe request, and never runs returned tool calls. It stops when context changes, the deadline is missed, a refresh fails or the provider reports no cache read. Active warming ends one hour after the original request; idle warming after thirty minutes or one cache lifetime, whichever is later. `/status` shows usage. Savings are not guaranteed: [prompt caching](prompt-caching.md). How requests are built and kept small (tool exposure, clearing, compaction, fencing): [request flows](harness-flows.md).

## Early tool start

`toolExecution.earlyStart` (default `false`) lets a read-only call start while the model's reply is still streaming, as soon as the model has finished writing that call. Only a read that the current permission mode allows without asking qualifies: an MCP tool its server entry declares read-only, or a tool that declares itself read-only. Anything that could write or run a command waits for the reply to end, and so does a call a `PreToolUse` hook matches (the hook then runs once, and never for a call that is thrown away) or a read that turns out to need an answer (a source rule or hook that asks, untrusted text in its arguments, a credential read): no dialog opens while the reply streams, and the call is judged again normally once it ended. A call that was started early but never ran leaves no permission audit entry. If the reply is cut off by the output limit, the early calls are discarded and every call in it gets the output-limit error, so send them again.

```json
{ "toolExecution": { "earlyStart": true } }
```

## Long cache retention on custom hosts

With `cacheRetention: "long"`, Anthropic-compatible models send one-hour cache points (`cache_control.ttl: "1h"`) only on hosts whose documentation verifies the tier: `api.anthropic.com` and `opencode.ai`. Every other host (gateways, a `models.json` provider on its own URL) stays on the five-minute tier. If your host passes the one-hour tier through, opt in per model in `models.json`:

```json
{
	"providers": {
		"my-gateway": {
			"api": "anthropic-messages",
			"baseUrl": "https://llm.example.com",
			"models": [{ "id": "claude-sonnet-4-5", "compat": { "supportsLongCacheRetention": true } }]
		}
	}
}
```

`false` forces the five-minute tier for a model or region that rejects `ttl`; an explicit value always wins over the host list. OpenAI-style models use the same field for 24h retention. Field reference: [models.json](models-configuration.md).

## Agent labels on requests

Set `OCTOCODE_REQUEST_AGENT_HEADERS=1` to label every model request of a custom provider (one from `models.json` or an extension) with the agent that sent it, so a gateway or test server can tell a subagent's requests from its parent's.

| Header              | Value                                                    |
| ------------------- | -------------------------------------------------------- |
| `x-octocode-agent`  | The subagent's id, or `main` for the session itself      |
| `x-octocode-role`   | The subagent's profile (sent only by a subagent)         |
| `x-octocode-parent` | The id of the agent that started it (only by a subagent) |

Subagents inherit the variable. Built-in providers never receive these headers, and a `headers` entry you set on the provider or model with the same name wins.

## Long shell commands

A foreground `bash` command moves to the background as a job after `bashBackgroundAfterSeconds` (default 90; `0` turns the move off). A command that is known to run long moves sooner, so the turn is not held. Recognised out of the box: test runners (`vitest`, `jest`, `pytest`, `cargo test`, `go test`), `yarn`/`npm`/`pnpm` `test`, `check`, `build`, `dev`, `serve` and `start`, `tsc -b`, and commands that follow a stream (`tail -f`).

| Setting                        | Default | Effect                                                                                                                                                   |
| ------------------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bash.longCommandAfterSeconds` | `30`    | Seconds a recognised long command runs in the foreground before it moves; used only when shorter than `bashBackgroundAfterSeconds`                       |
| `bash.longCommandPatterns`     | `[]`    | Regular expressions for more long commands, added to the built-in ones. A pattern matches where a command starts (the line, or after `;`, `&`, `         | `, `(`, `VAR=value`) and must end at a space or the end of a part; an invalid pattern is ignored |
| `bash.deliberateMaxSeconds`    | `600`   | The longest a call that names its own `timeout` holds the turn before its command moves to the background; the command is still stopped at its `timeout` |

```json
{ "bash": { "longCommandPatterns": ["bazel\\s+(?:test|build)", "make\\s+(?:test|check)"] } }
```

A command the shell runs under another name (a wrapper script) is not recognised and keeps the `bashBackgroundAfterSeconds` threshold. Hints for GNU tools missing on macOS (`timeout`, `sed -i`) are shown only on macOS.

## Wake hold window

A child's report, a background job's exit or team mail starts a turn of an idle session at once. Reports and exits that arrive seconds apart each cost a turn that re-reads the whole prompt. `subagents.wakeHoldSeconds` (default `0`, off; at most `10`) makes an idle session hold a wake: the first one opens the window, and everything that arrives before it closes is delivered together and starts one turn.

```json
{ "subagents": { "wakeHoldSeconds": 2 } }
```

A wake costs up to that many seconds of latency, so leave it off unless several children or jobs routinely finish within seconds of each other. A session that is already running a turn is not delayed. When the session ends inside the window, what is held is delivered without starting a turn.

Every woken batch also leaves one dim row in the transcript, `⚡ woke · report jolly-reef done (B526) · job bash-5 exit 0 · 4s`; expand it for one line per event. The row is not sent to the model. An idle-item nudge (an ongoing item you hold that nothing works on) is skipped when the run that just ended wrote that item (a note, completion, claim, close or step, or a delegation to it) or when a running background `bash` job names it with its `item`; the turn line counts the skipped nudges (`1 nudge dropped`). Being woken about an item does not skip it, and a skipped item is named after a later run that left it alone. Events with the same key in one batch show as one line.

## Other topics

| Topic                                                          | Page                                                                                                              |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Web workspace, daemon, its credential page, `web.*` settings   | [web workspace](web-workspace.md), [remote access](remote.md)                                                     |
| ACP clients (`octocode --mode acp`)                            | [ACP](acp.md)                                                                                                     |
| Session API, `sessionApiTurnPermission`                        | [session API](session-api.md)                                                                                     |
| Worktrees, `.worktreeinclude`, subagent controls, bash limits  | [native features](native-features.md), [settings](settings.md), [environment variables](environment-variables.md) |
| Session titles (`sessions.autoTitle`), `research.allowedPaths` | [settings](settings.md)                                                                                           |
| Provider keys and models                                       | [providers](providers.md), [models](models.md)                                                                    |
