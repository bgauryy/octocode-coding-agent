# Settings

<!-- This file is generated from TypeScript source. Do not edit it manually; run yarn run generate:references. -->

`settings.json` holds global defaults in the agent directory (see [Configuration](configuration.md#agent-directory)) and project overrides in `.octocode/settings.json`. A trusted project's values override global ones: objects merge recursively and arrays replace. Edit the file and run `/reload`, or use `/settings set <key> <value>` and `unset <key>` (`--local` for the project file); `octocode --set <key>=<value>` sets one for a single run. All locations and precedence: [Configuration](configuration.md).

For editor validation and completion, point `$schema` at `schemas/settings.schema.json` in the installed Octocode package.

Loading is permissive: a key this page does not list is kept in the file but has no effect. That covers root keys and keys inside a listed object setting with named fields (reported as a dotted path such as `thinkingBudgets.xhigh`). Startup reports them once per load, one line per file: `~/.octocode/octocodecode/settings.json: 2 ignored keys (thinkingBudgets.xhigh unknown, compaction removed): /settings unset thinkingBudgets.xhigh compaction`. Running that command removes exactly the listed keys; add `--local` for a project file.

Nested fields are listed as `parent.child`. Defaults shown are the values Octocode uses when a field is absent; an empty Default cell means no fixed value.

## Models and thinking

| Field | Type | Default | Description |
|---|---|---|---|
| `defaultProvider` | string |  | Provider of the model that starts a session when no model is selected; used with `defaultModel`. |
| `defaultModel` | string |  | Model ID that starts a session when no model is selected; used with `defaultProvider`. |
| `defaultThinkingLevel` | `"off" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max"` |  | Thinking level for the starting model, and for a model switch before the session chooses a level, when neither the model pattern nor `modelThinkingLevels` sets one; `high` when unset. Subagents never take it: each route names its own level. |
| `modelThinkingLevels` | object |  | Per-model default thinking level overrides keyed by "provider/modelId". |
| `transport` | `"auto" \| "sse"` | `"auto"` | Request transport for providers that offer more than one. Every built-in provider streams over HTTP (SSE), so `auto` and `sse` behave the same. |
| `enabledModels` | `string[]` |  | Model patterns for cycling, in the same format as the --models CLI flag. |
| `thinkingBudgets` | object |  | Custom token budgets for thinking levels. |
| `thinkingBudgets.minimal` | number |  | Token budget for the `minimal` thinking level. |
| `thinkingBudgets.low` | number |  | Token budget for the `low` thinking level. |
| `thinkingBudgets.medium` | number |  | Token budget for the `medium` thinking level. |
| `thinkingBudgets.high` | number |  | Token budget for the `high` thinking level. |

## Caching, retries and network

Cache behavior is described in [prompt caching](prompt-caching.md) and retry behavior in [Retries](configuration.md#retries).

| Field | Type | Default | Description |
|---|---|---|---|
| `cacheRetention` | `"none" \| "short" \| "long"` | `"short"` | Conversation cache retention; short by default, long for sessions that often pause 5 to 60 minutes. Without a separate instruction preference, applies to both layers. |
| `instructionCacheRetention` | `"none" \| "short" \| "long"` | `"long"` | Instruction cache retention, limited by endpoint capabilities; long by default. Long writes can cost more. |
| `retry` | object |  | Automatic retry of transient model failures. |
| `retry.enabled` | boolean | `true` | `false` turns off all retries. |
| `retry.maxRetries` | number | `3` | Retry attempts after a transient failure. Rate limits and capacity or transport failures have their own minimum. |
| `retry.baseDelayMs` | number | `2000` | Exponential backoff base delay in milliseconds: 2s, 4s, 8s. |
| `retry.maxAgentDelayMs` | number | `60000` | Longest wait before one retry, in milliseconds. |
| `retry.offlineIntervalMs` | number | `60000` | Wait between retries while the machine is offline. |
| `retry.offlineMaxMs` | number |  | How long an outage may last before the request fails; 0 waits until the network returns. Unset: 0, and 30 minutes in print mode. |
| `retry.provider` | object |  | Retries inside the provider SDK, separate from the session retries above. |
| `retry.provider.timeoutMs` | number |  | SDK or provider request timeout in milliseconds. |
| `retry.provider.maxRetries` | number |  | SDK or provider retry attempts. |
| `retry.provider.maxRetryDelayMs` | number | `60000` | Maximum server-requested delay before failing. |
| `retry.fallbackCooldownMs` | number | `900000` | Milliseconds a model that failed on a usage limit or a refused credential is skipped as a fallback or router target (limits usually reset after hours; `/model` can still pick it). 0 retries it at once. |
| `retry.maxUsageWaitMs` | number | `0` | Unattended runs (print mode, RPC and ACP hosts, subagents): how long to wait, in milliseconds, for a usage limit with a known reset time when no `fallbackModels` entry is left, then resume. A later reset, or 0, fails the run with an error that names the reset time. Interactive sessions (the terminal and /web) ask instead: wait and resume at the reset, switch to a connected model (optionally saved to `fallbackModels`), pick one, or stop. |
| `retry.fallbackModels` | `string[]` | `[]` | Models to continue on when the current one fails on a usage limit (quota, billing or plan limit), a refused credential (401; an invalid, expired or revoked key or token; a 403 naming a key, token or authentication), a model unavailable for the account, or an outage that outlasts the retries, tried in order, each as `provider/id` with an optional `:thinking` level, for example `["openrouter/some-model", "openai/other-model:high"]`. A rate limit never switches the model: it is retried on the same one. After a refused credential, entries of the same provider are skipped; entries models.dev lists as deprecated are skipped too. The first one with credentials becomes the session model with a notice, which names a change between plan and per-token billing, and stays selected; `/model` switches back. Empty: such a failure ends the turn. |
| `showCacheMissNotices` | boolean | `false` | Show cache cost and provider recovery notices. |
| `httpProxy` | string |  | Proxy URL applied as HTTP_PROXY and HTTPS_PROXY for Octocode-managed HTTP clients. Read from the global settings file; a project file cannot set it. |
| `httpIdleTimeoutMs` | `number \| "disabled"` |  | HTTP header or body idle timeout in milliseconds; a model stream or compaction summary attempt that receives nothing for this long is retried. 0 or "disabled" disables it. |
| `cacheWarming` | `"off" \| "streaming" \| "idle"` | `"idle"` | Cache-warming profile. "idle" also warms between agent runs. Global only because each refresh costs money. |

## Sessions, queues and tools

For MCP declaration states and overrides, see [tool exposure](configuration.md#tool-exposure).

| Field | Type | Default | Description |
|---|---|---|---|
| `steeringMode` | `"all" \| "one-at-a-time"` | `"all"` | Messages queued while the agent streams: `one-at-a-time` delivers one and waits for the response; `all` delivers them together. |
| `followUpMode` | `"all" \| "one-at-a-time"` | `"all"` | Follow-up messages queued until the agent stops: `one-at-a-time` delivers one and waits for the response; `all` delivers them together. |
| `branchSummary` | object |  | Summaries of abandoned branches when navigating the session tree. |
| `branchSummary.reserveTokens` | number | `16384` | Tokens reserved for the prompt and LLM response. |
| `branchSummary.skipPrompt` | boolean | `false` | When true, skips the "Summarize branch?" prompt and defaults to no summary. |
| `toolExecution` | object |  | When tool calls start. |
| `toolExecution.earlyStart` | boolean | `false` | Start read-only tool calls that need no approval while the model is still writing its message, instead of after it ends. |
| `mcpPresentation` | `"declared" \| "compact" \| "json"` | `"declared"` | How MCP contracts reach the model. In "declared" mode a direct tool carries the full server schema in its declaration. With the default "usage" exposure, an agent with the mcp tool sees unpinned MCP tools as deferred. Each starts with the server description and thin parameters. The agent can load its full contract with mcp. In "compact" and "json" modes declarations are thin and direct tools have their contracts in the system prompt as TypeScript or JSON. Every mode validates calls against the full server input schema. |
| `defaultTools` | `string[]` |  | Initial tool selection. Plain names replace the inherited selection; +name and -name entries add or remove tools. |
| `doubleEscapeAction` | `"fork" \| "tree" \| "none"` | `"tree"` | Action for double-escape with an empty editor. |
| `treeFilterMode` | `"default" \| "no-tools" \| "user-only" \| "labeled-only" \| "all"` | `"default"` | Default filter when opening /tree. |
| `sessionDir` | string |  | Custom session storage directory, in the same format as the --session-dir CLI flag. |
| `retention` | object |  | How long cleanup keeps data; one global policy for every project, so a project settings file cannot set it. |
| `retention.days` | integer | `30` | Days Octocode keeps output, bash logs, subagent scratch, session data, `&lt;workspace>/.octocode/agent/tmp` entries and database history after their last write. 0 keeps them forever. `OCTOCODE_CLEANUP_DAYS` overrides it. |
| `retention.sessionDays` | integer | `90` | Days a session transcript (JSONL, in a workspace) is kept after its last write, then removed with its session data and database rows; the current and running sessions are never removed. 0 keeps transcripts forever. `OCTOCODE_SESSION_RETENTION_DAYS` overrides it. |
| `retention.archiveAfterDays` | integer | `14` | Days after which backlog audit, configuration audit and workspace command history rows move from the database to gzip archive files; archived rows older than `days` are dropped. A window longer than `days` is cut to it. |
| `subagents` | object |  | Limits on the subagents a session starts, and how they are checked on. |
| `subagents.models` | object |  | Model for the `small`, `medium` and `large` subagent purposes, each `provider/model` with an optional `:level` thinking suffix, e.g. { "small": "openai/gpt-5-mini:low" }. Used by every profile or task that names the purpose, before the automatic choice; a call's own `model` still wins. A model that is not available, cannot run a task or sits on a provider that refused its credential is skipped for the automatic choice, and the route says why. Read from the global settings file; a project file cannot set it. |
| `subagents.models.small` | string |  | `provider/model[:level]` for the `small` purpose. |
| `subagents.models.medium` | string |  | `provider/model[:level]` for the `medium` purpose. |
| `subagents.models.large` | string |  |  |
| `subagents.maxChildren` | integer |  | Subagents one session may start; a resume of a child it started is no new one. Past it a new spawn is refused with the total; what runs keeps running. You are told the first time it refuses, once per session for each value. |
| `subagents.maxCost` | number |  | US dollars billed per token, the session's own and its subagents' (a plan's share is an estimate, not money, and never counts), past which a new spawn, a resume and a message to a lingering subagent are refused with the total; what runs keeps running. You are told the first time it refuses, once per session for each value. |
| `subagents.queuedStarts` | boolean | `true` | Let a background `agent` task wait for prerequisites instead of being refused: its `after` list (backlog items `B&lt;n>`, children `agent:&lt;name>`) and the open `dependsOn` of its item. A queued child holds no slot, reservation or item claim; it starts when the last prerequisite ends well, and is held (the coordinator is told) when one fails. Off: such a task is refused as before. |
| `subagents.wakeHoldSeconds` | number | `2` | Legacy idle wake window in seconds. Use runtime.eventWindowSeconds for the live scheduler. A session with no explicit runtime window inherits this value. Zero delivers at once. |
| `subagents.peerOverlapWake` | boolean | `true` | Wake the holder of an ongoing item, or of a reservation, when another agent claims an item (or edits its paths) that overlaps its paths, once per pair. Off: the holder hears of it with its next turn instead. |

## Shell and packages

| Field | Type | Default | Description |
|---|---|---|---|
| `shellPath` | string |  | Custom shell path, for example for Cygwin on Windows, with support for leading ~ expansion. |
| `shellCommandPrefix` | string |  | Prefix prepended to every bash command, for example to enable shell aliases. |
| `bashBackgroundAfterSeconds` | number | `90` | Seconds a foreground bash command may run before it moves to the background as a job (its exit arrives as a message). 0 turns this off. The OCTOCODE_BASH_BACKGROUND_AFTER_SECONDS environment variable overrides it. |
| `bashOutputMaxBytes` | number | `20000` | Most bytes of one foreground bash result that reach the model (about 4 bytes per token); the line limit scales with it (500 lines at the default). Longer output keeps its first 20% and last 80%, plus matched error lines, and is saved in full. A call can lower it with maxOutputTokens but never raise it. Output of the user's own `!` commands follows the same limit. |
| `bash` | object |  |  |
| `bash.inheritProviderKeys` | boolean | `false` | Keep provider API keys (`OPENAI_API_KEY`, `HF_TOKEN`…) and provider tokens (`AWS_BEARER_TOKEN_BEDROCK`, `OPENAI_CUSTOM_HEADERS`) in the environment of bash commands. Off by default: a command's output reaches the model, and a build script or an injected command can read its environment. `GH_TOKEN` and other tool tokens are not provider keys and stay either way. A nested `octocode` still signs in through `auth.json`. Read from the global settings file; a project file cannot turn it on. Takes effect for new sessions. |
| `bash.spillMaxBytes` | integer | `1073741824` | Most bytes the saved full output of one foreground bash command holds (commands the agent runs and the user's own `!` commands). Past it the file keeps the first half and the end of the output around a marker, and the result's header says how much was dropped, so a command stuck in a loop cannot fill the disk. What reaches the model below the cap does not change. 0 lifts the cap. |
| `bash.longCommandAfterSeconds` | number | `30` | Seconds a known long command (test runner, `yarn run check`, build, server, stream follower, or a `longCommandPatterns` match) may run in the foreground before it moves to the background as a job. It applies only when sooner than `bashBackgroundAfterSeconds`. |
| `bash.deliberateMaxSeconds` | number | `600` | The longest a foreground bash call that names its own `timeout` holds the turn before the command moves to the background (it is still stopped at its timeout). |
| `bash.longCommandPatterns` | `string[]` | `[]` | Regular expressions for commands that count as long, added to the built-in runners (vitest, jest, pytest, cargo, go, yarn test/check/build/dev…), for example `["bazel\s+(?:test\|build)", "make\s+(?:test\|check)"]`. Each is matched where a command starts (the line, or after `;`, `&`, `\|`, `(` and `VAR=value` words) and must end at a space or the end of a part. An entry that is not a valid regular expression is ignored. |
| `npmCommand` | `string[]` |  | Command used for npm package lookup and installation, in argv form such as ["mise", "exec", "node@20", "--", "npm"]. |

## Telemetry and identity

Folder trust is not a setting: it lives in the agent database (see `octocode trust`). `deviceId` and `trackingId` are generated by Octocode.

| Field | Type | Default | Description |
|---|---|---|---|
| `enableInstallTelemetry` | boolean | `true` | Send an anonymous version and update ping after changelog-detected updates. |
| `enableAnalytics` | boolean | `false` | Opt in to analytics data sharing. |
| `trackingId` | string |  | Analytics tracking identifier, generated when analytics is enabled. |
| `deviceId` | string |  | Stable installation UUID, generated when authentication first needs it. Global only. |

## Resources

See [packages](packages.md), [skills](skills.md), [plugins](plugins.md) and [hooks](hooks.md).

| Field | Type | Default | Description |
|---|---|---|---|
| `plugins` | `object[]` |  | Local compatibility plugins. Activates namespaced skills, supported prompt commands, hooks and MCP servers; adding or enabling a plugin approves its hooks and MCP servers. Other components require their own adapters. |
| `plugins[].path` | string |  | Required. Absolute local plugin directory. |
| `plugins[].protocol` | `"claude" \| "codex"` |  | Required. |
| `plugins[].enabled` | boolean | `true` |  |
| `plugins[].source` | object |  | Where the cached copy at `path` came from; written by `octocode plugin install`. |
| `plugins[].source.marketplace` | string |  | Required. Marketplace name. |
| `plugins[].source.plugin` | string |  | Required. Plugin name in that marketplace. |
| `plugins[].source.sha` | string |  | Required. Pinned commit, or a content hash for a local directory marketplace. |
| `marketplaces` | object |  | Plugin marketplaces by name, as `octocode marketplace add` writes them. Global only: project settings cannot register one. |
| `packages` | `(string \| object)[]` |  | npm or git package sources, as strings or objects with resource filtering. |
| `packages[].source` | string |  | Required. |
| `packages[].autoload` | boolean |  | When false, start empty and only apply explicit resource patterns. |
| `packages[].skills` | `string[]` |  |  |
| `packages[].prompts` | `string[]` |  |  |
| `packages[].themes` | `string[]` |  |  |
| `skills` | `string[]` |  | Local skill file paths or directories. |
| `prompts` | `string[]` |  | Local prompt template file paths or directories. |
| `themes` | `string[]` |  | Local theme file paths or directories. |
| `enableSkillCommands` | boolean | `true` | Register skills as /skill:name commands. |

## Interface

| Field | Type | Default | Description |
|---|---|---|---|
| `lastChangelogVersion` | string |  | Version whose changelog was last recorded. Octocode sets it; it decides whether to show the changelog and send the install ping after an update. |
| `theme` | string |  | Name of the active interface theme. |
| `hideThinkingBlock` | boolean | `false` | Collapse each thinking block to one line (`Thought for 4s`) instead of showing its text; `app.thinking.toggle` (ctrl+t) or a click on a block switches. |
| `externalEditor` | string |  | Editor for prompt text (Ctrl+G and edit dialogs); overrides VISUAL and EDITOR. referenceOpener decides how file references and editor diffs open. |
| `referenceOpener` | string | `"auto"` | How file references and /diff --editor open: "auto" uses the IDE whose terminal runs Octocode, else the first of code, cursor, code-insiders, codium, zed or subl on PATH, else the system default app for the file (open, xdg-open); over SSH or on Linux without a display, the prompt editor; "editor" uses the prompt editor (externalEditor, VISUAL, EDITOR); any other value is the command to run. Code-family editors, Zed and Sublime Text open beside the session; other editors take the terminal until they exit. |
| `quietStartup` | `boolean \| "header"` | `false` | When true, hide all startup output. When "header", keep only the startup header. |
| `collapseChangelog` | boolean | `false` | Show the condensed changelog after update; use /changelog for the full changelog. |
| `terminal` | object |  | Terminal rendering. See [Terminal images](configuration.md#terminal-images) and [Reduced motion](configuration.md#reduced-motion). |
| `terminal.showImages` | boolean | `true` | Show images when the terminal supports them. |
| `terminal.imageWidthCells` | number | `60` | Preferred inline image width in terminal cells. |
| `terminal.clearOnShrink` | boolean | `false` | Clear empty rows when content shrinks. |
| `terminal.replayRows` | integer | `5000` | Regular mode: the most rows a full redraw writes back into the terminal (after a resize or a resume from the background); earlier rows are left out behind one marker row. 0 redraws every row. |
| `terminal.showTerminalProgress` | boolean | `false` | Show OSC 9;4 terminal progress: on while the session's activity light is working, off while it waits for you or only a timer is pending. |
| `terminal.reduceMotion` | `boolean \| "auto"` | `"auto"` | Freeze spinners, shimmer and glow; elapsed times still tick. "auto" is still without a terminal, in CI, or when OCTOCODE_REDUCE_MOTION, REDUCE_MOTION or NO_MOTION is 1 or true. |
| `terminal.screenReader` | `boolean \| "auto"` | `"auto"` | Screen-reader text mode: words instead of spinner, shimmer and gauge glyphs, and no animation. "auto" follows OCTOCODE_SCREEN_READER (1 or true). |
| `terminal.latencyFence` | `boolean \| "auto"` | `"auto"` | Probe the terminal's display lag (DSR 5n) and hold streaming frames while it is behind. "auto" is on in a terminal; OCTOCODE_LATENCY_FENCE=0 or 1 overrides the setting. Turn it off if a terminal misbehaves with the probe. |
| `terminal.surfaceFills` | boolean | `false` | Paint user messages and notice panels with a quiet tint blended into the terminal background instead of the theme's panel colors. |
| `terminal.toolBands` | boolean | `false` | Tint each tool row with a quiet band blended from its state color into the terminal background. Themes that declare their own tool backgrounds keep them. |
| `terminal.emojiMarks` | boolean | `false` | Use the emoji marks (🐚 🦀 🦈 beside notices, 🦑 in the terminal title) instead of the width-safe glyphs. Emoji width varies by terminal. |
| `terminal.hyperlinks` | `boolean \| "auto"` |  | OSC 8 hyperlinks: `true`, `false` or `auto`. `OCTOCODE_HYPERLINKS` overrides detection. |
| `terminal.images` | `"kitty" \| "iterm2" \| "auto" \| false` |  | Inline image protocol: `"kitty"`, `"iterm2"`, `"auto"` or `false`. See [terminal images](configuration.md#terminal-images). |
| `terminal.trueColor` | `boolean \| "auto"` |  | Truecolor output: `true`, `false` or `auto`. `OCTOCODE_TRUE_COLOR` overrides detection. |
| `terminal.completion` | object |  | Tab completion of `!` shell commands. |
| `terminal.completion.shell` | `"auto" \| "zsh" \| "bash" \| "fish" \| "pwsh" \| "none"` | `"auto"` | The shell whose completions Tab offers after `!`: "auto" follows your login shell ($SHELL; PowerShell on Windows without it). "none" starts no shell: Tab then completes program names, git branches and paths only. The shell runs only in a trusted folder. |
| `terminal.completion.loadRc` | boolean | `true` | Start the completion shell with your own startup files (.zshrc, .bashrc, config.fish, the PowerShell profile), so plugin and custom completions work. Off loads only the shell's built-in completion system, which starts faster. |
| `terminal.completion.carapace` | boolean | `true` | When the shell has no completion for a command and `carapace` is on PATH, ask carapace. Trusted folders only. |
| `terminal.suggestions` | object |  | Ghost text while typing a `!` command. |
| `terminal.suggestions.history` | boolean | `true` | Show ghost text while typing a `!` command: a command from the agent's last reply or your earlier `!` commands that starts with what you typed. Right or End accepts it. |
| `terminal.suggestions.model` | boolean | `true` | When neither the last reply nor your history has a match, ask the cheapest connected model (the small tier, resolved from the providers you are signed in to) for the rest of the command. Costs a small call per pause in typing, recorded in the session's usage; no call is made when no cheaper model is available. Read from the global settings only: a project file cannot turn it on. |
| `images` | object |  | Image attachments sent to models. |
| `images.autoResize` | boolean | `true` | Resize images to 2000x2000 maximum for better model compatibility. |
| `images.blockImages` | boolean | `false` | When true, prevents all images from being sent to LLM providers. |
| `editorPaddingX` | number | `0` | Horizontal padding for the input editor. |
| `outputPad` | `0 \| 1` | `1` | Horizontal padding for transcript content. |
| `autocompleteMaxVisible` | number | `5` | Maximum visible items in the autocomplete dropdown. |
| `showHardwareCursor` | boolean |  | Show the terminal cursor while still positioning it for IME. |
| `markdown` | object |  | Rendering of Markdown in the transcript. |
| `markdown.codeBlockIndent` | string | `"  "` | Indent prepended to code blocks in rendered Markdown. |
| `markdown.mermaid` | `"off" \| "final" \| "streaming"` | `"streaming"` | Render Mermaid code blocks as Unicode diagrams: `off`, `final` (after a response completes) or `streaming` (also while it streams). |
| `warnings` | object |  | Optional warnings. |
| `warnings.anthropicExtraUsage` | boolean | `true` | Show the once-per-run notice that a saved Claude subscription token is refused; `false` turns it off. The token is refused either way. |
| `tuiMode` | `"regular" \| "fullscreen"` | `"fullscreen"` | Interface layout; `regular` uses the terminal's normal scrollback. `--tui-mode` overrides it for one run. |
| `fullscreenExitOutput` | `"transcript" \| "resume-hint"` | `"transcript"` | No effect in regular TUI mode. |
| `fullscreenScrollbar` | `"auto" \| "always" \| "hidden"` | `"auto"` | No effect in regular TUI mode. |
| `fullscreenCopyOnSelect` | boolean | `true` | No effect in regular TUI mode. |
| `fullscreenWheelScrollLines` | `number \| "auto"` | `"auto"` | Lines scrolled per wheel event in fullscreen mode; numeric values are clamped from 1 to 100. |
| `fullscreenFrameQueueLimitKiB` | number | `512` | Queued output in KiB past which fullscreen frames are dropped while the terminal is not reading, then repainted whole once it reads again; 0 keeps every frame. Clamped to 64 to 65536. |

## Schema and other settings

| Field | Type | Default | Description |
|---|---|---|---|
| `$schema` | string |  | JSON Schema reference. |
| `providerModels` | object |  | Default model id per provider, e.g. { "anthropic": "claude-opus-5-5" }. Used when defaultModel is unset or its provider is not connected; precedes the built-in per-provider defaults. With neither defaultModel nor defaultProvider set, a provider a subscription pays for (a subscription sign-in or a coding plan) starts the session before one billed per token. |
| `contextBudget` | `integer \| "full"` | `300000` | Working context per session in tokens, capped at 90% of the model's capacity; "full" uses the whole capacity. /context overrides it for one session. |
| `sandbox` | object |  |  |
| `sandbox.mode` | `"off" \| "auto" \| "on"` | `"off"` | `"off"` runs agent shell commands as you, with your rights. `"auto"` runs every command the agent starts (the `bash` tool and its background jobs) inside an operating-system sandbox in the `manual`, `workspace` and `full` permission modes, and unsandboxed in `bypass`; `"on"` sandboxes them in every mode. A sandboxed command reads everything; it writes the workspace (the repository root, or the working folder outside a repository), the system temporary folder and its scratch folder, and nowhere else. A read-only subagent writes only its scratch and throwaway folders, and an isolated subagent its own worktree, never the main tree. Paths later sessions load (git hooks and config, `.octocode/` configuration, instruction files, other agents' project folders) stay write-protected. Network goes through a filtering proxy: in `manual` and `workspace` each new host asks (a private address as a private-network ask), allowed once or for the session; `full` allows every host and records each; a read-only subagent gets none; loopback is always reachable (on Linux, the container's own). A refused write or host is named in the command's result. Your own `!` commands are never sandboxed. macOS (Seatbelt) and Linux (bubblewrap): when the sandbox cannot start (another platform, a missing dependency) or starts weaker than it should (Linux without its seccomp filter), a warning says why and one question asks whether this session's commands run unsandboxed, or in the weaker sandbox. Read from the global settings file; a project file cannot change it. Takes effect for new sessions. |
| `sandbox.allowUnsandboxed` | boolean | `true` | Whether the agent may ask to run a command outside the sandbox (the `bash` tool's `sandbox: false`, and the question when the sandbox cannot start). Such a run asks in every permission mode but `bypass`, and allowing all shell commands never covers it. `false` refuses it without asking. Read from the global settings file only. |
| `externalAgents` | boolean | `false` | Allow model-directed external agent tasks and connections. Off by default; enable selected installed CLIs in /providers. enabledExternalAgents limits vendor CLIs; an existing explicit true without that list keeps all runners available. Discovery starts no CLI; sign-in is checked when used. Global only; project files cannot change it. Reload to apply changes. |
| `sessionApi` | boolean | `true` | Start the local session API on an owner-only Unix socket, so other processes of this user can find and message a running session. On by default; on Windows, which has no such socket here, it starts only with `/api on` or `OCTOCODE_API_HTTP`. Read from the global settings file; a project file cannot change it. `/api on` and `/api off` override it for the running process. Takes effect for new sessions. |
| `sessionApiTurnPermission` | `"workspace" \| "session"` | `"session"` | The permission mode a turn the local session API starts runs under. `session` (default) follows the session's own mode: a session in full takes the message unasked and runs the turn in full, audited, so a remote agent is never stuck on a prompt; workspace and manual sessions ask as they always do. `workspace` holds API-started turns, and messages that steer a running turn, to workspace mode even when the session is in full: its user is asked about the message, and a tool call workspace asks about asks or, with nobody to ask, is refused. Read from the global settings file; a project file cannot change it. Applies to the next message. |
| `mcpExposure` | `"direct" \| "deferred" \| "recent" \| "usage" \| string` | `"usage"` | Initial exposure of MCP tools without a tool or server override. "usage" starts open tools deferred and can promote on-demand tools to thin declarations within mcpPromotedBytes. "recent" uses calls in this working directory in the last 24 hours to select direct tools. "direct" and "deferred" set a fixed default. "auto:&lt;bytes>" keeps servers direct in name order while their contracts fit the budget. An agent without the mcp tool gets direct exposure. |
| `mcpPromotedBytes` | integer | `8192` | Under mcpExposure "usage": the bytes, per role group (main or subagent), that promoted on-demand tools may add to the tool list at the start of a session, most used first; a promoted tool that does not fit stays on demand. 0 keeps every on-demand tool on demand. Bytes, not a share of the context window, so changing models never changes the tool list. |
| `nativeToolExposure` | object |  | Pins a deferrable native tool (archive, models, backlogPlan, configuration; memory and wait under "usage" only): "direct" always declares its full schema, "deferred" declares its description and top-level fields (types, the few values a field allows, required fields) only. Unpinned, the tool is deferred under mcpExposure "recent" until this working directory calls it, and always under "usage"; it is direct otherwise. A deferred tool stays callable, and a call its schema rejects returns the schema. Where the model adds tools after the cached prompt and the agent has the `mcp` tool, an unpinned archive or models (and memory in a subagent) that would be deferred is on demand instead, unless the "usage" promotion snapshot names it: listed in the prompt, declared after its first call or a read with the `mcp` tool. |
| `research` | object |  | Research tool settings. |
| `research.allowedPaths` | `string[]` |  | Extra folders the research tools (localFetch, localSearch, structureSearch, astSearch, lspSearch) may read, added to the workspace, the session folders and loaded skill folders. Absolute paths or paths starting with ~/, for example ["~/code/private-skills"]. Read from the global settings only: a project settings file cannot add folders. Relative paths, "..", the filesystem root, your home folder, the Octocode home and credential folders such as ~/.ssh are refused with a warning. An edit applies after /reload, at the next turn. |
| `toggles` | object |  | Harness, plugin and hook switches by ID, as `/settings` writes them: `harness:&lt;vendor>` (`agents`, `mcp-json`, `pi`, `claude`, `codex`, `cursor`; `true` or `false` overrides the vendor's default, see [commands](commands.md)), `plugin:&lt;path>`, `hooks:&lt;host>`, `hooks:&lt;host>:&lt;source>` or `hook:&lt;id>`; `false` turns the item off. The most specific key wins, and a project key only switches items inside the repository. |
| `enabledExternalAgents` | `string[]` |  | Vendor CLI ids allowed for external agent tasks when externalAgents is on. An empty list allows none; omitted preserves all runners for an existing explicit externalAgents: true. Global only; manage individual agents in /providers. |
| `disabledProviders` | `string[]` |  | Provider ids turned off in /providers. Their models leave the model selector, cycling and subagent routing; saved credentials stay. Global only. |
| `hiddenModels` | object |  | Per provider, the model ids hidden by unticking them on its /providers page or the web provider page. Hidden models leave the model selector, cycling and subagent routing; a provider with no entry shows all its models. Global only. |
| `modelCatalogUpdates` | boolean | `true` | Apply the daily models.dev index to the built-in catalog: newer prices and limits, deprecation marks, and new models of a known family on providers built from models.dev. Off keeps the catalog shipped with Octocode; OCTOCODE_MODELS_DEV=0 also turns it off, and --offline keeps the saved index without fetching. Global only; read once per process, so a change applies after a restart. |
| `providerSources` | object |  | Provider sources you changed from their defaults (Octocode and Pi on, COPILOT_GITHUB_TOKEN off), managed in /providers. Global only. |
| `providerSources.pi` | boolean |  | Use Pi's auth.json (read-only fallback) and models.json. On by default; false leaves them out of availability without changing Pi's files. |
| `providerSources.copilot-env` | boolean |  | Use the COPILOT_GITHUB_TOKEN environment variable as the github-copilot credential. Off by default. |
| `remote` | object |  |  |
| `remote.transport` | `"ssh" \| "relay"` | `"ssh"` | How a published /remote link reaches the daemon: "ssh" prints a port forward to run; "relay" dials remote.relayUrl. |
| `remote.relayUrl` | string |  | The ws:// or wss:// relay the daemon dials for relay links. |
| `remote.autoStart` | `"off" \| "view" \| "control"` | `"off"` | Publish a link of that access ("view" or "control") when a session starts and print it. A project settings file can set "off" but never turn it on; the global value stands. |
| `security` | object |  |  |
| `security.enforce` | `("hooks" \| "mcp" \| "skills")[]` | `["hooks","mcp","skills"]` | The kinds that stay off until you check and approve them in /security: hooks, MCP servers and skills Octocode did not ship. A kind left out is still rated but loads unchecked. Global only. |
| `web` | object |  |  |
| `web.sound` | boolean | `false` | Play a short chime with a web workspace notification (an approval or question waiting, a run finished or failed). The page makes the sound; the toggle in the workspace changes this setting. Notifications themselves need the browser's permission, which the page asks for from its own control. |
| `web.theme` | `"system" \| "light" \| "dark"` | `"system"` | Colour theme of the web workspace: "system" follows the operating system, "light" and "dark" override it. The theme control in the workspace changes this setting. |
| `web.window` | `"app" \| "browser"` | `"app"` | Where /web opens the workspace: "app" is a Chrome, Edge, Chromium or Brave app window with a temporary profile apart from your own (no extensions, cookies or history; removed when it closes); "browser" uses the default browser. Without an installed Chromium browser "app" falls back to the default browser. Applies to the next /web. |
| `sessions` | object |  |  |
| `sessions.autoTitle` | boolean | `true` | Name an unnamed interactive or RPC session after its first turn with one call to a cheaper model, sending it the first message (a later one, up to the third, when that names no task); a session still unnamed at a compaction gets one more try from the summary's goal. Off: sessions keep their first prompt as title. |
| `timer` | object |  | The `notify` tool's cron schedules and its model-judged checks, both off until enabled. |
| `timer.cron` | object |  |  |
| `timer.cron.enabled` | boolean | `false` | Let a session without a screen to confirm on (print, JSON, RPC) set cron schedules with wait. Each run is a model turn with nobody attending, so it is off until you turn it on here; a session with a screen asks once instead. Read from the global settings file; a project file cannot turn it on. |
| `timer.cron.maxUsdPerSession` | number | `2` | The most a session may spend, in USD, since its first cron schedule before cron runs stop. Read from the global settings file. |
| `timer.check` | object |  |  |
| `timer.check.enabled` | boolean | `false` | Let a notify request's check call a cheaper model to judge a condition after its event holds. It spends money, so it is off until you turn it on here or answer the first-use question; caps: 5 judgments and $0.05 per request, $0.25 per session. Read from the global settings file; a project file cannot turn it on. |
| `monitor` | object |  |  |
| `monitor.enabled` | boolean | `true` | Sample the machine (load, memory, swap, GPU, busiest processes) once per interval and tell the session whose processes cause a tripped threshold. One Octocode process per machine takes the samples; every session reads them. |
| `monitor.sampleSeconds` | number | `60` | Seconds between machine samples. |
| `monitor.samples` | number | `3` | Consecutive samples over a threshold before it alerts, so a short spike does not. |
| `monitor.cooldownMinutes` | number | `15` | Minutes before the same threshold alerts again. |
| `monitor.loadPerCore` | number | `3` | Alert when the 1-minute load average per logical CPU reaches this (0 turns it off). |
| `monitor.memoryAvailablePercent` | number | `10` | Alert when the memory the system can still hand out falls to this percentage of the total (0 turns it off). |
| `monitor.swapPercent` | number | `90` | Alert when used swap reaches this percentage of the swap in place (above 100 turns it off). |
| `monitor.gpuPercent` | number | `95` | Alert when GPU utilization reaches this percentage (above 100 turns it off). |
| `monitor.stuckJobMinutes` | number | `15` | Tell the session when one of its background bash jobs has written no output and used almost no CPU for this many minutes (0 turns it off). |
| `monitor.contextBands` | `number[]` | `[0.5,0.75,0.9]` | Shares of the room before automatic compaction at which the model is told, once each, how much context it has used and how much is left. Each is above 0 and below 1; [] turns the notices off. |
| `monitor.checkInSeconds` | number | `300` | Seconds a running subagent and its parent may go without a message before the subagent's own harness asks it whether it needs something. The ping joins a request the subagent was about to make; the parent's model is not called, and nothing is stopped. 0 turns it off. |
| `monitor.idleAgentMinutes` | number | `5` | Minutes a working agent may make no progress (no model reply or tool event) before the agent responsible for it is told, once per silence: a subagent's parent, or a main session itself (a note and a footer mark). Checked once a minute; an agent waiting on the user, its children or its jobs is excused, and nothing is stopped. 0 turns it off. |
| `runtime` | object |  |  |
| `runtime.eventLoop` | string |  | Ignored. The event loop is the only session scheduler; the key is still accepted so a settings file written for an earlier version loads. |
| `runtime.eventWindowSeconds` | number | `2` | Seconds the event loop waits after a background event wakes an idle session, so completions that arrive together share one turn. User input releases the window immediately. |
| `runtime.smartRouting` | object |  | Native octocode/auto-code routing policy. The router runs only when that virtual model is selected. |
| `runtime.smartRouting.allow` | `string[]` |  | Provider/model patterns the native octocode/auto-code router may select, for example ["openai/gpt-5*", "anthropic/*"]. Empty or omitted allows every eligible model. |
| `runtime.smartRouting.deny` | `string[]` |  | Provider/model patterns auto-code never selects. Deny rules win over allow rules. |
| `runtime.smartRouting.tiers` | object |  | Capability tier overrides keyed by provider/model pattern: 1 light, 2 general, 3 frontier. The first matching pattern wins. |
| `runtime.smartRouting.planOnly` | boolean | `false` | Restrict auto-code to flat-rate subscription or coding-plan models. Default false. |
| `runtime.smartRouting.allowPlanToMeteredEscalation` | boolean | `false` | Allow a session that used a flat-rate plan to switch to per-token billing. Default false. Global settings only. |
| `runtime.smartRouting.cooldownRequests` | integer | `4` | Routed requests for which auto-code skips a recently failed model. Default 4. |
| `runtime.smartRouting.outputReserveTokens` | integer | `8192` | Output tokens auto-code reserves when checking whether the conversation fits a candidate. Default 8192. |
| `memory` | object |  |  |
| `memory.file` | boolean | `true` | Load the global MEMORY.md (in the Octocode home) and the repository's .octocode/agent/MEMORY.md into the system prompt at session start. Off: neither is read or written. |
| `memory.autoUpdate` | `"off" \| "explicit" \| "auto"` | `"auto"` | Who writes the MEMORY.md files: "off" nobody (the files are only read), "explicit" saves you or the agent make with memory set or /memory add, "auto" those plus the background passes that harvest and consolidate lessons. |
| `memory.subagents` | `"workspace" \| "all" \| "none"` | `"workspace"` | Which MEMORY.md files a subagent gets: "workspace" the repository's, "all" the global one too, "none" neither. A lean subagent gets none. |
| `memory.recall` | `"off" \| "main" \| "all"` | `"main"` | Before each prompt, add pinned and word-matched notes from the notes database: "off" never, "main" in the main session only, "all" in subagents too. OCTOCODE_MEMORY_AUTO=0 turns it off for the process. |
| `memory.reflection` | boolean | `true` | Let a long main session end with one call to the cheaper model (subagents.models.small) that proposes lessons for MEMORY.md. Needs autoUpdate "auto". |
| `memory.subagentPinnedKind` | `"preference" \| "fact" \| "decision" \| "gotcha" \| "procedure" \| "reference"` | `"preference"` | The one kind of pinned note a subagent's recall includes (with recall "all"); pinned notes of other kinds stay out of its prompt. The main session always gets every pinned kind. |
| `backlog` | object |  |  |
| `backlog.qa` | `"important" \| "all" \| "off"` | `"important"` | Which items a small reviewer model checks before `backlog done` completes them. `important`: p0 and p1 features and bugs. `all`: every item except epics. `off`: none. A reviewer that finds a defect returns the item to ongoing, or to the backlog when evidence is missing, with its findings noted; without a priced small model the item completes with a note. Each review costs a small-model run. |
| `limits` | object |  | Bounds on context, repetition, requests and spend. Every key is optional and falls back to the built-in value for the model in use. |
| `limits.compaction` | object |  |  |
| `limits.compaction.trigger` | number |  | Context size at which automatic compaction starts: a share of the working window (0.1 to 1) or a token count (above 1). It can only compact earlier than the built-in point, which keeps room for the reply and the summary; a later value has no effect. |
| `limits.compaction.keepRecent` | number |  | The newest conversation kept word for word across a compaction: a share of the working window (up to 0.25) or a token count (above 1, at most a quarter of the window). Default: 10% of the window, at least 20,000 tokens. |
| `limits.clearing` | object |  |  |
| `limits.clearing.keepTurns` | integer |  | Assistant turns whose tool results are never cleared. Default 10. |
| `limits.clearing.keepInUseTokens` | integer |  | Tokens of older tool results kept because a recent message names their path. Default 20,000. |
| `limits.run` | object |  |  |
| `limits.run.maxRequests` | integer |  | Model requests one run of the main session may make (from a prompt until the agent stops): a note at this count, a stop at 1.5 times it. 0 turns it off. Default: off when a user is present, 300 for a run without one. Read from the global settings file only. |
| `limits.subagent` | object |  |  |
| `limits.subagent.maxRequests` | integer |  | Model requests a subagent task may make: a note at this count, a stop at 1.5 times it. 0 turns it off. An agent profile's `maxRequests` wins. Default 160. Read from the global settings file only. |
| `limits.loop` | object |  | The repeated-call guard. The three counts must rise: noteAt, stopAt, haltAt. |
| `limits.loop.noteAt` | integer |  | Identical calls with identical results in a row that earn the first note. Default 3. |
| `limits.loop.stopAt` | integer |  | The count that earns the stronger note. Default 5. |
| `limits.loop.haltAt` | integer |  | The count after which the same call is refused and the run ends. Default 8. |
| `limits.cost` | object |  |  |
| `limits.cost.max` | number |  | US dollars billed per token, the session's own and its subagents', past which the session sends no further model request and starts no subagent. Usage a plan covers never counts. Read from the global settings file only. |
| `limits.cost.warnAt` | number |  | US dollars at which you are told once what the session has spent. Read from the global settings file only. |
| `limits.models` | object |  | Overrides for one model, keyed `provider/model`; `*` matches any run of characters, e.g. { "ollama/*": { "compaction": { "trigger": 0.7 } } }. An exact key wins over a pattern, and a longer pattern over a shorter one. |
| `optimizePrompts` | boolean | `false` | Rewrite each prompt you submit in the interactive terminal with one call to a cheaper model (the one the `small` purpose resolves to, else the session model), then show the rewrite and let you send it, edit it or send your original. Slash commands, `!` lines and empty input are never rewritten. `/optimize on` and `/optimize off` change it. |
| `leanPrompt` | `"auto" \| "on" \| "off"` | `"auto"` | The main session's policy text. "auto" (the default) uses the lean policy for a model whose context window is under 64k tokens or the model subagents.models.small names, and the full policy otherwise; "on" always uses the lean policy, "off" never. The lean policy states the working, safety and reporting rules only: it leaves out delegation, the rules for running subagents and the list of skills (each stays loadable by name), so a small or local model keeps its window for the work. |

## Telemetry and privacy

`enableInstallTelemetry` (default `true`) controls two things:

- An anonymous version ping, sent when an interactive session without earlier messages starts on a first run or after an update, and only if `OCTOCODE_INSTALL_TELEMETRY_URL` names an endpoint (there is no default endpoint). `OCTOCODE_OFFLINE` also suppresses it.
- Attribution headers on requests to OpenRouter, NVIDIA NIM and Cloudflare models.

`OCTOCODE_TELEMETRY` overrides the setting: `1`, `true` or `yes` enables both; any other value disables them. `enableAnalytics` (default `false`) and `trackingId` are stored preferences; nothing in this repository reads them to send data. See [environment variables](environment-variables.md#octocode-process-configuration).
