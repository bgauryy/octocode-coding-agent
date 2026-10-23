/**
 * The working, retry and compaction status indicators above the editor or embedded in it, the hidden-thinking
 * label, extension footer status, and the transient status lines in the chat.
 */

import { Spacer } from "@octocodeai/octocode-tui";
import type { WorkingIndicatorOptions } from "../../../core/extensions/index.ts";
import type { ToolStatus } from "../../../utils/tools-manager.ts";
import { AssistantMessageComponent } from "../components/assistant-message.ts";
import { type StatusIndicator, WorkingStatusIndicator } from "../components/status-indicator.ts";
import { ThemedText } from "../components/themed-text.ts";
import { theme } from "../theme/theme.ts";
import { isEmbeddedStatus } from "./helpers.ts";
import type { InteractiveModeHost } from "./host.ts";

/** Interactive-mode members used by the status indicators. */
export type StatusIndicatorsHost = Pick<
	InteractiveModeHost,
	| "activeStatusIndicator"
	| "activeWorkingIndicatorEmbedded"
	| "chatContainer"
	| "clearStatusIndicator"
	| "defaultEditor"
	| "defaultHiddenThinkingLabel"
	| "defaultWorkingMessage"
	| "editor"
	| "footerDataProvider"
	| "hiddenThinkingLabel"
	| "idleStatus"
	| "lastStatusMessage"
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
	| "workingVisible"
>;

/**
 * Set extension status text in the footer.
 */
export function setExtensionStatus(host: StatusIndicatorsHost, key: string, text: string | undefined): void {
	host.footerDataProvider.setExtensionStatus(key, text);
	host.ui.requestRender();
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

export function setWorkingVisible(host: StatusIndicatorsHost, visible: boolean): void {
	host.workingVisible = visible;
	if (!visible) {
		host.clearStatusIndicator("working");
		host.ui.requestRender();
		return;
	}
	if (host.session.isStreaming && host.activeStatusIndicator?.kind !== "working") {
		host.showWorkingStatusIndicator();
	}
	host.ui.requestRender();
}

export function setWorkingIndicator(host: StatusIndicatorsHost, options?: WorkingIndicatorOptions): void {
	host.workingIndicatorOptions = options;
	if (host.activeStatusIndicator?.kind === "working") {
		host.activeStatusIndicator.setIndicator(options);
	}
	host.ui.requestRender();
}

export function setHiddenThinkingLabel(host: StatusIndicatorsHost, label?: string): void {
	host.hiddenThinkingLabel = label ?? host.defaultHiddenThinkingLabel;
	for (const child of host.chatContainer.children) {
		if (child instanceof AssistantMessageComponent) {
			child.setHiddenThinkingLabel(host.hiddenThinkingLabel);
		}
	}
	if (host.streamingComponent) {
		host.streamingComponent.setHiddenThinkingLabel(host.hiddenThinkingLabel);
	}
	host.ui.requestRender();
}

/** Show a managed-tool status update in the chat. */
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

/**
 * Show a status message in the chat.
 *
 * If multiple status messages are emitted back-to-back (without anything else being added to the chat),
 * we update the previous status line instead of appending new ones to avoid log spam.
 */
export function showStatus(host: StatusIndicatorsHost, message: string): void {
	const children = host.chatContainer.children;
	const last = children.length > 0 ? children[children.length - 1] : undefined;
	const secondLast = children.length > 1 ? children[children.length - 2] : undefined;

	if (last && secondLast && last === host.lastStatusText && secondLast === host.lastStatusSpacer) {
		host.lastStatusMessage = message;
		host.lastStatusText.invalidate();
		host.ui.requestRender();
		return;
	}

	const spacer = new Spacer(1);
	host.lastStatusMessage = message;
	const text = new ThemedText(() => theme.fg("dim", host.lastStatusMessage), 1, 0);
	host.chatContainer.addChild(spacer);
	host.chatContainer.addChild(text);
	host.lastStatusSpacer = spacer;
	host.lastStatusText = text;
	host.ui.requestRender();
}
