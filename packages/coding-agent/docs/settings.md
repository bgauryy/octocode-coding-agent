# Settings

<!-- This file is generated from TypeScript source. Do not edit it manually; run yarn run generate:references. -->

`settings.json` holds global defaults in the agent directory (see [Configuration](configuration.md#agent-directory)) and project overrides in `.octocode/settings.json`. A trusted project's values override global ones: objects merge recursively and arrays replace. Edit the file directly and run `/reload`, or use `/settings`. See [CONFIGURATIONS.md](../../../CONFIGURATIONS.md) for every configuration location.

For editor validation and completion, point `$schema` at `schemas/settings.schema.json` in the installed Octocode package.

Loading is permissive: a root key this page does not list is kept in the file but has no effect, and startup reports it once per load as a warning that names the key and the file. Unknown keys inside a listed object are not checked.

Nested fields are listed as `parent.child`. Defaults shown are the values Octocode uses when a field is absent; an empty Default cell means no fixed value.

## Models and thinking

| Field | Type | Default | Description |
|---|---|---|---|
| `defaultProvider` | string |  | Provider of the model that starts a session when no model is selected; used with `defaultModel`. |
| `defaultModel` | string |  | Model ID that starts a session when no model is selected; used with `defaultProvider`. |
| `defaultThinkingLevel` | `"off" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max"` |  | Thinking level for the starting model when neither the model pattern nor `modelThinkingLevels` sets one; `high` when unset. Subagents never take it: each route names its own level. |
| `modelThinkingLevels` | object |  | Per-model default thinking level overrides keyed by "provider/modelId". |
| `transport` | `"auto" \| "sse" \| "websocket" \| "websocket-cached"` | `"auto"` | Request transport for the OpenAI Codex Responses API, which can stream over SSE or WebSocket; `websocket-cached` and `auto` reuse cached context on WebSocket. |
| `enabledModels` | `string[]` |  | Model patterns for cycling, in the same format as the --models CLI flag. |
| `thinkingBudgets` | object |  | Custom token budgets for thinking levels. |

## Caching, retries and network

Cache behavior is described in [prompt caching](prompt-caching.md) and retry behavior in [Retries](configuration.md#retries).

| Field | Type | Default | Description |
|---|---|---|---|
| `cacheRetention` | `"none" \| "short" \| "long"` | `"long"` | Conversation cache retention. Without a separate instruction preference, applies to both layers. |
| `instructionCacheRetention` | `"none" \| "short" \| "long"` | `"long"` | Instruction cache retention, limited by endpoint capabilities. Long writes can cost more. |
| `retry` | object |  | Automatic retry of transient model failures. |
| `retry.enabled` | boolean | `true` | `false` turns off all retries. |
| `retry.maxRetries` | number | `3` | Retry attempts after a transient failure. Rate limits and capacity or transport failures have their own minimum. |
| `retry.baseDelayMs` | number | `2000` | Exponential backoff base delay in milliseconds: 2s, 4s, 8s. |
| `retry.maxAgentDelayMs` | number | `60000` | Longest wait before one retry, in milliseconds. |
| `retry.provider` | object |  | Retries inside the provider SDK, separate from the session retries above. |
| `retry.provider.timeoutMs` | number |  | SDK or provider request timeout in milliseconds. |
| `retry.provider.maxRetries` | number |  | SDK or provider retry attempts. |
| `retry.provider.maxRetryDelayMs` | number | `60000` | Maximum server-requested delay before failing. |
| `retry.maxDelayMs` | number |  | Legacy retry delay setting. Use provider.maxRetryDelayMs instead. |
| `showCacheMissNotices` | boolean | `false` | Show cache cost and provider recovery notices. |
| `httpProxy` | string |  | Proxy URL applied as HTTP_PROXY and HTTPS_PROXY for Octocode-managed HTTP clients. |
| `httpIdleTimeoutMs` | `number \| "disabled"` |  | HTTP header or body idle timeout in milliseconds; 0 or "disabled" disables it. |
| `cacheWarming` | `"off" \| "streaming" \| "idle"` | `"idle"` | Cache-warming profile. "idle" also warms between agent runs. Global only because each refresh costs money. |
| `websocketConnectTimeoutMs` | `number \| "disabled"` |  | WebSocket connect or open handshake timeout in milliseconds; 0 or "disabled" disables it. |

## Sessions, queues and tools

| Field | Type | Default | Description |
|---|---|---|---|
| `steeringMode` | `"all" \| "one-at-a-time"` | `"one-at-a-time"` | Messages queued while the agent streams: `one-at-a-time` delivers one and waits for the response; `all` delivers them together. |
| `followUpMode` | `"all" \| "one-at-a-time"` | `"one-at-a-time"` | Follow-up messages queued until the agent stops: `one-at-a-time` delivers one and waits for the response; `all` delivers them together. |
| `branchSummary` | object |  | Summaries of abandoned branches when navigating the session tree. |
| `branchSummary.reserveTokens` | number | `16384` | Tokens reserved for the prompt and LLM response. |
| `branchSummary.skipPrompt` | boolean | `false` | When true, skips the "Summarize branch?" prompt and defaults to no summary. |
| `mcpPresentation` | `"compact" \| "json"` | `"compact"` | How the cached system prompt describes MCP tools: every enabled server's instructions and each enabled tool's description and schema, in one block per server. "compact" writes them as a generated TypeScript file (a tool it cannot express faithfully is described in plain form); "json" describes every tool in plain form, as the server sent it. Provider declarations are thin either way: a one-line trigger and the top-level field types, with calls validated against the server's own JSON Schema. |
| `defaultTools` | `string[]` |  | Initial tool selection. Plain names replace the inherited selection; +name and -name entries add or remove tools. |
| `doubleEscapeAction` | `"fork" \| "tree" \| "none"` | `"tree"` | Action for double-escape with an empty editor. |
| `treeFilterMode` | `"default" \| "no-tools" \| "user-only" \| "labeled-only" \| "all"` | `"default"` | Default filter when opening /tree. |
| `sessionDir` | string |  | Custom session storage directory, in the same format as the --session-dir CLI flag. |
| `retention` | object |  | How long cleanup keeps data; one global policy for every project, so a project settings file cannot set it. |
| `retention.days` | integer | `30` | Days Octocode keeps output, bash logs, subagent scratch, session data, `&lt;workspace>/.octocode/tmp` entries and database history after their last write. 0 keeps them forever. `OCTOCODE_CLEANUP_DAYS` overrides it. |
| `retention.sessionDays` | integer | `90` | Days a session transcript (JSONL, in a workspace or the legacy per-folder directories) is kept after its last write, then removed with its session data and database rows; the current and running sessions are never removed. 0 keeps transcripts forever. `OCTOCODE_SESSION_RETENTION_DAYS` overrides it. |
| `subagents` | object |  | Limits on the subagents a session starts, and how they are checked on. |
| `subagents.maxChildren` | integer |  | Subagents one session may start; a resume of a child it started is no new one. Past it a new spawn is refused with the total; what runs keeps running. |
| `subagents.maxCost` | number |  | US dollars of recorded spend, the session's own and its subagents', past which a new spawn is refused with the total; what runs keeps running. |
| `subagents.checkInSeconds` | number | `300` | Seconds a running subagent and its parent may go without a message before the subagent's own harness asks it whether it needs something. The ping joins a request the subagent was about to make; the parent's model is not called, and nothing is stopped. 0 turns it off. |

## Shell and packages

| Field | Type | Default | Description |
|---|---|---|---|
| `shellPath` | string |  | Custom shell path, for example for Cygwin on Windows, with support for leading ~ expansion. |
| `shellCommandPrefix` | string |  | Prefix prepended to every bash command, for example to enable shell aliases. |
| `bashBackgroundAfterSeconds` | number | `90` | Seconds a foreground bash command may run before it moves to the background as a job (its exit arrives as a message). 0 turns this off. The OCTOCODE_BASH_BACKGROUND_AFTER_SECONDS environment variable overrides it. |
| `bashOutputMaxBytes` | number | `20000` | Most bytes of one foreground bash result that reach the model (about 4 bytes per token); the line limit scales with it (500 lines at the default). Longer output keeps its first 20% and last 80%, plus matched error lines, and is saved in full. A call can lower it with maxOutputTokens. Output of the user's own `!` commands follows the same limit. |
| `bash` | object |  |  |
| `bash.inheritProviderKeys` | boolean | `false` | Keep provider API keys (`OPENAI_API_KEY`, `HF_TOKEN`…) in the environment of bash commands. Off by default: a command's output reaches the model, and a build script or an injected command can read its environment. `GH_TOKEN` and other tool tokens are not provider keys and stay either way. A nested `octocode` still signs in through `auth.json`. Read from the global settings file; a project file cannot turn it on. Takes effect for new sessions. |
| `bash.spillMaxBytes` | integer | `1073741824` | Most bytes the saved full output of one foreground bash command holds (commands the agent runs and the user's own `!` commands). Past it the file keeps the first half and the end of the output around a marker, and the result's header says how much was dropped, so a command stuck in a loop cannot fill the disk. What reaches the model below the cap does not change. 0 lifts the cap. |
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

See [packages](packages.md), [skills](skills.md), [plugins](plugins.md) and [hooks and extensions](../../../PLUGINS.md).

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
| `packages[].extensions` | `string[]` |  |  |
| `packages[].skills` | `string[]` |  |  |
| `packages[].prompts` | `string[]` |  |  |
| `packages[].themes` | `string[]` |  |  |
| `extensions` | `string[]` |  | `builtin:&lt;id>` entries switch a built-in feature on (llama.cpp, mcp). Other entries are ignored: user code extensions are not supported. |
| `skills` | `string[] \| object` |  | Local skill file paths or directories. |
| `prompts` | `string[]` |  | Local prompt template file paths or directories. |
| `themes` | `string[]` |  | Local theme file paths or directories. |
| `enableSkillCommands` | boolean | `true` | Register skills as /skill:name commands. |

## Interface

| Field | Type | Default | Description |
|---|---|---|---|
| `lastChangelogVersion` | string |  | Version whose changelog was last recorded. Octocode sets it; it decides whether to show the changelog and send the install ping after an update. |
| `theme` | string |  | Name of the active interface theme. |
| `hideThinkingBlock` | boolean | `true` | Collapse each finished thinking block to one line (`Thought for 4s`); `app.thinking.toggle` (ctrl+t) or a click expands it. |
| `externalEditor` | string |  | Command for Ctrl+G external editor; takes precedence over VISUAL and EDITOR. |
| `quietStartup` | `boolean \| "header"` | `false` | When true, hide all startup output. When "header", keep only the startup header. |
| `collapseChangelog` | boolean | `false` | Show the condensed changelog after update; use /changelog for the full changelog. |
| `terminal` | object |  | Terminal rendering. See [Terminal images](configuration.md#terminal-images) and [Reduced motion](configuration.md#reduced-motion). |
| `terminal.showImages` | boolean | `true` | Show images when the terminal supports them. |
| `terminal.imageWidthCells` | number | `60` | Preferred inline image width in terminal cells. |
| `terminal.clearOnShrink` | boolean | `false` | Clear empty rows when content shrinks. |
| `terminal.showTerminalProgress` | boolean | `false` | Show OSC 9;4 terminal progress indicators. |
| `terminal.reduceMotion` | `boolean \| "auto"` | `"auto"` | Freeze spinners, shimmer and glow; elapsed times still tick. "auto" follows OCTOCODE_REDUCE_MOTION (1 or true). |
| `terminal.hyperlinks` | `boolean \| "auto"` |  | OSC 8 hyperlinks: `true`, `false` or `auto`. `OCTOCODE_HYPERLINKS` overrides detection. |
| `terminal.images` | `"kitty" \| "iterm2" \| "auto" \| false` |  | Inline image protocol: `"kitty"`, `"iterm2"`, `"auto"` or `false`. See [terminal images](configuration.md#terminal-images). |
| `terminal.trueColor` | `boolean \| "auto"` |  | Truecolor output: `true`, `false` or `auto`. `OCTOCODE_TRUE_COLOR` overrides detection. |
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
| `warnings.anthropicExtraUsage` | boolean | `true` | Warn once per run when an Anthropic model is used with subscription authentication. |
| `tuiMode` | `"regular" \| "fullscreen"` | `"fullscreen"` | Interface layout; `regular` uses the terminal's normal scrollback. `--tui-mode` overrides it for one run. |
| `fullscreenExitOutput` | `"transcript" \| "resume-hint"` | `"transcript"` | No effect in regular TUI mode. |
| `fullscreenScrollbar` | `"auto" \| "always" \| "hidden"` | `"auto"` | No effect in regular TUI mode. |
| `fullscreenCopyOnSelect` | boolean | `true` | No effect in regular TUI mode. |
| `fullscreenWheelScrollLines` | `number \| "auto"` | `"auto"` | Lines scrolled per wheel event in fullscreen mode; numeric values are clamped from 1 to 100. |

## Schema and legacy settings

| Field | Type | Default | Description |
|---|---|---|---|
| `$schema` | string |  | JSON Schema reference. |
| `providerModels` | object |  | Default model id per provider, e.g. { "anthropic": "claude-opus-5-5" }. Used when defaultModel is unset or its provider is not connected; precedes the built-in per-provider defaults. |
| `contextBudget` | `integer \| "full"` | `300000` | Working context per session in tokens, capped at 90% of the model's capacity; "full" uses the whole capacity. /context overrides it for one session. |
| `externalAgents` | boolean | `false` | Declare the `external` type of the agent tool, which reaches ACP agents and other Octocode instances. Off by default; when true the type is still declared only while a known ACP agent is on PATH or another Octocode instance runs. Read from the global settings file; a project file cannot turn it on. Takes effect for new sessions. |
| `sessionApi` | boolean | `true` | Start the local session API on an owner-only Unix socket, so other processes of this user can find and message a running session. On by default; on Windows, which has no such socket here, it starts only with `/api on` or `OCTOCODE_API_HTTP`. Read from the global settings file; a project file cannot change it. `/api on` and `/api off` override it for the running process. Takes effect for new sessions. |
| `sessionApiTurnPermission` | `"workspace" \| "session"` | `"workspace"` | The permission mode a turn the local session API starts on an idle session runs under. `workspace` (default) holds it to workspace mode even when the session is in full: its user is asked about the message, and a tool call workspace asks about asks or, with nobody to ask, is refused. `session` restores the session's own mode (full takes the message unasked and runs the turn in full). A message to a session that is already working follows the session's mode either way. Read from the global settings file; a project file cannot change it. Applies to the next message. |
| `mcpExposure` | `"direct" \| "deferred" \| string` | `"direct"` | How much of each MCP tool the cached system prompt carries, for tools whose server sets no `exposure` (a server's or tool's own `exposure` wins). "direct": the full description and schema. "deferred": the server's purpose and one trigger line per tool; the agent reads the full upstream text with the `mcp` tool when it needs it, as a tool result, so the cached prefix never changes. "auto:&lt;bytes>": servers stay direct, in name order, while their direct text fits within that many bytes, and are deferred past it. Tools stay declared and validated against the server's full schema either way, and nothing is deferred for an agent without the `mcp` tool. |
| `research` | object |  | Research tool settings. |
| `research.allowedPaths` | `string[]` |  | Extra folders the research tools (localFetch, localSearch, structureSearch, astSearch, lspSearch) may read, added to the workspace, the session folders and loaded skill folders. Absolute paths or paths starting with ~/, for example ["~/code/private-skills"]. Read from the global settings only: a project settings file cannot add folders. Relative paths, "..", the filesystem root, your home folder, the Octocode home and credential folders such as ~/.ssh are refused with a warning. An edit applies after /reload, at the next turn. |
| `toggles` | object |  | Plugin and hook switches by ID, as `/harness` writes them: `plugin:&lt;path>`, `hooks:&lt;host>`, `hooks:&lt;host>:&lt;source>` or `hook:&lt;id>`; `false` turns the item off. The most specific key wins, and a project key only switches items inside the repository. |
| `remote` | object |  |  |
| `remote.transport` | `"ssh" \| "relay"` | `"ssh"` | How a published /remote link reaches the daemon: "ssh" prints a port forward to run; "relay" dials remote.relayUrl. |
| `remote.relayUrl` | string |  | The ws:// or wss:// relay the daemon dials for relay links. |
| `remote.autoStart` | `"off" \| "view" \| "control"` | `"off"` | Publish a link of that access ("view" or "control") when a session starts and print it. A project settings file can set "off" but never turn it on; the global value stands. |
| `sessions` | object |  |  |
| `sessions.autoTitle` | boolean | `true` | Name an unnamed interactive or RPC session after its first turn with one call to a cheaper model, sending it the first message (a later one, up to the third, when that names no task); a session still unnamed at a compaction gets one more try from the summary's goal. Off: sessions keep their first prompt as title. |
| `optimizePrompts` | boolean | `false` | Rewrite each prompt you submit in the interactive terminal with one call to a cheaper model (the one the `small` purpose resolves to, else the session model), then show the rewrite and let you send it, edit it or send your original. Slash commands, `!` lines and empty input are never rewritten. `/optimize on` and `/optimize off` change it. |
| `queueMode` | `"all" \| "one-at-a-time"` |  | Legacy setting migrated to steeringMode. |
| `websockets` | boolean |  | Legacy setting migrated to transport. |

## Telemetry and privacy

`enableInstallTelemetry` (default `true`) controls two things:

- An anonymous version ping, sent when an interactive session without earlier messages starts on a first run or after an update, and only if `OCTOCODE_INSTALL_TELEMETRY_URL` names an endpoint (there is no default endpoint). `OCTOCODE_OFFLINE` also suppresses it.
- Attribution headers on requests to OpenRouter, NVIDIA NIM and Cloudflare models.

`OCTOCODE_TELEMETRY` overrides the setting: `1`, `true` or `yes` enables both; any other value disables them. `enableAnalytics` (default `false`) and `trackingId` are stored preferences; nothing in this repository reads them to send data. See [environment variables](environment-variables.md#octocode-process-configuration).
