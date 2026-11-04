import { DEFAULT_MAX_RETRY_DELAY_MS } from "@octocodeai/octocode-ai/utils/retry";
import { RETENTION_DEFAULTS } from "../config/retention.ts";
import { RESULT_DEFAULT_BYTES } from "../utils/output-budget.ts";

/** Tokens kept free for the reply when compacting or summarizing a branch. */
export const DEFAULT_RESERVE_TOKENS = 16384;

/** Runtime defaults shared by settings accessors and the published JSON Schema. */
export const SETTINGS_DEFAULTS = {
	transport: "auto",
	steeringMode: "one-at-a-time",
	followUpMode: "one-at-a-time",
	/** Working context for a session: this many tokens, at most 90% of the model's capacity. */
	contextBudget: 300_000,
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
		provider: {
			maxRetryDelayMs: 60000,
		},
	},
	hideThinkingBlock: true,
	showCacheMissNotices: false,
	quietStartup: false,
	bashBackgroundAfterSeconds: 90,
	bashOutputMaxBytes: RESULT_DEFAULT_BYTES,
	bash: {
		inheritProviderKeys: false,
		spillMaxBytes: 1024 * 1024 * 1024,
	},
	subagents: {
		checkInSeconds: 300,
	},
	externalAgents: false,
	sessionApi: true,
	sessionApiTurnPermission: "workspace",
	mcpPresentation: "compact",
	mcpExposure: "direct",
	collapseChangelog: false,
	enableInstallTelemetry: true,
	enableAnalytics: false,
	enableSkillCommands: true,
	terminal: {
		showImages: true,
		imageWidthCells: 60,
		clearOnShrink: false,
		showTerminalProgress: false,
		reduceMotion: "auto" as boolean | "auto",
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
	cacheRetention: "long",
	instructionCacheRetention: "long",
	tuiMode: "fullscreen",
	fullscreenExitOutput: "transcript",
	fullscreenScrollbar: "auto",
	fullscreenCopyOnSelect: true,
	fullscreenWheelScrollLines: "auto",
} as const;
