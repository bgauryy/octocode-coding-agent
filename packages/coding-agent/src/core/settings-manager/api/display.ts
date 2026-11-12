import type { ScrollViewScrollbar, TerminalCapabilities, WheelScrollLines } from "@octocodeai/octocode-tui";
import type { FullscreenExitOutput, MermaidRenderingMode, TuiMode, WarningSettings } from "../../settings-schema.ts";

/** Theme, terminal, fullscreen, images, editor and markdown display, and warnings. */
export interface DisplaySettingsApi {
	/** The theme setting; without one, the Octocode pair that follows the terminal's light or dark appearance. */
	getThemeSetting(): string;
	getTheme(): string | undefined;
	setTheme(theme: string): void;
	getHideThinkingBlock(): boolean;
	getShowCacheMissNotices(): boolean;
	setHideThinkingBlock(hide: boolean): void;
	setShowCacheMissNotices(show: boolean): void;
	getTerminalCapabilityOverrides(): Partial<TerminalCapabilities>;
	getShowImages(): boolean;
	setShowImages(show: boolean): void;
	getImageWidthCells(): number;
	setImageWidthCells(width: number): void;
	getClearOnShrink(): boolean;
	setClearOnShrink(enabled: boolean): void;
	getShowTerminalProgress(): boolean;
	setShowTerminalProgress(enabled: boolean): void;
	getReduceMotion(): boolean | "auto";
	isReduceMotionActive(): boolean;
	setReduceMotion(value: boolean | "auto"): void;
	getTuiMode(): TuiMode;
	setTuiMode(mode: TuiMode): void;
	getFullscreenExitOutput(): FullscreenExitOutput;
	setFullscreenExitOutput(output: FullscreenExitOutput): void;
	getFullscreenScrollbar(): ScrollViewScrollbar;
	setFullscreenScrollbar(mode: ScrollViewScrollbar): void;
	getFullscreenCopyOnSelect(): boolean;
	setFullscreenCopyOnSelect(enabled: boolean): void;
	getFullscreenWheelScrollLines(): WheelScrollLines;
	setFullscreenWheelScrollLines(lines: WheelScrollLines): void;
	getFullscreenFrameQueueLimitBytes(): number | undefined;
	getImageAutoResize(): boolean;
	setImageAutoResize(enabled: boolean): void;
	getBlockImages(): boolean;
	setBlockImages(blocked: boolean): void;
	getDoubleEscapeAction(): "fork" | "tree" | "none";
	setDoubleEscapeAction(action: "fork" | "tree" | "none"): void;
	getTreeFilterMode(): "default" | "no-tools" | "user-only" | "labeled-only" | "all";
	setTreeFilterMode(mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all"): void;
	getShowHardwareCursor(): boolean;
	setShowHardwareCursor(enabled: boolean): void;
	getEditorPaddingX(): number;
	setEditorPaddingX(padding: number): void;
	getOutputPad(): 0 | 1;
	setOutputPad(padding: 0 | 1): void;
	getAutocompleteMaxVisible(): number;
	setAutocompleteMaxVisible(maxVisible: number): void;
	getCodeBlockIndent(): string;
	getMermaidRenderingMode(): MermaidRenderingMode;
	setMermaidRenderingMode(mode: MermaidRenderingMode): void;
	getWarnings(): WarningSettings;
	setWarnings(warnings: WarningSettings): void;
}
