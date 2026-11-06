# Configuration

Start with [CONFIGURATIONS.md](../../../CONFIGURATIONS.md) for global/workspace locations and the commands for MCP, skills, models, and other resources. `/mcp config` shows the active MCP paths without reading credentials or connecting servers.

For lifecycle automation, see [hooks](hooks.md): discovery uses explicit JSON paths plus Codex TOML, each source runs under its own profile, and project hooks require native configuration trust. Explicit local [plugins](plugins.md) use the `plugins` settings array and separate component review.

Source [permission rules](permissions.md) have a separate approval boundary from hook execution. Claude deny/ask rules apply even when `disableAllHooks` turns hooks off.

## Agent directory

Octocode Code stores configuration and runtime state under `~/.octocode/octocodecode/`.
Set `OCTOCODE_HOME` to move that root. `OCTOCODE_CODING_AGENT_DIR` overrides only
the core configuration directory. Project configuration remains in `.octocode/`.

Place provider configuration in `models.json` within that directory.
See [models](models.md) and [environment variables](environment-variables.md).

## Built-in features

`octocode config` and the default resource loader use the same [built-in catalog](../src/core/resource-loader/builtins.ts). Existing selections keep the identities `builtin:mcp` and `builtin:llama.cpp`; for example, `-builtin:mcp` in the `extensions` setting disables the built-in MCP host. Global and trusted workspace resource selection still use the normal settings precedence.

Native features load by default. See the [native feature guide](native-features.md) for tool selection.

## Terminal images

Inline image display is enabled by default when the terminal supports it. `/settings` exposes **Show images** and **Image width** when graphics support is available. These settings affect terminal display; model image-input support is configured separately in [models](models.md#describe-model-input-and-caching).

```json
{
	"terminal": {
		"showImages": true,
		"images": "auto",
		"imageWidthCells": 60
	}
}
```

Automatic detection recognizes Kitty, including `TERM=xterm-kitty`, and checks interactive terminals with a graphics query during startup. Confirmed support repaints existing attachments as images. A negative reply falls back to text; a terminal that sends no replies retains the environment-based choice. Input remains available while detection runs.

Set `terminal.images` to `"kitty"` or `"iterm2"` to force a known protocol, or `false` to disable graphics. Explicit settings take precedence over the `OCTOCODE_IMAGE_PROTOCOL` environment override, which accepts `kitty`, `iterm2`, `none`, or `auto`. Inside tmux, automatic detection enables Kitty images only for a Kitty or Ghostty client when the pane's `allow-passthrough` is on and 24-bit colour reaches the client; images then use passthrough and Unicode placeholders, and `kitty` forces that mode. Detection leaves images off in other tmux sessions, in screen and in Rex. iTerm2 inline images work in regular mode; fullscreen mode uses text placeholders. See the [TUI image reference](../../tui/docs/components.md#image-capability-detection) for protocol and renderer details.

## No color

A non-empty `NO_COLOR` environment variable or `TERM=dumb` turns off every ANSI color sequence the terminal interface writes: foreground and background colors, the theme's tints, the diff tints and the working-line shimmer. Bold, dim, underline and inverse video still mark emphasis, selection and state (glyphs and words carry the rest), so the interface stays readable. `NO_COLOR` does not imply reduced motion: spinners keep running unless `terminal.reduceMotion` or `OCTOCODE_REDUCE_MOTION` asks otherwise. An empty `NO_COLOR` is ignored, as the standard says. `terminal.trueColor` and `OCTOCODE_TRUE_COLOR` only choose between color depths, so they do not turn color back on. An HTML export of tool output made with these variables set is plain text on the themed page.

## Reduced motion

`terminal.reduceMotion` accepts `true`, `false` or `"auto"` (the default). While motion is reduced, spinners stay on their first frame, and the working-line shimmer is plain; elapsed times and retry countdowns still update once a second. `"auto"` reduces motion when `OCTOCODE_REDUCE_MOTION` is `1` or `true`; an explicit `true` or `false` overrides the environment. `/settings` exposes **Reduce motion** and applies a change immediately.

```json
{
	"terminal": {
		"reduceMotion": "auto"
	}
}
```

## Runtime storage

Interface-visible runtime state uses a session-scoped Zustand vanilla store in the application core. It is not persisted by Zustand. Session writers persist their JSONL transcripts and mirror the header and ordered entries to SQLite, including tool results and compactions. The same database holds workspace identities, native session metadata, backlogs, history, memories, team coordination and command receipts. Settings and credentials remain in their configured files. Workspace artifacts and temporary output use the [workspace storage layout](../../../CONFIGURATIONS.md).

`OCTOCODE_AGENT_DB` overrides the native database file; otherwise the shared home supplies `agent/workspaces.db`. The process opens one shared connection per canonical file path. Distinct configured files can coexist without closing each other's connections; symlink aliases reuse a connection. Process cleanup closes all shared connections. This does not make concurrent native sessions supported: the native runtime still has other process-scoped resources. The separate peer-communication database remains read-only to Octocode.

**Retention and cleanup.** One global policy decides how long Octocode keeps data; `0` keeps a class forever.

| Setting (global `settings.json`) | Default | Environment override              | Governs                                                                                                                                                                                                            |
| -------------------------------- | ------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `retention.days`                 | 30      | `OCTOCODE_CLEANUP_DAYS`           | Output, bash logs, checkpoints and folders of sessions Octocode no longer lists, subagent scratch and screenshots, `<workspace>/.octocode/tmp` entries, compaction detail copies, and the database's history rows. |
| `retention.sessionDays`          | 90      | `OCTOCODE_SESSION_RETENTION_DAYS` | Session transcripts (JSONL) in `.octocode/code/sessions/` and the legacy `<octocode home>/sessions/--<folder>--/` directories.                                                                                     |

A value must be a whole number of days, 0 or more; the environment wins over the setting, a bad value is ignored (a bad setting is reported as a settings warning) and a project settings file cannot set it. An environment value that is not a whole number is ignored, including a negative one. The sweep runs at session start, off the start path, at most once every 6 hours across all workspaces, as one pass over every known root: each registered workspace whose root exists (`.octocode/code` session data and temp, and only `.octocode/tmp`, never another `.octocode/<topic>/` folder), the global `<octocode home>/agent/sessions`, and the legacy transcript folders. A transcript whose last write is older than `sessionDays` goes with its session folders and database rows, through the same removal the delete commands use; the current session, a running session (by the process recorded in its row), a directory that cannot be read, and a live bash job are never removed. A listing failure removes nothing. Nothing is followed through a symbolic link, and each removal stays strictly inside its root. The pass reports one summary line (what it removed and what failed) as a warning when something was removed or failed. `planSweep` lists the candidates with path, reason and size without removing anything; `applySweep` removes them.

**History archive.** Rows of the history tables (`backlog_audits`, `config_audits`, `workspace_commands`) older than 14 days move out of the database into gzip JSONL files, one per table family and UTC month (`audits-2026-11.jsonl.gz`, `config-audits-…`, `workspace-commands-…`), in `<octocode home>/archive/` (`OCTOCODE_HOME`, default `~/.octocode/octocodecode`), also when `OCTOCODE_AGENT_DB` names a file elsewhere. Archived rows older than the retention `days` (30 by default; `0` keeps them) are dropped, and a row already past that age when it leaves the database is deleted without being archived. Backlog items, notes and comments are never deleted by age. The folder is owner-only (0700) and each file 0600, as private as the database; each record names the database it came from (a digest of its canonical path), so databases sharing one home read back only their own rows. A main session (subagents do not) runs this housekeeping at most once a day per process, right after the first backlog access (tool, command or footer refresh) that is due, in batches of short write transactions; while another process holds the database or an archive file it stops and retries an hour later. Each batch is written to the archive (locked, atomic rewrite of the month file) before it is deleted, so a crash in between leaves a row in both places, and readers keep one copy. The 14-day archive window is a constant; the keep window is the global retention `days`, never a project value, because one database and one archive serve every repository. Pruning restores each table’s delete guard inside the transaction.

The database package creates one versioned schema for all workspaces, migrates older files after saving a `VACUUM INTO` backup beside them, and refuses files it cannot use, naming the schema version needed. Its named queries live in `packages/db/src/queries/` and features call them through `packages/db/src/api.ts`, holding the handle only as its `Db` type; feature repositories own entity validation and transactions, and interfaces do not write SQL. `yarn run check:db-boundary` and the `no-restricted-imports` lint rule on `node:sqlite` enforce it. See the [interface architecture](../../../docs/INTERFACE_ARCHITECTURE.md#runtime-state-and-database-ownership) for runtime ownership and snapshot subscriptions.

## Pi configuration fallback

With the default home, Octocode also reads `~/.pi/agent/` and `~/.pi/`, in that
order. Octocode configuration takes precedence:

- `models.json`: providers missing from Octocode are read from Pi. An Octocode
  provider replaces the whole Pi provider, including credentials and models.
- `settings.json`: missing settings are inherited, in this order of precedence
  (lowest first): `~/.pi/` and `~/.pi/agent/settings.json`, in a trusted folder
  `<project>/.pi/settings.json`, the Octocode global file, then the trusted
  `.octocode/settings.json`. Resource keys (`packages`, `extensions`, `skills`,
  `prompts`, `themes`) and per-install keys (`sessionDir`, `deviceId`,
  `trackingId`, `enableAnalytics`, `defaultProjectTrust`) are not inherited, and a
  project `.pi/settings.json` cannot set `remote.autoStart`. Pi settings are a
  read-only layer: they feed the merged settings and are never copied into an
  Octocode file. A save writes only the values Octocode itself holds (the
  setting you changed, with the rest of the Octocode file as it was), and the Pi
  files are unchanged. A Pi file that does not parse is a startup warning; it
  does not stop Octocode's own settings from loading or saving. A native
  settings document that is empty or whose root is not a JSON object is reported
  as invalid rather than masked by fallback settings. Each save locks the
  read–merge–write operation, including first creation, and replaces the target
  file atomically. The file is parsed again during the save; invalid content
  introduced after startup is left untouched and reported as a settings error.
  Repair it, then run `/reload`.
- `mcp.json`: Pi servers are inherited, followed by shared `~/.octocode/`
  and `~/.octocode/agent/` files, then the canonical agent directory.
  Enablement and exposure changes save native overrides. See [MCP](mcp.md#configure-servers)
  for the complete precedence and trust rules.
- Discovery: `models.json`, `settings.json` and `mcp.json` are listed by the
  `model`, `setting` and `mcp` kinds of the configuration-discovery service
  (`core/discovery`), alongside subagent profiles (`agent`), hook files (`hook`)
  and plugins (`plugin`), which `octocode/discovery/` registers. Each item records
  its product (Octocode or Pi), scope, source file and, for a collection kind, the
  item that shadows it. `models.json` and `settings.json` are layered files: every
  file is read and its keys merge (Octocode over Pi), so none is shown as shadowed.
  An MCP `enabled` or `exposure` entry without `command` or `url` is a control-only
  override and is listed apart from definitions. `packages/mcp` owns the MCP file
  list (it cannot import the host), so the host's `mcp` source reads the same list
  its loader uses.
- Skills, prompts and themes: default directories and configured paths are read
  relative to their original Pi directory. An identically located native
  resource wins. Existing package resources are supported; missing Pi packages
  are not installed automatically.
- Instruction files: `AGENTS.md` in `~/.pi/agent/` loads as the
  global context file only when the Octocode directory has none; `SYSTEM.md` and
  `APPEND_SYSTEM.md` in `~/.pi/agent/` apply when no Octocode file does; and
  `keybindings.json` in `~/.pi/agent/` is read beneath Octocode's own, action by
  action. Project `AGENTS.md` files are shared by both products; `CLAUDE.md` is
  not read.
- Switch: Pi's skills, prompts, themes and MCP files follow the `pi` harness
  switch (on by default; `/harness disable pi`). Its models, settings and
  keybindings load whatever the switch says.
- Project `.pi/` folder: in a trusted folder, `.pi/skills/`, `.pi/prompts/`,
  `.pi/themes/`, `.pi/SYSTEM.md` and `.pi/APPEND_SYSTEM.md` are read under the same
  folder trust as `.octocode/`. Nothing in `.pi/` is read in an untrusted folder.
- Pi code is never loaded. TypeScript in Pi's `extensions/` and `hooks/` folders
  (global and project) and Pi extension packages are listed at startup as
  "Pi extension, not loaded" with a hint to convert the behavior to a
  `hooks.json` entry or a plugin; the files are not executed.

Names that exist in both products resolve by one rule. Collections (skills,
prompts, themes): scope first, product second. A project copy beats a global one,
and at the same scope the Octocode copy beats the Pi copy; for skills, a Pi
project skill therefore beats an Octocode global skill with the same name. The
losing Pi copy stays on disk and is reported as shadowed by discovery
(`core/discovery/`). Single-valued files (global context file, `SYSTEM.md`,
`APPEND_SYSTEM.md`): product first, scope second, so Octocode's project file, then
Octocode's global file, then Pi's project file, then Pi's global file. A project
`.pi/` item in an untrusted folder never shadows anything.

- Extension packages may declare `octocode` or legacy `pi` resources in
  `package.json`; `octocode` wins when both are present. Extensions import host
  packages by their `@octocodeai/*` names.

The old `@octocodeai/pi-extension` package is not automatically loaded alongside
the native features it duplicates. Other extensions can still register their
own tools and commands; normal conflict diagnostics apply.

An explicit home override (`OCTOCODE_HOME` or `OCTOCODE_CODING_AGENT_DIR`) disables automatic Pi fallback.
Pi sessions, trust decisions, device identity and telemetry consent are not imported.
Pi authentication is not loaded automatically; `/login pi` offers an explicit,
confirmed credential import. Pi model definitions remain fallback inputs. Existing
directories are neither moved nor deleted. See [provider setup](providers.md#use-pi-configuration).
The separate agents-communication service keeps its shared directory at
`~/.octocode/agents-communication/`.

Folder trust decisions live in the agent database (`trusted_folders`). A `trust.json` from an earlier release is not read; trust the folder again with `octocode trust add <path>`.
The separate agents-communication service keeps its shared directory at
`~/.octocode/agents-communication/`.

## Retries

A failed model response that looks transient is retried up to `retry.maxRetries` times, waiting `retry.baseDelayMs` doubled for each attempt and never more than `retry.maxAgentDelayMs`. Two kinds of failure clear by waiting and are treated differently, because every session on the same key meets them at the same moment: a rate limit (`429`, "rate limit", "too many requests"), and a capacity or transport failure (`overloaded`, `502`, `503`, `504`, `520`, `524`, `529`, `server_busy`, "model is at capacity", service unavailable, a connection reset, a closed socket or websocket, `terminated`, a stream that ended early). Other retryable errors keep the configured count and the exact backoff, because some of them never clear (a host that does not resolve, a bare `500` from a bad request) and each attempt resends the whole context.

- The retry waits up to half again the backoff, so parallel sessions spread out, and at least as long as the provider's `retry-after` header asked, when the provider sent one, plus up to one second of spread. The wait is still capped by `retry.maxAgentDelayMs`.
- Such a failure gets at least six retries even when `retry.maxRetries` is lower. Retries beyond the configured count run only within three minutes of wall-clock time from the first failure, which counts time inside failed requests as well as waits. The configured count is always allowed. `retry.maxRetries: 0` and `retry.enabled: false` still turn retries off, and account quota and billing errors fail at once.
- Compaction and branch summaries retry by the same policy.
- Retries wait on the same cancellable timer as before; Esc stops them.
- After a subagent fails on a rate limit, the parent holds new subagent starts for 5 seconds, doubling to at most 30 seconds for each further rate-limit failure and starting over after a quiet minute, so the next launches do not meet the same limit.

## Compaction

Automatic compaction is always enabled. `/compact` starts the same built-in summary flow manually. The CLI and RPC do not accept a custom summary focus or an automatic-compaction toggle. Legacy `compaction` settings, including per-model overrides, are ignored.

The built-in policy reserves room for summarization and responses and retains up to 20,000 recent tokens (one quarter of smaller windows). The reserve is the larger of 16,384 tokens (one eighth of smaller windows) and the active thinking budget plus 12,288 tokens of answer and safety room, capped at one sixth of the window, so a turn near the threshold keeps its thinking budget. For example, a 200,000-token window compacts at 183,616 tokens with thinking off and at 171,328 at `high`. The native context display and model-switch checks use the same policy.

Summary requests reuse the session transcript and resolved cache preferences when the summary model is the session's and the compaction is not an overflow; a cold cache does not change that. A failed cache-sharing summary falls back to standalone summarization with the same routing id and cache preferences. Actual cache hits are determined by the provider. Old tool results are cleared only after the known cache lifetime expires, only when enough space can be recovered, and only after saving a readable copy.

Session transcripts and compaction entries are saved in local JSONL files under the workspace's `.octocode/code/sessions/` folder by default. Sessions written before that move live in `<octocode home>/sessions/--<working directory, separators as dashes>--/`; the current directory's list, `--continue` and `--session <id>` also read that folder (keeping only files whose header directory is exactly the current one), and `/resume all` lists every such folder. A session opened from there keeps writing in its own folder. Compaction changes the active context while retaining original entries on disk. Native compaction also saves searchable Markdown archives. The `archive` tool searches them by `query` (a regular expression, every matching line) or by `keywords` (passages of at most 40 lines ranked by BM25, with identifiers and paths split into their parts, light stemming, quoted-phrase and term-coverage weighting, and a count of passages per term so a term found nowhere is named). Keywords rank only what sessions said: message text, tool names and call ids, a segment's TL;DR, topics and files, a library row's TL;DR, topics and files, and a session record's field values and messages. The archive's own headings, labels, notes and the record's Repository, Workspace and Transcript paths count for nothing; a regular-expression `query` still matches every line. Both run in a worker that fails the search after 5 seconds or past 32 MiB of files, including a `query` that filters a `keywords` search or the error results of `errors` mode. The `archive` tool's `errors` mode streams the transcripts that this repository's session records name (only JSONL files inside the Octocode home or the session's workspace) and groups their failed tool results by tool and normalised signature, with error rates by tool, model and UTC day and sample calls; `since` limits it to results from a given time, so a fix can be compared before and after. No model reads the transcripts. New transcript entries are flushed to disk. Transcript rewrites use atomic replacement so a failed replacement preserves the previous file. The separate agents-communication SQLite database stores peer coordination data; it is not the conversation transcript store.

## Prompt cache warming

Set `cacheWarming` in the global `settings.json`: `"off"` disables refreshes, `"streaming"` refreshes while the agent is active, and `"idle"` (the default) also permits refreshes after it settles. Project settings cannot enable paid warming. For example:

```json
{
	"cacheWarming": "idle",
	"cacheRetention": "long"
}
```

Warming replays the request with a one-token output cap. It requires a known model cache lifetime and a replay-safe request; it does not execute returned tool calls. Refreshes stop when context changes, the cache deadline is missed, a refresh fails, or the provider reports no cache read. A real request can restart warming. Existing limits cap active warming at one hour from the original request, and idle warming at thirty minutes or one cache lifetime, whichever is later. Completed refresh usage is recorded separately, including cache misses. `/status` shows status and usage. Provider cache hits and savings are not guaranteed.

External `session_before_compact` handlers receive isolated snapshots for observation. Their returned summaries and cancellation flags are ignored. Extensions cannot inject compaction entries at turn boundaries. The built-in implementation retains its summary, archive and recovery behavior. Automatic compaction stops after three consecutive failures; successful manual compaction resets the failure count. User cancellation does not count as a failure.
