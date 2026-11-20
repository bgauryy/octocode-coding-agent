/**
 * The working, retry and compaction status indicators above the editor or embedded in it, the hidden-thinking
 * label, feature footer status, and the transient status lines in the chat.
 */

import { Spacer, ThemedText, hyperlink } from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";
import type { WorkingIndicatorOptions } from "../../../core/features/index.ts";
import type { StatusTone } from "../../../core/footer-data-provider.ts";
import type { ToolStatus } from "../../../utils/tools-manager.ts";
import { type StatusIndicator, WorkingStatusIndicator } from "../components/status-indicator.ts";
import { styleNotice } from "../../../theme/notice.ts";
import { theme } from "../../../theme/theme.ts";
import { isEmbeddedStatus } from "./helpers.ts";
import type { InteractiveModeHost } from "./host.ts";
import type { StatusLink, StatusText } from "./types.ts";

/** Interactive-mode members used by the status indicators. */
type StatusIndicatorsHost = Pick<
	InteractiveModeHost,
	| "activeStatusIndicator"
	| "activeWorkingIndicatorEmbedded"
	| "chatContainer"
	| "clearStatusIndicator"
	| "defaultEditor"
	| "defaultWorkingMessage"
	| "editor"
	| "footerDataProvider"
	| "idleStatus"
	| "lastStatusSpacer"
	| "lastStatusText"
	| "managedToolStatusStarted"
	| "options"
	| "session"
	| "setEditorWorkingStatusIndicator"
	| "showStatusIndicator"
	| "showWorkingStatusIndicator"
	| "statusContainer"
	| "streamingComponent"
	| "ui"
	| "workingIndicatorOptions"
	| "workingMessage"
>;

/** Set feature status text in the footer; the footer data subscription draws it when it changed. */
export function setFeatureStatus(
	host: StatusIndicatorsHost,
	key: string,
	text: string | undefined,
	tone?: StatusTone,
): void {
	host.footerDataProvider.setFeatureStatus(key, text, tone);
}

export function setEditorWorkingStatusIndicator(
	host: StatusIndicatorsHost,
	indicator: StatusIndicator | undefined,
): boolean {
	host.defaultEditor.setWorkingStatusIndicator(undefined);
	if (!isEmbeddedStatus(host.editor)) return false;
	host.editor.setWorkingStatusIndicator(indicator);
	return true;
}

export function showStatusIndicator(host: StatusIndicatorsHost, indicator: StatusIndicator): void {
	host.activeStatusIndicator?.dispose();
	host.activeStatusIndicator = indicator;
	host.activeWorkingIndicatorEmbedded = false;
	host.statusContainer.clear();
	host.setEditorWorkingStatusIndicator(undefined);
	if (host.setEditorWorkingStatusIndicator(indicator)) {
		host.activeWorkingIndicatorEmbedded = true;
		return;
	}
	host.statusContainer.addChild(indicator);
}

export function clearStatusIndicator(host: StatusIndicatorsHost, kind?: StatusIndicator["kind"]): void {
	if (kind && host.activeStatusIndicator?.kind !== kind) {
		return;
	}
	const clearedIndicator = host.activeStatusIndicator;
	const clearedIndicatorWasEmbedded = host.activeWorkingIndicatorEmbedded;
	clearedIndicator?.dispose();
	host.activeStatusIndicator = undefined;
	host.activeWorkingIndicatorEmbedded = false;
	host.statusContainer.clear();
	host.setEditorWorkingStatusIndicator(undefined);
	if (
		clearedIndicator &&
		!clearedIndicatorWasEmbedded &&
		host.options.tuiMode === "regular" &&
		host.ui.getClearOnShrink()
	) {
		host.statusContainer.addChild(host.idleStatus);
	}
}

export function showWorkingStatusIndicator(host: StatusIndicatorsHost): void {
	const colorFn = isEmbeddedStatus(host.editor)
		? (text: string) =>
				(host.editor.borderColor ?? theme.getThinkingBorderColor(host.session.thinkingLevel || "off"))(text)
		: undefined;
	host.showStatusIndicator(
		new WorkingStatusIndicator(
			host.ui,
			host.workingMessage ?? host.defaultWorkingMessage,
			host.workingIndicatorOptions,
			colorFn,
		),
	);
}

export function setWorkingIndicator(host: StatusIndicatorsHost, options?: WorkingIndicatorOptions): void {
	host.workingIndicatorOptions = options;
	if (host.activeStatusIndicator?.kind === "working") {
		host.activeStatusIndicator.setIndicator(options);
	}
	host.ui.requestRender();
}

export function showManagedToolStatus(host: StatusIndicatorsHost, status: ToolStatus): void {
	if (!host.managedToolStatusStarted) {
		host.chatContainer.addChild(new Spacer(1));
		host.managedToolStatusStarted = true;
	}
	const message = status.type === "warning" ? `Warning: ${status.message}` : status.message;
	const color = status.type === "warning" ? "warning" : "dim";
	host.chatContainer.addChild(new ThemedText(() => theme.fg(color, message), 1, 0));
	host.lastStatusSpacer = undefined;
	host.lastStatusText = undefined;
	host.ui.requestRender();
}

/** The message each status line shows; the coalesced last line updates its entry in place. */
const statusLineMessages = new WeakMap<ThemedText, { message: string }>();

/** A link drawn as OSC 8 only when it is an http(s) URL without controls or spaces; otherwise its label as text. */
function statusLink(link: StatusLink): string {
	const label = sanitizeTerminalText(link.label ?? link.url);
	if (!/^https?:\/\/\S+$/u.test(link.url) || sanitizeTerminalText(link.url) !== link.url || !URL.canParse(link.url)) {
		return label;
	}
	return hyperlink(label, link.url);
}

/** Status text as drawn: callers' text never reaches the terminal as a control sequence; only validated links do. */
function formatStatusText(text: StatusText): string {
	if (typeof text === "string") return sanitizeTerminalText(text);
	return text.map((part) => (typeof part === "string" ? sanitizeTerminalText(part) : statusLink(part))).join("");
}

/**
 * Show a status message in the chat. Status text often carries tool or account data (gh output, user names), so plain
 * text is sanitized; a link goes in as a `StatusLink` part, never as a caller-built escape sequence.
 *
 * If multiple status messages are emitted back-to-back (without anything else being added to the chat),
 * we update the previous status line instead of appending new ones to avoid log spam.
 */
export function showStatus(host: StatusIndicatorsHost, status: StatusText): void {
	const message = formatStatusText(status);
	const children = host.chatContainer.children;
	const last = children.length > 0 ? children[children.length - 1] : undefined;
	const secondLast = children.length > 1 ? children[children.length - 2] : undefined;

	const lastLine = host.lastStatusText && statusLineMessages.get(host.lastStatusText);
	if (last && secondLast && last === host.lastStatusText && secondLast === host.lastStatusSpacer && lastLine) {
		lastLine.message = message;
		host.lastStatusText.invalidate();
		host.ui.requestRender();
		return;
	}

	const spacer = new Spacer(1);
	// Each line reads its own message, so a later status or an invalidation never rewrites an earlier line.
	const line = { message };
	const text = new ThemedText(() => styleNotice(line.message), 1, 0);
	statusLineMessages.set(text, line);
	host.chatContainer.addChild(spacer);
	host.chatContainer.addChild(text);
	host.lastStatusSpacer = spacer;
	host.lastStatusText = text;
	host.ui.requestRender();
}
