/**
 * Small display helpers: clearing the editor, error and warning lines, the markdown theme and transformers, tool
 * renderer lookup, the fullscreen scrollbar and PNG transcoder, and the startup display flags.
 */

import { GLYPH, type MarkdownTheme, Spacer, ThemedText } from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";
import type { MarkdownTransformer, ToolRenderers } from "../../../core/features/index.ts";
import { withBuiltInRenderers } from "../../../core/tools/renderers/index.ts";
import { ensurePngTranscoder as ensureSharedPngTranscoder } from "../../../utils/image-convert.ts";
import { STATE_COLOR } from "../../../theme/status.ts";
import { getMarkdownTheme, theme } from "../../../theme/theme.ts";
import type { ThemeColor } from "../../../theme/theme-tokens.ts";
import type { InteractiveModeHost } from "./host.ts";

/** Interactive-mode members used by the display helpers. */
type DisplayHost = Pick<
	InteractiveModeHost,
	| "chatContainer"
	| "editor"
	| "mermaidMarkdownTransformer"
	| "options"
	| "outputPad"
	| "session"
	| "settingsManager"
	| "uiStore"
	| "transcriptScrollView"
	| "ui"
>;

export function getMarkdownThemeWithSettings(host: DisplayHost): MarkdownTheme {
	return {
		...getMarkdownTheme(),
		codeBlockIndent: host.settingsManager.getCodeBlockIndent(),
	};
}

export function getStartupExpansionState(host: DisplayHost): boolean {
	return host.options.verbose || host.uiStore.getState().view.toolsExpanded;
}

/** Startup header (title, version, key hints). Hidden only by quietStartup: true. */
export function shouldShowStartupHeader(host: DisplayHost): boolean {
	return host.options.verbose === true || host.settingsManager.getQuietStartup() !== true;
}

/** Startup details (model scope, loaded resources). Hidden by quietStartup: true or "header". */
export function shouldShowStartupDetails(host: DisplayHost): boolean {
	return host.options.verbose === true || host.settingsManager.getQuietStartup() === false;
}

export function applyFullscreenScrollbarSetting(host: DisplayHost): void {
	host.transcriptScrollView?.setScrollbar(host.settingsManager.getFullscreenScrollbar());
}

/** Lets extension images use the PNG transcoder; tool results register it themselves. */
export function ensurePngTranscoder(host: DisplayHost): void {
	ensureSharedPngTranscoder(() => {
		host.ui.invalidate();
		host.ui.requestRender();
	});
}

/**
 * Get a registered tool definition by name (for custom rendering).
 */
/**
 * Extension-registered definition, falling back to the built-in one. The renderer components take
 * whatever this returns, so they never reach into the tool registry themselves.
 */
export function getRegisteredToolDefinition(host: DisplayHost, toolName: string): ToolRenderers | undefined {
	return host.session.extensionRunner.resolveToolRenderers(toolName, () =>
		withBuiltInRenderers(toolName, host.session.getToolDefinition(toolName)),
	);
}

export function getMarkdownTransformers(host: DisplayHost): MarkdownTransformer[] {
	return [host.mermaidMarkdownTransformer, ...host.session.extensionRunner.getMarkdownTransformers()];
}

export function clearEditor(host: DisplayHost): void {
	host.editor.setText("");
	host.ui.requestRender();
}

/** The three notice kinds: one `<glyph> <sentence>` line in a state colour (`STATE_COLOR`; `warning` is the risk colour). */
type NoticeKind = "success" | "warning" | "error";

const NOTICE_MARK: Record<NoticeKind, { glyph: string; color: ThemeColor }> = {
	success: { glyph: GLYPH.done, color: STATE_COLOR.done },
	warning: { glyph: GLYPH.warning, color: "warning" },
	error: { glyph: GLYPH.failed, color: STATE_COLOR.failed },
};

/** A notice line at the transcript's left pad: `✓ New session started`, `⚠ Project config not loaded`, `✗ Compaction failed`. */
export function noticeLine(kind: NoticeKind, message: string, pad: number): ThemedText {
	const { glyph, color } = NOTICE_MARK[kind];
	// Messages often carry tool or provider output (gh stderr, extension errors); none of it may drive the terminal.
	const text = sanitizeTerminalText(message);
	// An error must stand out whole; elsewhere the mark carries the state, so a long warning is no wall of amber.
	const paint = () =>
		kind === "error" ? theme.fg(color, `${glyph} ${text}`) : `${theme.fg(color, glyph)} ${theme.fg("text", text)}`;
	return new ThemedText(paint, pad, 0);
}

export function showError(host: DisplayHost, errorMessage: string): void {
	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(noticeLine("error", errorMessage, host.outputPad));
	host.ui.requestRender();
}

export function showWarning(host: DisplayHost, warningMessage: string): void {
	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(noticeLine("warning", warningMessage, host.outputPad));
	host.ui.requestRender();
}
