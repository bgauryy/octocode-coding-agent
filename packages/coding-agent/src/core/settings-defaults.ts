import { DEFAULT_MAX_AGENT_RETRY_DELAY_MS } from "@octocodeai/octocode-ai/utils/retry";

/** Runtime defaults shared by settings accessors and the published JSON Schema. */
export const SETTINGS_DEFAULTS = {
	transport: "auto",
	steeringMode: "one-at-a-time",
	followUpMode: "one-at-a-time",
	/** Working context for a session: this many tokens, at most 90% of the model's capacity. */
	contextBudget: 300_000,
	compaction: {
		enabled: true,
		reserveTokens: 16384,
		keepRecentTokens: 20000,
	},
	branchSummary: {
		reserveTokens: 16384,
		skipPrompt: false,
	},
	retry: {
		enabled: true,
		maxRetries: 3,
		baseDelayMs: 2000,
		maxAgentDelayMs: DEFAULT_MAX_AGENT_RETRY_DELAY_MS,
		provider: {
			maxRetryDelayMs: 60000,
		},
	},
	hideThinkingBlock: false,
	showCacheMissNotices: false,
	quietStartup: false,
	bashBackgroundAfterSeconds: 90,
	bashOutputMaxBytes: 24 * 1024,
	mcpPresentation: "compact",
	defaultProjectTrust: "ask",
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
	remote: { transport: "ssh", autoStart: "off" },
	cacheRetention: "long",
	instructionCacheRetention: "long",
	tuiMode: "fullscreen",
	fullscreenExitOutput: "transcript",
	fullscreenScrollbar: "auto",
	fullscreenCopyOnSelect: true,
	fullscreenWheelScrollLines: "auto",
} as const;
