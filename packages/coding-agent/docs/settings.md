# Settings

<!-- This file is generated from TypeScript source. Do not edit it manually; run yarn run generate:references. -->

`settings.json` holds global defaults in the agent directory (see [Configuration](configuration.md#agent-directory)) and project overrides in `.octocode/settings.json`. A trusted project's values override global ones: objects merge recursively and arrays replace. Edit the file directly and run `/reload`, or use `/settings`. See [CONFIGURATIONS.md](../../../CONFIGURATIONS.md) for every configuration location.

For editor validation and completion, point `$schema` at `schemas/settings.schema.json` in the installed Octocode package.

Nested fields are listed as `parent.child`. Defaults shown are the values Octocode uses when a field is absent; an empty Default cell means no fixed value.

## Models and thinking

| Field | Type | Default | Description |
|---|---|---|---|
| `defaultProvider` | string |  | Provider of the model that starts a session when no model is selected; used with `defaultModel`. |
| `defaultModel` | string |  | Model ID that starts a session when no model is selected; used with `defaultProvider`. |
| `defaultThinkingLevel` | `"off" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max"` |  | Thinking level for the starting model when neither the model pattern nor `modelThinkingLevels` sets one. |
| `modelThinkingLevels` | object |  | Per-model default thinking level overrides keyed by "provider/modelId". |
| `transport` | `"auto" \| "sse" \| "websocket" \| "websocket-cached"` | `"auto"` | Request transport for the OpenAI Codex Responses API, which can stream over SSE or WebSocket; `websocket-cached` and `auto` reuse cached context on WebSocket. |
| `enabledModels` | `string[]` |  | Model patterns for cycling, in the same format as the --models CLI flag. |
| `thinkingBudgets` | object |  | Custom token budgets for thinking levels. |

## Caching, retries and network

Cache behavior is described in [prompt caching](prompt-caching.md) and retry behavior in [Retries](configuration.md#retries).

| Field | Type | Default | Description |
|---|---|---|---|
| `cacheRetention` | `"none" \| "short" \| "long"` | `"short"` | Conversation cache retention. Without a separate instruction preference, applies to both layers. |
| `instructionCacheRetention` | `"none" \| "short" \| "long"` | `"long"` | Instruction cache retention, limited by endpoint capabilities. Long writes can cost more. |
| `retry` | object |  | Automatic retry of transient model failures. |
| `retry.enabled` | boolean | `true` | `false` turns off all retries. |
| `retry.maxRetries` | number | `3` | Retry attempts after a transient failure. Rate-limit errors have their own minimum. |
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
| `mcpPresentation` | `"compact" \| "json"` | `"compact"` | How MCP tools reach the model. "compact" shows each server as a generated TypeScript file in the cached system prompt, declares its tools with a one-line trigger and the top-level field types, and validates calls against the server's own JSON Schema. "json" declares every tool with its full JSON Schema and ignores the generated files. |
| `defaultTools` | `string[]` |  | Initial tool selection. Plain names replace the inherited selection; +name and -name entries add or remove tools. |
| `doubleEscapeAction` | `"fork" \| "tree" \| "none"` | `"tree"` | Action for double-escape with an empty editor. |
| `treeFilterMode` | `"default" \| "no-tools" \| "user-only" \| "labeled-only" \| "all"` | `"default"` | Default filter when opening /tree. |
| `sessionDir` | string |  | Custom session storage directory, in the same format as the --session-dir CLI flag. |

## Shell and packages

| Field | Type | Default | Description |
|---|---|---|---|
| `shellPath` | string |  | Custom shell path, for example for Cygwin on Windows, with support for leading ~ expansion. |
| `shellCommandPrefix` | string |  | Prefix prepended to every bash command, for example to enable shell aliases. |
| `bashBackgroundAfterSeconds` | number | `90` | Seconds a foreground bash command may run before it moves to the background as a job (its exit arrives as a message). 0 turns this off. The OCTOCODE_BASH_BACKGROUND_AFTER_SECONDS environment variable overrides it. |
| `npmCommand` | `string[]` |  | Command used for npm package lookup and installation, in argv form such as ["mise", "exec", "node@20", "--", "npm"]. |

## Trust, telemetry and identity

`defaultProjectTrust` is read from the global file only; a project file cannot grant itself trust. `deviceId` and `trackingId` are generated by Octocode.

| Field | Type | Default | Description |
|---|---|---|---|
| `defaultProjectTrust` | `"ask" \| "always" \| "never"` | `"ask"` | Global setting only. |
| `enableInstallTelemetry` | boolean | `true` | Send an anonymous version and update ping after changelog-detected updates. |
| `enableAnalytics` | boolean | `false` | Opt in to analytics data sharing. |
| `trackingId` | string |  | Analytics tracking identifier, generated when analytics is enabled. |
| `deviceId` | string |  | Stable installation UUID, generated when authentication first needs it. Global only. |

## Resources

See [packages](packages.md), [skills](skills.md), [extensions](extensions.md) and [plugins](plugins.md).

| Field | Type | Default | Description |
|---|---|---|---|
| `plugins` | `object[]` |  | Local compatibility plugins. Activates namespaced skills, supported prompt commands, reviewed hooks and reviewed MCP servers; other components require their own adapters. |
| `plugins[].path` | string |  | Required. Absolute local plugin directory. |
| `plugins[].protocol` | `"claude" \| "codex"` |  | Required. |
| `plugins[].enabled` | boolean | `true` |  |
| `plugins[].hooksFingerprint` | string |  | SHA-256 of reviewed plugin hook declarations. Changed definitions require review again. |
| `plugins[].mcpFingerprint` | string |  | SHA-256 of reviewed plugin MCP declarations. Changed definitions require review again. |
| `packages` | `(string \| object)[]` |  | npm or git package sources, as strings or objects with resource filtering. |
| `packages[].source` | string |  | Required. |
| `packages[].autoload` | boolean |  | When false, start empty and only apply explicit resource patterns. |
| `packages[].extensions` | `string[]` |  |  |
| `packages[].skills` | `string[]` |  |  |
| `packages[].prompts` | `string[]` |  |  |
| `packages[].themes` | `string[]` |  |  |
| `extensions` | `string[]` |  | Local extension file paths or directories. |
| `skills` | `string[] \| object` |  | Local skill file paths or directories. |
| `prompts` | `string[]` |  | Local prompt template file paths or directories. |
| `themes` | `string[]` |  | Local theme file paths or directories. |
| `enableSkillCommands` | boolean | `true` | Register skills as /skill:name commands. |

## Interface

| Field | Type | Default | Description |
|---|---|---|---|
| `lastChangelogVersion` | string |  | Version whose changelog was last recorded. Octocode sets it; it decides whether to show the changelog and send the install ping after an update. |
| `theme` | string |  | Name of the active interface theme. |
| `hideThinkingBlock` | boolean | `false` | Hide thinking blocks in assistant responses. |
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
| `toggles` | object |  | Plugin and hook switches by ID, as `/plugins` writes them: `plugin:&lt;path>`, `hooks:&lt;host>`, `hooks:&lt;host>:&lt;source>` or `hook:&lt;id>`; `false` turns the item off. The most specific key wins, and a project key only switches items inside the repository. |
| `queueMode` | `"all" \| "one-at-a-time"` |  | Legacy setting migrated to steeringMode. |
| `websockets` | boolean |  | Legacy setting migrated to transport. |

## Telemetry and privacy

`enableInstallTelemetry` (default `true`) controls two things:

- An anonymous version ping, sent when an interactive session without earlier messages starts on a first run or after an update, and only if `OCTOCODE_INSTALL_TELEMETRY_URL` names an endpoint (there is no default endpoint). `OCTOCODE_OFFLINE` also suppresses it.
- Attribution headers on requests to OpenRouter, NVIDIA NIM and Cloudflare models.

`OCTOCODE_TELEMETRY` overrides the setting: `1`, `true` or `yes` enables both; any other value disables them. `enableAnalytics` (default `false`) and `trackingId` are stored preferences; nothing in this repository reads them to send data. See [environment variables](environment-variables.md#octocode-process-configuration).
