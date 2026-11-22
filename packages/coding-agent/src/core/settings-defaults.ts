import { DEFAULT_MAX_RETRY_DELAY_MS, DEFAULT_OFFLINE_INTERVAL_MS } from "@octocodeai/octocode-ai/utils/retry";
import { RETENTION_DEFAULTS } from "../storage/retention.ts";
import { RESULT_DEFAULT_BYTES } from "../utils/output-budget.ts";
import { MONITOR_DEFAULTS } from "./settings-schema/monitor.ts";
import { RUNTIME_DEFAULTS } from "./settings-schema/runtime.ts";

/** `sandbox.mode`: never, in every permission mode but `bypass`, or always. */
export type SandboxMode = "off" | "auto" | "on";

/** Tokens kept free for the reply when compacting or summarizing a branch. */
export const DEFAULT_RESERVE_TOKENS = 16384;

/** Runtime defaults shared by settings accessors and the published JSON Schema. */
export const SETTINGS_DEFAULTS = {
	transport: "auto",
	/** Messages queued during a run reach the model together, one request for all of them (`agent/state.ts`). */
	steeringMode: "all",
	followUpMode: "all",
	/** Working context for a session: this many tokens, at most 90% of the model's capacity. */
	contextBudget: 300_000,
	/** When the main session gets the lean policy: "auto" decides by the model's window and tier (`octocode/turn.ts`). */
	leanPrompt: "auto" as "auto" | "on" | "off",
	/**
	 * Built-in compaction values, not a user setting: `compaction` is not a settings key (a settings file's block is reported as
	 * unknown and has no effect), and `builtInCompactionSettings` derives the real thresholds from
	 * these as the ceiling for each model's window.
	 */
	compaction: {
		enabled: true,
		reserveTokens: DEFAULT_RESERVE_TOKENS,
		keepRecentTokens: 20000,
	},
	branchSummary: {
		reserveTokens: DEFAULT_RESERVE_TOKENS,
		skipPrompt: false,
	},
	retry: {
		enabled: true,
		maxRetries: 3,
		baseDelayMs: 2000,
		maxAgentDelayMs: DEFAULT_MAX_RETRY_DELAY_MS,
		offlineIntervalMs: DEFAULT_OFFLINE_INTERVAL_MS,
		provider: {
			maxRetryDelayMs: 60000,
		},
		fallbackModels: [] as string[],
		fallbackCooldownMs: 15 * 60_000,
	},
	toolExecution: { earlyStart: false },
	hideThinkingBlock: true,
	showCacheMissNotices: false,
	quietStartup: false,
	/** How file references open: `auto` picks the IDE or GUI editor, `editor` the prompt editor, else a command. */
	referenceOpener: "auto",
	bashBackgroundAfterSeconds: 90,
	bashOutputMaxBytes: RESULT_DEFAULT_BYTES,
	bash: {
		inheritProviderKeys: false,
		spillMaxBytes: 1024 * 1024 * 1024,
		longCommandAfterSeconds: 30,
		deliberateMaxSeconds: 600,
		longCommandPatterns: [] as string[],
	},
	sandbox: { mode: "off" as SandboxMode, allowUnsandboxed: true },
	backlog: { qa: "important" as "important" | "all" | "off" },
	subagents: {
		/** The event loop's window (`runtime.eventWindowSeconds`): wakes merge alike whichever scheduler delivers them. */
		wakeHoldSeconds: RUNTIME_DEFAULTS.eventWindowSeconds,
		peerOverlapWake: true,
	},
	monitor: MONITOR_DEFAULTS,
	runtime: RUNTIME_DEFAULTS,
	externalAgents: false,
	sessionApi: true,
	sessionApiTurnPermission: "session",
	mcpPresentation: "declared",
	/** MCP tools and the deferrable native tools declared thin; the usage snapshot only declares on-demand ones (the MCP package's `DEFAULT_MCP_EXPOSURE_SETTING`). */
	mcpExposure: "usage",
	/** Bytes per role group that usage promotion may add to the tool list (the MCP package's `DEFAULT_MCP_PROMOTED_BYTES`). */
	mcpPromotedBytes: 8192,
	collapseChangelog: false,
	enableInstallTelemetry: true,
	enableAnalytics: false,
	enableSkillCommands: true,
	terminal: {
		showImages: true,
		imageWidthCells: 60,
		clearOnShrink: false,
		replayRows: 5000,
		showTerminalProgress: false,
		reduceMotion: "auto" as boolean | "auto",
		screenReader: "auto" as boolean | "auto",
		emojiMarks: false,
		toolBands: false,
		surfaceFills: false,
		latencyFence: "auto" as boolean | "auto",
		completion: { shell: "auto" as "auto" | "zsh" | "bash" | "fish" | "pwsh" | "none", loadRc: true, carapace: true },
		suggestions: { history: true, model: true },
	},
	images: {
		autoResize: true,
		blockImages: false,
	},
	doubleEscapeAction: "tree",
	treeFilterMode: "default",
	editorPaddingX: 0,
	outputPad: 1,
	autocompleteMaxVisible: 5,
	markdown: {
		codeBlockIndent: "  ",
		mermaid: "streaming",
	},
	warnings: {
		anthropicExtraUsage: true,
	},
	cacheWarming: "idle",
	retention: RETENTION_DEFAULTS,
	optimizePrompts: false,
	remote: { transport: "ssh", autoStart: "off" },
	sessions: { autoTitle: true },
	/** The curated MEMORY.md files and per-prompt recall from the notes database (`octocode/memory/`). */
	memory: {
		file: true,
		autoUpdate: "auto" as "off" | "explicit" | "auto",
		subagents: "workspace" as "workspace" | "all" | "none",
		recall: "main" as "off" | "main" | "all",
		reflection: true,
		subagentPinnedKind: "preference" as "preference" | "fact" | "decision" | "gotcha" | "procedure" | "reference",
	},
	security: { enforce: ["hooks", "mcp", "skills"] },
	// History is written every turn and read within minutes: the short tier is cheaper. Instructions are shared across
	// turns, sessions and subagents: the long tier pays (see prompt-caching.md).
	cacheRetention: "short",
	instructionCacheRetention: "long",
	tuiMode: "fullscreen",
	fullscreenExitOutput: "transcript",
	fullscreenScrollbar: "auto",
	fullscreenCopyOnSelect: true,
	fullscreenWheelScrollLines: "auto",
	fullscreenFrameQueueLimitKiB: 512,
} as const;
