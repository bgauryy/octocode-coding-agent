/**
 * Renders a session into the chat: messages, tool results, usage and cache notices, the thinking-drop notice and the
 * project-trust warning.
 */

import type { AssistantMessage } from "@octocodeai/octocode-ai/compat";
import { Spacer, TuiAltScreen } from "@octocodeai/octocode-tui";
import { CONFIG_DIR_NAME } from "../../../config.ts";
import { CACHE_TTL_MS, type CacheMiss, collectCacheMisses, detectCacheMiss } from "../../../core/cache-stats.ts";
import { formatCacheWarmingUsage } from "../../../core/cache-warmer.ts";
import { type SessionEntry, sessionEntryToContextMessages, type UsageEntry } from "../../../core/session-manager.ts";
import { hasTrustRequiringProjectResources } from "../../../core/trust-manager.ts";
import { formatTokens } from "../components/footer.ts";
import { ThemedText } from "../components/themed-text.ts";
import { ToolExecutionComponent } from "../components/tool-execution.ts";
import { theme } from "../theme/theme.ts";
import { isCustomSessionEntry, isCompactionCostNotice, isUsageSessionEntry } from "./helpers.ts";
import type { CompactionCostNotice, RenderSessionItem } from "./types.ts";
import type { InteractiveModeHost } from "./host.ts";

/** Interactive-mode members used by session rendering. */
export type SessionRenderHost = Pick<
	InteractiveModeHost,
	| "addCacheWarmingUsage"
	| "addCompactionCostNotice"
	| "addCustomEntryToChat"
	| "addMessageToChat"
	| "chatContainer"
	| "footer"
	| "getRegisteredToolDefinition"
	| "outputPad"
	| "pendingTools"
	| "renderSessionEntries"
	| "renderSessionItems"
	| "renderer"
	| "session"
	| "sessionManager"
	| "settingsManager"
	| "showStatus"
	| "toolOutputExpanded"
	| "ui"
	| "updateEditorBorderColor"
>;

/** Interactive-mode members needed to show a tool call. */
type ToolExecutionHost = Pick<
	InteractiveModeHost,
	| "chatContainer"
	| "getRegisteredToolDefinition"
	| "outputPad"
	| "sessionManager"
	| "settingsManager"
	| "toolOutputExpanded"
	| "ui"
>;

/** Adds a tool call component to the chat, expanded to match the current tool-output setting. */
export function addToolExecution(
	host: ToolExecutionHost,
	toolName: string,
	toolCallId: string,
	args: unknown,
): ToolExecutionComponent {
	const component = new ToolExecutionComponent(
		toolName,
		toolCallId,
		args,
		{
			showImages: host.settingsManager.getShowImages(),
			imageWidthCells: host.settingsManager.getImageWidthCells(),
			outputPad: host.outputPad,
		},
		host.getRegisteredToolDefinition(toolName),
		host.ui,
		host.sessionManager.getCwd(),
	);
	component.setExpanded(host.toolOutputExpanded);
	host.chatContainer.addChild(component);
	return component;
}

export function renderSessionItems(
	host: SessionRenderHost,
	items: readonly RenderSessionItem[],
	options: { updateFooter?: boolean; populateHistory?: boolean } = {},
): void {
	host.pendingTools.clear();
	const renderedPendingTools = new Map<string, ToolExecutionComponent>();
	// Cache misses are not persisted, unlike successful cache-warming usage.
	// Re-derive them and inject them after the assistant messages that paid for them.
	const cacheMisses = host.settingsManager.getShowCacheMissNotices()
		? collectCacheMisses(host.sessionManager.getEntries(), host.session.modelRuntime)
		: new Map<AssistantMessage, CacheMiss>();

	if (options.updateFooter) {
		host.footer.invalidate();
		host.updateEditorBorderColor();
	}

	for (const item of items) {
		if (isCustomSessionEntry(item)) {
			host.addCustomEntryToChat(item);
			continue;
		}
		if (isUsageSessionEntry(item)) {
			host.addCacheWarmingUsage(item);
			continue;
		}
		if (isCompactionCostNotice(item)) {
			host.addCompactionCostNotice(item);
			continue;
		}

		const message = item;
		// Assistant messages need special handling for tool calls
		if (message.role === "assistant") {
			host.addMessageToChat(message);
			// Render tool call components
			for (const content of message.content) {
				if (content.type === "toolCall") {
					const component = addToolExecution(host, content.name, content.id, content.arguments);

					if (message.stopReason === "aborted" || message.stopReason === "error") {
						let errorMessage: string;
						if (message.stopReason === "aborted") {
							const retryAttempt = host.session.retryAttempt;
							errorMessage =
								retryAttempt > 0
									? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
									: "Operation aborted";
						} else {
							errorMessage = message.errorMessage || "Error";
						}
						component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
					} else {
						renderedPendingTools.set(content.id, component);
					}
				}
			}
			if (message.stopReason !== "aborted" && message.stopReason !== "error") {
				const miss = cacheMisses.get(message);
				if (miss) addCacheMissNotice(host, miss);
			}
		} else if (message.role === "toolResult") {
			// Match tool results to pending tool components
			const component = renderedPendingTools.get(message.toolCallId);
			if (component) {
				component.updateResult(message);
				renderedPendingTools.delete(message.toolCallId);
			}
		} else {
			// All other messages use standard rendering
			host.addMessageToChat(message, options);
		}
	}

	for (const [toolCallId, component] of renderedPendingTools) {
		host.pendingTools.set(toolCallId, component);
	}
	host.ui.requestRender();
}

/**
 * Render session entries to chat. Used for initial load and rebuild after compaction.
 * @param entries Compaction-aware session entries to render
 * @param options.updateFooter Update footer state
 * @param options.populateHistory Add user messages to editor history
 */
export function renderSessionEntries(
	host: SessionRenderHost,
	entries: SessionEntry[],
	options: { updateFooter?: boolean; populateHistory?: boolean } = {},
): void {
	// Selection coordinates point into the transcript being replaced (#9311).
	if (host.renderer instanceof TuiAltScreen) host.renderer.resetTextSelection();
	const items = entries.flatMap((entry): RenderSessionItem[] => {
		if (entry.type === "custom" || (entry.type === "usage" && entry.kind === "cache_warm")) {
			return [entry];
		}
		const messages = sessionEntryToContextMessages(entry);
		if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage && messages.length > 0) {
			return [...messages, { type: "compaction_cost", kind: entry.type, usage: entry.usage }];
		}
		return messages;
	});
	host.renderSessionItems(items, options);
}

export function addCacheWarmingUsage(host: SessionRenderHost, entry: UsageEntry): void {
	if (!host.settingsManager.getShowCacheMissNotices()) return;
	host.chatContainer.addChild(new Spacer(1));
	const usage = formatCacheWarmingUsage(entry);
	host.chatContainer.addChild(new ThemedText(() => theme.fg("dim", usage), 1, 0));
}

/**
 * Render billing usage for a compaction or branch summary. The notice is derived
 * from persisted summary usage and is not stored as a separate session entry.
 */
export function addCompactionCostNotice(host: SessionRenderHost, notice: CompactionCostNotice): void {
	if (!host.settingsManager.getShowCacheMissNotices()) return;

	const { usage } = notice;
	const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	const cost = usage.cost.total >= 0.01 ? ` (~$${usage.cost.total.toFixed(2)})` : "";
	const label = notice.kind === "compaction" ? "Compaction" : "Branch summary";
	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(
		new ThemedText(() => theme.fg("warning", `${label}: ${formatTokens(tokens)} tokens billed${cost}`), 1, 0),
	);
}

export function countDroppedThinkingBlocks(message: AssistantMessage): number {
	let count = 0;
	for (const diagnostic of message.diagnostics ?? []) {
		if (diagnostic.type !== "anthropic_input_transformations") continue;
		const transformations = diagnostic.details?.transformations;
		if (!Array.isArray(transformations)) continue;
		count += transformations.filter(
			(transformation) =>
				typeof transformation === "object" &&
				transformation !== null &&
				(transformation as Record<string, unknown>).type === "thinking_dropped",
		).length;
	}
	return count;
}

export function maybeShowThinkingDropNotice(host: SessionRenderHost, message: AssistantMessage): void {
	if (!host.settingsManager.getShowCacheMissNotices()) return;

	const droppedCount = countDroppedThinkingBlocks(message);
	if (droppedCount === 0) return;

	let previousDroppedCount = 0;
	// message_end reaches the UI before the current message is persisted,
	// so the branch's last assistant message is the previous response.
	const branch = host.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message" && entry.message.role === "assistant") {
			previousDroppedCount = countDroppedThinkingBlocks(entry.message);
			break;
		}
	}
	if (droppedCount <= previousDroppedCount) return;

	const noun = droppedCount === 1 ? "thinking block" : "thinking blocks";
	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(
		new ThemedText(() => theme.fg("warning", `Anthropic dropped ${droppedCount} ${noun} (details in session)`), 1, 0),
	);
}

/**
 * Show a transcript notice when a completed assistant message paid for a
 * significant cache miss. Only states observable facts: the miss itself,
 * a model switch, or an idle gap past the cache TTL.
 */
export function maybeShowCacheMissNotice(host: SessionRenderHost, message: AssistantMessage): void {
	if (!host.settingsManager.getShowCacheMissNotices()) return;

	// Entries don't contain `message` yet: message_end fires before persistence.
	const miss = detectCacheMiss(host.sessionManager.getEntries(), message, host.session.modelRuntime);
	if (miss) addCacheMissNotice(host, miss);
}

export function addCacheMissNotice(host: SessionRenderHost, miss: CacheMiss): void {
	if (miss.missedTokens < 20_000 && miss.missedCost < 0.1) return;

	const cost = miss.missedCost >= 0.01 ? ` (~$${miss.missedCost.toFixed(2)})` : "";
	const reBilled = `${formatTokens(miss.missedTokens)} tokens re-billed${cost}`;
	let label = "Cache miss";
	if (miss.modelChanged) {
		label = "Cache miss after model switch";
	} else if (miss.idleMs >= CACHE_TTL_MS) {
		label = `Cache miss after ${Math.round(miss.idleMs / 60_000)}m idle`;
	}
	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(new ThemedText(() => theme.fg("warning", `${label}: ${reBilled}`), 1, 0));
}

export function renderInitialMessages(host: SessionRenderHost): void {
	const entries = host.sessionManager.buildContextEntries();
	host.renderSessionEntries(entries, {
		updateFooter: true,
		populateHistory: true,
	});
	renderProjectTrustWarningIfNeeded(host);

	// Show compaction info if session was compacted
	const allEntries = host.sessionManager.getEntries();
	const compactionCount = allEntries.filter((e) => e.type === "compaction").length;
	if (compactionCount > 0) {
		const times = compactionCount === 1 ? "1 time" : `${compactionCount} times`;
		host.showStatus(`Session compacted ${times}`);
	}
}

export function renderProjectTrustWarningIfNeeded(host: SessionRenderHost): void {
	if (host.settingsManager.isProjectTrusted() || !hasTrustRequiringProjectResources(host.sessionManager.getCwd())) {
		return;
	}

	if (host.chatContainer.children.length > 0) {
		host.chatContainer.addChild(new Spacer(1));
	}
	host.chatContainer.addChild(
		new ThemedText(
			() =>
				theme.fg(
					"warning",
					`This project is not trusted. Project ${CONFIG_DIR_NAME} resources and packages are ignored. Use /trust to save a trust decision, then restart octocode.`,
				),
			1,
			0,
		),
	);
}

export function rebuildChatFromMessages(host: SessionRenderHost): void {
	host.chatContainer.clear();
	host.renderSessionEntries(host.sessionManager.buildContextEntries());
}
