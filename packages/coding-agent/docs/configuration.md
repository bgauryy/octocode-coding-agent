# Configuration

Start with [CONFIGURATIONS.md](../../../CONFIGURATIONS.md) for global/workspace locations and the commands for MCP, skills, models, and other resources. `/mcp config` shows the active MCP paths without reading credentials or connecting servers.

For lifecycle automation, see [hooks](hooks.md): execution is opt-in, discovery uses explicit JSON paths plus Codex TOML in the source-profile preview, and project hooks require native configuration trust. Explicit local [plugins](plugins.md) use the `plugins` settings array and separate component review.

Source [permission rules](permissions.md) have a separate approval boundary from hook execution. The compatibility preview can enforce Claude deny/ask rules even with executable hooks disabled.

## Agent directory

Octocode Code stores configuration and runtime state under `~/.octocode/octocodecode/`.
Set `OCTOCODE_HOME` to move that root. `OCTOCODE_CODING_AGENT_DIR` overrides only
the core configuration directory. Project configuration remains in `.octocode/`.

Place provider configuration in `models.json` within that directory.
See [models](models.md) and [environment variables](environment-variables.md).

## Pi configuration fallback

With the default home, Octocode also reads `~/.pi/agent/` and `~/.pi/`, in that
order. Octocode configuration takes precedence:

- `models.json`: providers missing from Octocode are read from Pi. An Octocode
  provider replaces the whole Pi provider, including credentials and models.
- `settings.json`: missing settings are inherited. Native values win, including
  nested settings. Saving settings writes the effective configuration to the
  Octocode directory; the Pi files are unchanged. A native settings document
  that is empty or whose root is not a JSON object is reported as invalid rather
  than masked by fallback settings. Each save locks the read–merge–write operation,
  including first creation, and replaces the target file atomically. The file is
  parsed again during the save; invalid content introduced after startup is left
  untouched and reported as a settings error. Repair it, then run `/reload`.
- `mcp.json`: Pi servers are inherited, followed by shared `~/.octocode/`
  and `~/.octocode/agent/` files, then the canonical agent directory.
  Enablement and exposure changes save native overrides. See [MCP](mcp.md#configure-servers)
  for the complete precedence and trust rules.
- Extensions, skills, prompts and themes: default directories and configured
  paths are read relative to their original Pi directory. An identically located
  native resource wins. Existing package resources are supported; missing Pi
  packages are not installed automatically. `--no-extensions` disables inherited
  extensions too.
- Extension packages may declare `octocode` or legacy `pi` resources in
  `package.json`; `octocode` wins when both are present. Extensions import host
  packages by their `@octocodeai/*` names.

The old `@octocodeai/pi-extension` package is not automatically loaded alongside
the native features it duplicates. Other extensions can still register their
own tools and commands; normal conflict diagnostics apply.

Explicit home overrides and custom SDK directories disable automatic Pi fallback.
Pi sessions, trust decisions, authentication files, device identity and telemetry
consent are not imported. Existing directories are neither moved nor deleted.
Project trust decisions are saved by atomically replacing the native `trust.json`.
The separate agents-communication service keeps its shared directory at
`~/.octocode/agents-communication/`.

## Historical migrations

Run `octocode migrate` explicitly to convert older files in the active Octocode
configuration directory and the current project's `.octocode/`. Normal startup
does not run these conversions or wait for a migration acknowledgement.

The command adds missing providers from `oauth.json` and `settings.json` API keys
to `auth.json`, preserving existing providers. It moves loose session files into `sessions/`, moves managed
search binaries from `tools/` to `bin/`, rewrites historical keybinding names,
and renames `commands/` to `prompts/` when the destination is absent. It reports
deprecated extension directories for manual review. Existing old keybinding
names still load in memory without rewriting the file.

Back up historical files before conversion. This command does not import or
modify the Pi fallback directories. Use `octocode migrate --help` for the active
configuration path.

## Compaction

Automatic compaction is always enabled. `/compact` starts the same built-in summary flow manually. The CLI, SDK and RPC do not accept a custom summary focus or an automatic-compaction toggle. Legacy `compaction` settings, including per-model overrides, are ignored.

The built-in policy reserves up to 16,384 tokens for summarization and responses and retains up to 20,000 recent tokens. For smaller context windows, those budgets shrink to one eighth and one quarter of the window respectively. The native context display and model-switch checks use the same policy.

Summary requests reuse the session transcript and resolved cache preferences when possible. A failed cache-sharing summary falls back to standalone summarization. Actual cache hits are determined by the provider. Old tool results are cleared only after the known cache lifetime expires, only when enough space can be recovered, and only after saving a readable copy.

Session transcripts and compaction entries are saved in local JSONL files under the agent directory's `sessions/` folder. Compaction changes the active context while retaining original entries on disk. Native compaction also saves searchable Markdown archives. New transcript entries are flushed to disk. Transcript rewrites use atomic replacement so a failed replacement preserves the previous file. The separate agents-communication SQLite database stores peer coordination data; it is not the conversation transcript store.

## Prompt cache warming

Set `cacheWarming` in the global `settings.json`: `"off"` disables refreshes, `"streaming"` (the default) refreshes while the agent is active, and `"idle"` also permits refreshes after it settles. Project settings cannot enable paid warming. For example:

```json
{
  "cacheWarming": "streaming",
  "cacheRetention": "short"
}
```

Warming replays the request with a one-token output cap. It requires a known model cache lifetime and a replay-safe request; it does not execute returned tool calls. Refreshes stop when context changes, the cache deadline is missed, a refresh fails, or the provider reports no cache read. A real request can restart warming. Existing limits cap active warming at one hour and idle warming at thirty minutes from the original request. Completed refresh usage is recorded separately, including cache misses. `/status` shows status and usage. Provider cache hits and savings are not guaranteed.

External `session_before_compact` handlers receive isolated snapshots for observation. Their returned summaries and cancellation flags are ignored. Extensions cannot inject compaction entries at turn boundaries. The built-in implementation retains its summary, archive and recovery behavior. Automatic compaction stops after three consecutive failures; successful manual compaction resets the failure count. User cancellation does not count as a failure.
