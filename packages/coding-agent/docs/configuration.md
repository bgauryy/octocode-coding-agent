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

SDK hosts can supply a named built-in factory to replace its default implementation, or set `nativeFeatures: false` to omit the defaults. Explicit factories still load in that mode, including the public `createMcpExtension()` factory. See the [SDK reference](sdk.md) and [native feature guide](native-features.md) for tool selection and third-party extension behavior.

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

Set `terminal.images` to `"kitty"` or `"iterm2"` to force a known protocol, or `false` to disable graphics. Explicit settings take precedence over the `OCTOCODE_IMAGE_PROTOCOL` environment override, which accepts `kitty`, `iterm2`, `none`, or `auto`. Inside tmux, automatic detection enables Kitty images only for a Kitty or Ghostty client when the pane's `allow-passthrough` is on and 24-bit colour reaches the client; images then use passthrough and Unicode placeholders, and `kitty` forces that mode. Detection leaves images off in other tmux sessions, in screen and in Rex. iTerm2 inline images work in regular mode; fullscreen mode uses text placeholders. See the [TUI image reference](../../tui/README.md#image-capability-detection) for protocol and renderer details.

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

Interface-visible runtime state uses a session-scoped Zustand vanilla store in the application core. It is not persisted by Zustand. Session transcripts remain JSONL files; native session metadata, backlogs and history, memories, team coordination, and command receipts use the agent SQLite database. Settings, credentials, checkpoints, and output files retain their existing file owners.

`OCTOCODE_AGENT_DB` overrides the native database file; otherwise the shared home supplies `agent/octocode.db`. The process opens one shared connection per canonical file path. Distinct configured files can coexist without closing each other's connections; symlink aliases reuse a connection. Process cleanup closes all shared connections. This does not make concurrent native sessions supported: the native runtime still has other process-scoped resources. The separate peer-communication database remains read-only to Octocode.

All native tables are reconciled by `octocode/agentdb/schema.ts`. Every SQL statement lives in `octocode/agentdb/queries/` and features call it through `octocode/agentdb/api.ts`, holding the handle only as its `Db` type; feature repositories own entity validation and transactions, and interfaces do not write SQL. `yarn run check:db-boundary` and the `no-restricted-imports` lint rule on `node:sqlite` enforce it. Runtime store changes require no database migration. See the [interface architecture](../../../docs/INTERFACE_ARCHITECTURE.md#runtime-state-and-database-ownership) for runtime ownership and snapshot subscriptions.

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
Pi sessions, trust decisions, device identity and telemetry consent are not imported.
Pi authentication is not loaded automatically; `/login pi` offers an explicit,
confirmed credential import. Pi model definitions remain fallback inputs. Existing
directories are neither moved nor deleted. See [provider setup](providers.md#use-pi-configuration).
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

## Retries

A failed model response that looks transient (overload, rate limit, server or network error) is retried up to `retry.maxRetries` times, waiting `retry.baseDelayMs` doubled for each attempt and never more than `retry.maxAgentDelayMs`. A rate limit (`429`, "rate limit", "too many requests") is treated differently, because the limit is a token bucket that refills while the session waits and every session on the same key shares it:

- The retry waits at least as long as the provider's `retry-after` header asked, when the provider sent one (Anthropic Messages does; other providers fall back to the backoff), plus up to one second of spread. The wait is still capped by `retry.maxAgentDelayMs`.
- A rate-limited response gets at least six retries even when `retry.maxRetries` is lower, within a total waiting window of three minutes. `retry.maxRetries: 0` and `retry.enabled: false` still turn retries off.
- Retries wait on the same cancellable timer as before; Esc stops them.
- After a subagent fails on a rate limit, the parent holds new subagent starts for 5 seconds, doubling to at most 30 seconds for each further rate-limit failure and starting over after a quiet minute, so the next launches do not meet the same limit.

## Compaction

Automatic compaction is always enabled. `/compact` starts the same built-in summary flow manually. The CLI, SDK and RPC do not accept a custom summary focus or an automatic-compaction toggle. Legacy `compaction` settings, including per-model overrides, are ignored.

The built-in policy reserves room for summarization and responses and retains up to 20,000 recent tokens (one quarter of smaller windows). The reserve is the larger of 16,384 tokens (one eighth of smaller windows) and the active thinking budget plus 12,288 tokens of answer and safety room, capped at one sixth of the window, so a turn near the threshold keeps its thinking budget. For example, a 200,000-token window compacts at 183,616 tokens with thinking off and at 171,328 at `high`. The native context display and model-switch checks use the same policy.

Summary requests reuse the session transcript and resolved cache preferences when the summary model is the session's and the compaction is not an overflow; a cold cache does not change that. A failed cache-sharing summary falls back to standalone summarization with the same routing id and cache preferences. Actual cache hits are determined by the provider. Old tool results are cleared only after the known cache lifetime expires, only when enough space can be recovered, and only after saving a readable copy.

Session transcripts and compaction entries are saved in local JSONL files under the agent directory's `sessions/` folder. Compaction changes the active context while retaining original entries on disk. Native compaction also saves searchable Markdown archives. New transcript entries are flushed to disk. Transcript rewrites use atomic replacement so a failed replacement preserves the previous file. The separate agents-communication SQLite database stores peer coordination data; it is not the conversation transcript store.

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
