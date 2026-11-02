import { ModelThinkingLevelSchema } from "@octocodeai/octocode-ai/providers/model-schema";
import { type Static, Type } from "typebox";
import { CachePreferenceProperties } from "./cache-preferences-schema.ts";
import { SETTINGS_DEFAULTS } from "./settings-defaults.ts";
import {
	BranchSummarySettingsSchema,
	ImageSettingsSchema,
	MarkdownSettingsSchema,
	MarketplaceRecordSchema,
	PackageSourceSchema,
	PluginInstallSourceSchema,
	RetrySettingsSchema,
	SkillsInputSchema,
	TerminalSettingsSchema,
	type ThinkingBudgetsSettingsSchema,
	thinkingBudgetsSettings,
	timeoutSetting,
	WarningSettingsSchema,
} from "./settings-schema/sections.ts";

export const SettingsSchema = Type.Object(
	{
		...CachePreferenceProperties,
		$schema: Type.Optional(Type.String({ description: "JSON Schema reference." })),
		lastChangelogVersion: Type.Optional(Type.String()),
		defaultProvider: Type.Optional(Type.String()),
		defaultModel: Type.Optional(Type.String()),
		providerModels: Type.Optional(
			Type.Record(Type.String(), Type.String(), {
				description:
					'Default model id per provider, e.g. { "anthropic": "claude-opus-5-5" }. Used when defaultModel is unset or its provider is not connected; precedes the built-in per-provider defaults.',
			}),
		),
		defaultThinkingLevel: Type.Optional(ModelThinkingLevelSchema),
		modelThinkingLevels: Type.Optional(
			Type.Record(Type.String(), ModelThinkingLevelSchema, {
				description: 'Per-model default thinking level overrides keyed by "provider/modelId".',
			}),
		),
		contextBudget: Type.Optional(
			Type.Union([Type.Integer({ minimum: 8192 }), Type.Literal("full")], {
				description:
					'Working context per session in tokens, capped at 90% of the model\'s capacity; "full" uses the whole capacity. /context overrides it for one session.',
				default: SETTINGS_DEFAULTS.contextBudget,
			}),
		),
		transport: Type.Optional(
			Type.Union(
				[Type.Literal("auto"), Type.Literal("sse"), Type.Literal("websocket"), Type.Literal("websocket-cached")],
				{ default: SETTINGS_DEFAULTS.transport },
			),
		),
		steeringMode: Type.Optional(
			Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")], {
				default: SETTINGS_DEFAULTS.steeringMode,
			}),
		),
		followUpMode: Type.Optional(
			Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")], {
				default: SETTINGS_DEFAULTS.followUpMode,
			}),
		),
		theme: Type.Optional(Type.String()),
		branchSummary: Type.Optional(BranchSummarySettingsSchema),
		retry: Type.Optional(RetrySettingsSchema),
		hideThinkingBlock: Type.Optional(Type.Boolean({ default: SETTINGS_DEFAULTS.hideThinkingBlock })),
		showCacheMissNotices: Type.Optional(
			Type.Boolean({
				description: "Show cache cost and provider recovery notices.",
				default: SETTINGS_DEFAULTS.showCacheMissNotices,
			}),
		),
		externalEditor: Type.Optional(
			Type.String({ description: "Command for Ctrl+G external editor; takes precedence over VISUAL and EDITOR." }),
		),
		shellPath: Type.Optional(
			Type.String({
				description: "Custom shell path, for example for Cygwin on Windows, with support for leading ~ expansion.",
			}),
		),
		quietStartup: Type.Optional(
			Type.Union([Type.Boolean(), Type.Literal("header")], {
				description: 'When true, hide all startup output. When "header", keep only the startup header.',
				default: SETTINGS_DEFAULTS.quietStartup,
			}),
		),
		shellCommandPrefix: Type.Optional(
			Type.String({ description: "Prefix prepended to every bash command, for example to enable shell aliases." }),
		),
		bashBackgroundAfterSeconds: Type.Optional(
			Type.Number({
				description:
					"Seconds a foreground bash command may run before it moves to the background as a job (its exit arrives as a message). 0 turns this off. The OCTOCODE_BASH_BACKGROUND_AFTER_SECONDS environment variable overrides it.",
				minimum: 0,
				default: SETTINGS_DEFAULTS.bashBackgroundAfterSeconds,
			}),
		),
		bashOutputMaxBytes: Type.Optional(
			Type.Number({
				description:
					"Most bytes of one foreground bash result that reach the model (about 4 bytes per token); the line limit scales with it (500 lines at the default). Longer output keeps its first 20% and last 80%, plus matched error lines, and is saved in full. A call can lower it with maxOutputTokens. Output of the user's own `!` commands follows the same limit.",
				minimum: 1024,
				default: SETTINGS_DEFAULTS.bashOutputMaxBytes,
			}),
		),
		mcpPresentation: Type.Optional(
			Type.Union([Type.Literal("compact"), Type.Literal("json")], {
				description:
					'How the cached system prompt describes MCP tools: every enabled server\'s instructions and each enabled tool\'s description and schema, in one block per server. "compact" writes them as a generated TypeScript file (a tool it cannot express faithfully is described in plain form); "json" describes every tool in plain form, as the server sent it. Provider declarations are thin either way: a one-line trigger and the top-level field types, with calls validated against the server\'s own JSON Schema.',
				default: SETTINGS_DEFAULTS.mcpPresentation,
			}),
		),
		research: Type.Optional(
			Type.Object(
				{
					allowedPaths: Type.Optional(
						Type.Array(Type.String(), {
							description:
								'Extra folders the research tools (localFetch, localSearch, structureSearch, astSearch, lspSearch) may read, added to the workspace, the session folders and loaded skill folders. Absolute paths or paths starting with ~/, for example ["~/code/private-skills"]. Read from the global settings only: a project settings file cannot add folders. Relative paths, "..", the filesystem root, your home folder, the Octocode home and credential folders such as ~/.ssh are refused with a warning. An edit applies after /reload, at the next turn.',
						}),
					),
				},
				{ description: "Research tool settings." },
			),
		),
		npmCommand: Type.Optional(
			Type.Array(Type.String(), {
				description:
					'Command used for npm package lookup and installation, in argv form such as ["mise", "exec", "node@20", "--", "npm"].',
			}),
		),
		collapseChangelog: Type.Optional(
			Type.Boolean({
				description: "Show the condensed changelog after update; use /changelog for the full changelog.",
				default: SETTINGS_DEFAULTS.collapseChangelog,
			}),
		),
		enableInstallTelemetry: Type.Optional(
			Type.Boolean({
				description: "Send an anonymous version and update ping after changelog-detected updates.",
				default: SETTINGS_DEFAULTS.enableInstallTelemetry,
			}),
		),
		enableAnalytics: Type.Optional(
			Type.Boolean({
				description: "Opt in to analytics data sharing.",
				default: SETTINGS_DEFAULTS.enableAnalytics,
			}),
		),
		trackingId: Type.Optional(
			Type.String({ description: "Analytics tracking identifier, generated when analytics is enabled." }),
		),
		plugins: Type.Optional(
			Type.Array(
				Type.Object(
					{
						path: Type.String({ description: "Absolute local plugin directory." }),
						protocol: Type.Union([Type.Literal("claude"), Type.Literal("codex")]),
						enabled: Type.Optional(Type.Boolean({ default: true })),
						source: Type.Optional(PluginInstallSourceSchema),
					},
					{ additionalProperties: true },
				),
				{
					description:
						"Local compatibility plugins. Activates namespaced skills, supported prompt commands, hooks and MCP servers; adding or enabling a plugin approves its hooks and MCP servers. Other components require their own adapters.",
				},
			),
		),
		marketplaces: Type.Optional(
			Type.Record(Type.String(), MarketplaceRecordSchema, {
				description:
					"Plugin marketplaces by name, as `octocode marketplace add` writes them. Global only: project settings cannot register one.",
			}),
		),
		toggles: Type.Optional(
			Type.Record(Type.String(), Type.Boolean(), {
				description:
					"Plugin and hook switches by ID, as `/harness` writes them: `plugin:<path>`, `hooks:<host>`, `hooks:<host>:<source>` or `hook:<id>`; `false` turns the item off. The most specific key wins, and a project key only switches items inside the repository.",
			}),
		),
		packages: Type.Optional(
			Type.Array(PackageSourceSchema, {
				description: "npm or git package sources, as strings or objects with resource filtering.",
			}),
		),
		extensions: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"`builtin:<id>` entries switch a built-in feature on (llama.cpp, mcp). Other entries are ignored: user code extensions are not supported.",
			}),
		),
		deviceId: Type.Optional(
			Type.String({
				description: "Stable installation UUID, generated when authentication first needs it. Global only.",
			}),
		),
		skills: Type.Optional(SkillsInputSchema),
		prompts: Type.Optional(
			Type.Array(Type.String(), { description: "Local prompt template file paths or directories." }),
		),
		themes: Type.Optional(Type.Array(Type.String(), { description: "Local theme file paths or directories." })),
		enableSkillCommands: Type.Optional(
			Type.Boolean({
				description: "Register skills as /skill:name commands.",
				default: SETTINGS_DEFAULTS.enableSkillCommands,
			}),
		),
		terminal: Type.Optional(TerminalSettingsSchema),
		images: Type.Optional(ImageSettingsSchema),
		enabledModels: Type.Optional(
			Type.Array(Type.String(), {
				description: "Model patterns for cycling, in the same format as the --models CLI flag.",
			}),
		),
		defaultTools: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Initial tool selection. Plain names replace the inherited selection; +name and -name entries add or remove tools.",
			}),
		),
		doubleEscapeAction: Type.Optional(
			Type.Union([Type.Literal("fork"), Type.Literal("tree"), Type.Literal("none")], {
				description: "Action for double-escape with an empty editor.",
				default: SETTINGS_DEFAULTS.doubleEscapeAction,
			}),
		),
		treeFilterMode: Type.Optional(
			Type.Union(
				[
					Type.Literal("default"),
					Type.Literal("no-tools"),
					Type.Literal("user-only"),
					Type.Literal("labeled-only"),
					Type.Literal("all"),
				],
				{
					description: "Default filter when opening /tree.",
					default: SETTINGS_DEFAULTS.treeFilterMode,
				},
			),
		),
		thinkingBudgets: Type.Optional(
			thinkingBudgetsSettings({
				description: "Custom token budgets for thinking levels.",
			}),
		),
		editorPaddingX: Type.Optional(
			Type.Number({
				description: "Horizontal padding for the input editor.",
				default: SETTINGS_DEFAULTS.editorPaddingX,
			}),
		),
		outputPad: Type.Optional(
			Type.Union([Type.Literal(0), Type.Literal(1)], {
				description: "Horizontal padding for transcript content.",
				default: SETTINGS_DEFAULTS.outputPad,
			}),
		),
		autocompleteMaxVisible: Type.Optional(
			Type.Number({
				description: "Maximum visible items in the autocomplete dropdown.",
				default: SETTINGS_DEFAULTS.autocompleteMaxVisible,
			}),
		),
		showHardwareCursor: Type.Optional(
			Type.Boolean({ description: "Show the terminal cursor while still positioning it for IME." }),
		),
		markdown: Type.Optional(MarkdownSettingsSchema),
		warnings: Type.Optional(WarningSettingsSchema),
		sessionDir: Type.Optional(
			Type.String({
				description: "Custom session storage directory, in the same format as the --session-dir CLI flag.",
			}),
		),
		httpProxy: Type.Optional(
			Type.String({
				description: "Proxy URL applied as HTTP_PROXY and HTTPS_PROXY for Octocode-managed HTTP clients.",
			}),
		),
		httpIdleTimeoutMs: Type.Optional(
			timeoutSetting({
				description: 'HTTP header or body idle timeout in milliseconds; 0 or "disabled" disables it.',
			}),
		),
		remote: Type.Optional(
			Type.Object(
				{
					transport: Type.Optional(
						Type.Union([Type.Literal("ssh"), Type.Literal("relay")], {
							description:
								'How a published /remote link reaches the daemon: "ssh" prints a port forward to run; "relay" dials remote.relayUrl.',
							default: SETTINGS_DEFAULTS.remote.transport,
						}),
					),
					relayUrl: Type.Optional(
						Type.String({ description: "The ws:// or wss:// relay the daemon dials for relay links." }),
					),
					autoStart: Type.Optional(
						Type.Union([Type.Literal("off"), Type.Literal("view"), Type.Literal("control")], {
							description:
								'Publish a link of that access ("view" or "control") when a session starts and print it. A project settings file can set "off" but never turn it on; the global value stands.',
							default: SETTINGS_DEFAULTS.remote.autoStart,
						}),
					),
				},
				{ additionalProperties: false },
			),
		),
		sessions: Type.Optional(
			Type.Object(
				{
					autoTitle: Type.Optional(
						Type.Boolean({
							description:
								"Name an unnamed interactive or RPC session after its first turn with one call to a cheaper model, sending it the first message (a later one, up to the third, when that names no task); a session still unnamed at a compaction gets one more try from the summary's goal. Off: sessions keep their first prompt as title.",
							default: SETTINGS_DEFAULTS.sessions.autoTitle,
						}),
					),
				},
				{ additionalProperties: false },
			),
		),
		cacheWarming: Type.Optional(
			Type.Union([Type.Literal("off"), Type.Literal("streaming"), Type.Literal("idle")], {
				description:
					'Cache-warming profile. "idle" also warms between agent runs. Global only because each refresh costs money.',
				default: SETTINGS_DEFAULTS.cacheWarming,
			}),
		),
		websocketConnectTimeoutMs: Type.Optional(
			timeoutSetting({
				description: 'WebSocket connect or open handshake timeout in milliseconds; 0 or "disabled" disables it.',
			}),
		),
		tuiMode: Type.Optional(
			Type.Union([Type.Literal("regular"), Type.Literal("fullscreen")], {
				default: SETTINGS_DEFAULTS.tuiMode,
			}),
		),
		fullscreenExitOutput: Type.Optional(
			Type.Union([Type.Literal("transcript"), Type.Literal("resume-hint")], {
				description: "No effect in regular TUI mode.",
				default: SETTINGS_DEFAULTS.fullscreenExitOutput,
			}),
		),
		fullscreenScrollbar: Type.Optional(
			Type.Union([Type.Literal("auto"), Type.Literal("always"), Type.Literal("hidden")], {
				description: "No effect in regular TUI mode.",
				default: SETTINGS_DEFAULTS.fullscreenScrollbar,
			}),
		),
		fullscreenCopyOnSelect: Type.Optional(
			Type.Boolean({
				description: "No effect in regular TUI mode.",
				default: SETTINGS_DEFAULTS.fullscreenCopyOnSelect,
			}),
		),
		fullscreenWheelScrollLines: Type.Optional(
			Type.Union([Type.Number(), Type.Literal("auto")], {
				description: "Lines scrolled per wheel event in fullscreen mode; numeric values are clamped from 1 to 100.",
				default: SETTINGS_DEFAULTS.fullscreenWheelScrollLines,
			}),
		),
		queueMode: Type.Optional(
			Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")], {
				description: "Legacy setting migrated to steeringMode.",
				deprecated: true,
			}),
		),
		websockets: Type.Optional(Type.Boolean({ description: "Legacy setting migrated to transport.", deprecated: true })),
	},
	{ additionalProperties: true },
);

type SettingsInput = Static<typeof SettingsSchema>;

interface RetrySettings extends Omit<Static<typeof RetrySettingsSchema>, "maxDelayMs"> {}
export interface ThinkingBudgetsSettings extends Static<typeof ThinkingBudgetsSettingsSchema> {}
export type MermaidRenderingMode = NonNullable<Static<typeof MarkdownSettingsSchema>["mermaid"]>;
export interface WarningSettings extends Static<typeof WarningSettingsSchema> {}
export type QuietStartup = NonNullable<SettingsInput["quietStartup"]>;
export type TransportSetting = NonNullable<SettingsInput["transport"]>;
export type PackageSource = Static<typeof PackageSourceSchema>;
export type FullscreenExitOutput = NonNullable<SettingsInput["fullscreenExitOutput"]>;
export type TuiMode = NonNullable<SettingsInput["tuiMode"]>;
export type CacheWarmingMode = NonNullable<SettingsInput["cacheWarming"]>;
export type RemoteSettings = NonNullable<SettingsInput["remote"]>;
export interface Settings extends Omit<SettingsInput, "queueMode" | "retry" | "skills" | "websockets"> {
	retry?: RetrySettings;
	skills?: string[];
}
