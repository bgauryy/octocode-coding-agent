/**
 * Small display helpers: clearing the editor, error and warning lines, the markdown theme and transformers, tool
 * renderer lookup, the fullscreen scrollbar and PNG transcoder, and the startup display flags.
 */

import { GLYPH, type MarkdownTheme, Spacer, ThemedText, TONE } from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";
import type { MarkdownTransformer, ToolRenderers } from "../../../core/features/index.ts";
import { withBuiltInRenderers } from "../../../octocode/files/built-in-renderers.ts";
import { itemTitle, withItemTitlesInMarkdown } from "../../../octocode/render/item-titles.ts";
import { ensurePngTranscoder as ensureSharedPngTranscoder } from "../../../utils/image-convert.ts";
import { LongResponse } from "../components/long-response.ts";
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

/** Lets feature images use the PNG transcoder; tool results register it themselves. */
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
 * Feature-registered definition, falling back to the built-in one. The renderer components take
 * whatever this returns, so they never reach into the tool registry themselves.
 */
export function getRegisteredToolDefinition(host: DisplayHost, toolName: string): ToolRenderers | undefined {
	return host.session.featureHost.resolveToolRenderers(toolName, () =>
		withBuiltInRenderers(toolName, host.session.getToolDefinition(toolName)),
	);
}

/** A backlog ID in a reply is drawn with its title (`B12 “Title”`) at its first mention; the stored reply is unchanged. */
const itemTitleTransformer: MarkdownTransformer = (markdown, context) =>
	context.messageType === "assistant" ? withItemTitlesInMarkdown(markdown, itemTitle) : markdown;

export function getMarkdownTransformers(host: DisplayHost): MarkdownTransformer[] {
	return [itemTitleTransformer, host.mermaidMarkdownTransformer];
}

export function clearEditor(host: DisplayHost): void {
	host.editor.setText("");
	host.ui.requestRender();
}

/**
 * Transcript notices: one `<glyph> <tone> <sentence>` line. The glyph says the state in its colour (`STATE_COLOR`;
 * `warning` is the risk colour); the sea mark beside it says the tone (`TONE`).
 */
type NoticeKind = "info" | "success" | "warning" | "error";

const NOTICE_MARK: Record<NoticeKind, { label: string; color: ThemeColor }> = {
	info: { label: "System ·", color: "accent" },
	success: { label: `${GLYPH.done} ${TONE.calm}`, color: STATE_COLOR.done },
	warning: { label: `${GLYPH.warning} ${TONE.caution}`, color: "warning" },
	error: { label: `${GLYPH.failed} ${TONE.problem}`, color: STATE_COLOR.failed },
};

/** Notices (like `/status` or `/usage`) stay readable up to 60 lines before folding. */
const NOTICE_FOLD_THRESHOLD = 60;

/** A notice at the transcript's left pad, with a textual or symbolic label that remains visible without color. */
export function noticeLine(kind: NoticeKind, message: string, pad: number, expanded = false): LongResponse {
	const { label: glyph, color } = NOTICE_MARK[kind];
	// Messages often carry tool or provider output (gh stderr, feature errors); none of it may drive the terminal.
	const text = sanitizeTerminalText(message);
	// An error must stand out whole; elsewhere the mark carries the state, so a long warning is no wall of amber.
	const paint = () =>
		kind === "error" ? theme.fg(color, `${glyph} ${text}`) : `${theme.fg(color, glyph)} ${theme.fg("text", text)}`;
	// A wrapped line keeps the indent of the line it continues: a report's indented rows (`/usage`, `/status`) stay
	// readable at any width, and a marked first line hangs under its text.
	const body = new ThemedText(paint, pad, 0);
	body.setHangingIndent(true);
	return new LongResponse(body, expanded, undefined, false, undefined, NOTICE_FOLD_THRESHOLD);
}

/**
 * Warnings, errors and cancellations shown per host: a command that showed one did not do what was asked
 * (`problemsShown`).
 */
const problems = new WeakMap<object, number>();

/** How many warnings, errors and cancellations `host` has shown; a command compares it before and after it runs. */
export function problemsShown(host: object): number {
	return problems.get(host) ?? 0;
}

/** Counts a notice that says the command did not do its job; warnings and errors count themselves. */
export const countProblem = (host: object) => void problems.set(host, problemsShown(host) + 1);

export function showError(host: DisplayHost, errorMessage: string): void {
	countProblem(host);
	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(noticeLine("error", errorMessage, host.uiStore.getState().view.outputPad));
	host.ui.requestRender();
}

export function showWarning(host: DisplayHost, warningMessage: string): void {
	countProblem(host);
	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(noticeLine("warning", warningMessage, host.uiStore.getState().view.outputPad));
	host.ui.requestRender();
}
