import type { ThinkingLevel } from "@octocodeai/octocode-agent-core";
import type { Model, Transport } from "@octocodeai/octocode-ai";
import type { CachePreferences } from "@octocodeai/octocode-ai/utils/cache-policy";
import type { ScrollViewScrollbar, WheelScrollLines } from "@octocodeai/octocode-tui";
import type {
	CacheWarmingMode,
	DefaultProjectTrust,
	FullscreenExitOutput,
	MermaidRenderingMode,
	QuietStartup,
	TuiMode,
	WarningSettings,
} from "../../../../core/settings-manager.ts";
import type { ThemeAppearance } from "../../../../theme/theme.ts";

export interface SettingsConfig {
	cachePreferences?: CachePreferences;
	defaultModel: string;
	currentModel?: Model<any>;
	availableDefaultModels: readonly Model<any>[];
	showImages: boolean;
	imageWidthCells: number;
	autoResizeImages: boolean;
	blockImages: boolean;
	enableSkillCommands: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	transport: Transport;
	httpIdleTimeoutMs: number;
	cacheWarmingMode: CacheWarmingMode;
	thinkingLevel: ThinkingLevel;
	availableThinkingLevels: ThinkingLevel[];
	modelThinkingLevels: Record<string, ThinkingLevel>;
	currentTheme: string;
	terminalTheme: ThemeAppearance;
	availableThemes: string[];
	hideThinkingBlock: boolean;
	mermaidRenderingMode: MermaidRenderingMode;
	showCacheMissNotices: boolean;
	collapseChangelog: boolean;
	enableInstallTelemetry: boolean;
	doubleEscapeAction: "fork" | "tree" | "none";
	treeFilterMode: "default" | "no-tools" | "user-only" | "labeled-only" | "all";
	showHardwareCursor: boolean;
	editorPaddingX: number;
	outputPad: 0 | 1;
	autocompleteMaxVisible: number;
	quietStartup: QuietStartup;
	defaultProjectTrust: DefaultProjectTrust;
	clearOnShrink: boolean;
	showTerminalProgress: boolean;
	reduceMotion: boolean | "auto";
	tuiMode: TuiMode;
	fullscreenExitOutput: FullscreenExitOutput;
	fullscreenScrollbar: ScrollViewScrollbar;
	fullscreenCopyOnSelect: boolean;
	fullscreenWheelScrollLines: WheelScrollLines;
	warnings: WarningSettings;
}

export interface SettingsCallbacks {
	onCachePreferenceChange?: (
		field: keyof CachePreferences,
		value: NonNullable<CachePreferences[keyof CachePreferences]>,
	) => void;
	onShowImagesChange: (enabled: boolean) => void;
	onImageWidthCellsChange: (width: number) => void;
	onAutoResizeImagesChange: (enabled: boolean) => void;
	onBlockImagesChange: (blocked: boolean) => void;
	onEnableSkillCommandsChange: (enabled: boolean) => void;
	onSteeringModeChange: (mode: "all" | "one-at-a-time") => void;
	onFollowUpModeChange: (mode: "all" | "one-at-a-time") => void;
	onTransportChange: (transport: Transport) => void;
	onHttpIdleTimeoutMsChange: (timeoutMs: number) => void;
	onCacheWarmingModeChange: (mode: CacheWarmingMode) => void;
	onModelThinkingLevelChange: (provider: string, modelId: string, level: ThinkingLevel) => void;
	onModelThinkingLevelRemove: (provider: string, modelId: string) => void;
	onThemeChange: (theme: string) => void;
	onThemePreview?: (theme: string) => void;
	onHideThinkingBlockChange: (hidden: boolean) => void;
	onMermaidRenderingModeChange: (mode: MermaidRenderingMode) => void;
	onShowCacheMissNoticesChange: (shown: boolean) => void;
	onCollapseChangelogChange: (collapsed: boolean) => void;
	onEnableInstallTelemetryChange: (enabled: boolean) => void;
	onDoubleEscapeActionChange: (action: "fork" | "tree" | "none") => void;
	onTreeFilterModeChange: (mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all") => void;
	onShowHardwareCursorChange: (enabled: boolean) => void;
	onEditorPaddingXChange: (padding: number) => void;
	onOutputPadChange: (padding: 0 | 1) => void;
	onAutocompleteMaxVisibleChange: (maxVisible: number) => void;
	onQuietStartupChange: (quiet: QuietStartup) => void;
	onDefaultProjectTrustChange: (defaultProjectTrust: DefaultProjectTrust) => void;
	onClearOnShrinkChange: (enabled: boolean) => void;
	onShowTerminalProgressChange: (enabled: boolean) => void;
	onReduceMotionChange: (value: boolean | "auto") => void;
	onTuiModeChange: (mode: TuiMode) => void;
	onFullscreenExitOutputChange: (output: FullscreenExitOutput) => void;
	onFullscreenScrollbarChange: (mode: ScrollViewScrollbar) => void;
	onFullscreenCopyOnSelectChange: (enabled: boolean) => void;
	onFullscreenWheelScrollLinesChange: (lines: WheelScrollLines) => void;
	onWarningsChange: (warnings: WarningSettings) => void;
	onCancel: () => void;
}
