/**
 * Renders a session into the chat: messages, tool results, usage and cache notices and the thinking-drop notice.
 */

import type { AssistantMessage } from "@octocodeai/octocode-ai/compat";
import { Spacer, ThemedText, TuiAltScreen } from "@octocodeai/octocode-tui";
import { disposeTranscript } from "./transcript-dispose.ts";
import type { SessionRenderOptions } from "./session-render-options.ts";
import { retainLiveTools, renderWindowedEntries } from "./session-window.ts";
import {
	type CacheMiss,
	cacheMissLabel,
	cacheReadRatePerToken,
	collectCacheMisses,
	detectCacheMiss,
} from "../../../core/cache-stats.ts";
import { formatCacheWarmingUsage } from "../../../core/cache-warmer.ts";
import { getPromptCacheTtlMs } from "../../../core/cache-warmer/economics.ts";
import { type SessionEntry, sessionEntryToContextMessages, type UsageEntry } from "../../../core/session-manager.ts";
import { formatCost, formatTokens } from "../../../octocode/shared/format.ts";
import { ToolExecutionComponent } from "../components/tool-execution.ts";
import { AssistantMessageComponent } from "../components/assistant-message.ts";
import { getApplicationPort } from "../../../core/application/index.ts";
import { toolContent } from "../components/application-content.ts";
import { theme } from "../../../theme/theme.ts";
import { compactionUsage } from "./compaction-cost.ts";
import { noticeLine } from "./display.ts";
import { isCustomSessionEntry, isCompactionCostNotice, isUsageSessionEntry } from "./helpers.ts";
import { stoppedToolText } from "../../../core/application/interrupted-tools.ts";
import type { CompactionCostNotice, RenderSessionItem } from "./types.ts";
import type { InteractiveModeHost } from "./host.ts";

/** Interactive-mode members used by session rendering. */
type SessionRenderHost = Pick<
	InteractiveModeHost,
	| "addCacheWarmingUsage"
	| "addCompactionCostNotice"
	| "addCustomEntryToChat"
	| "addMessageToChat"
	| "chatContainer"
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
	| "streamingComponent"
	| "uiStore"
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
	| "uiStore"
	| "ui"
>;

/** Adds a tool call component to the chat, expanded to match the current tool-output setting. */
export function addToolExecution(
	host: ToolExecutionHost,
	toolName: string,
	toolCallId: string,
	args: unknown,
	parent?: AssistantMessageComponent,
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
	component.setExpanded(host.uiStore.getState().view.toolsExpanded);
	if (parent) parent.attachTool(toolCallId, component);
	else host.chatContainer.addChild(component);
	return component;
}

export function renderSessionItems(
	host: SessionRenderHost,
	items: readonly RenderSessionItem[],
	options: SessionRenderOptions = {},
): void {
	host.pendingTools.clear();
	const renderedPendingTools = options.toolState ?? new Map<string, ToolExecutionComponent>();
	// Cache misses are not persisted, unlike successful cache-warming usage.
	// Re-derive them and inject them after the assistant messages that paid for them. Only the current branch's requests
	// are compared: entries of other branches interleave in the file but were never part of this prefix.
	const cacheMisses = host.settingsManager.getShowCacheMissNotices()
		? collectCacheMisses(host.sessionManager.getBranch(), host.session.modelRuntime)
		: new Map<AssistantMessage, CacheMiss>();

	if (options.updateFooter) {
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
			const last = host.chatContainer.children.at(-1);
			const parent = last instanceof AssistantMessageComponent ? last : undefined;
			for (const content of message.content) {
				if (content.type === "toolCall") {
					const retained = options.liveTools?.get(content.id);
					const component = retained ?? addToolExecution(host, content.name, content.id, content.arguments, parent);
					if (retained) {
						if (parent) parent.attachTool(content.id, retained);
						else host.chatContainer.addChild(retained);
					}

					const toolText = stoppedToolText(message.stopReason, host.session.retryAttempt);
					if (toolText !== undefined) {
						component.updateResult({ content: [{ type: "text", text: toolText }], isError: true });
					} else {
						renderedPendingTools.set(content.id, component);
					}
				}
			}
			if (message.stopReason !== "aborted" && message.stopReason !== "error") {
				const miss = cacheMisses.get(message);
				if (miss) addCacheMissNotice(host, miss, message);
			}
		} else if (message.role === "toolResult") {
			const component = renderedPendingTools.get(message.toolCallId);
			if (component) {
				const port = getApplicationPort(host.session);
				const normalized = port.normalizeMessage(message);
				component.updateResult({
					...message,
					content: toolContent(normalized.content ?? [], (id) => port.readAsset(id)),
				});
				renderedPendingTools.delete(message.toolCallId);
			}
		} else {
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
	options: SessionRenderOptions = {},
): void {
	// Selection coordinates point into the transcript being replaced.
	if (host.renderer instanceof TuiAltScreen) host.renderer.resetTextSelection();
	const items = entries.flatMap((entry): RenderSessionItem[] => {
		if (entry.type === "custom" || (entry.type === "usage" && entry.kind === "cache_warm")) {
			return [entry];
		}
		const messages = sessionEntryToContextMessages(entry);
		if ((entry.type === "compaction" || entry.type === "branch_summary") && messages.length > 0) {
			const usage = compactionUsage(entry, (id) => host.sessionManager.getEntry(id));
			if (usage) return [...messages, { type: "compaction_cost", kind: entry.type, usage }];
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
	const cost = usage.cost.total >= 0.01 ? ` (${formatCost({ cost: usage.cost.total, unpriced: false })})` : "";
	const label = notice.kind === "compaction" ? "Compaction" : "Branch summary";
	// A summary that shared the session's prompt cache read its prefix from it; a standalone summary reads nothing.
	const cached = usage.cacheRead > 0 ? `, ${formatTokens(usage.cacheRead)} read from cache` : "";
	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(
		noticeLine("warning", `${label}: ${formatTokens(tokens)} tokens billed${cached}${cost}`, host.outputPad),
	);
}

function countDroppedThinkingBlocks(message: AssistantMessage): number {
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
		noticeLine("warning", `Anthropic dropped ${droppedCount} ${noun} (details in session)`, host.outputPad),
	);
}

/**
 * Show a transcript notice when a completed assistant message paid for a
 * significant cache miss. Only states observable facts: the miss itself,
 * a model switch, or an idle gap past the cache TTL.
 */
export function maybeShowCacheMissNotice(host: SessionRenderHost, message: AssistantMessage): void {
	if (!host.settingsManager.getShowCacheMissNotices()) return;

	// The branch doesn't contain `message` yet: message_end fires before persistence.
	const miss = detectCacheMiss(host.sessionManager.getBranch(), message, host.session.modelRuntime);
	if (miss) addCacheMissNotice(host, miss, message);
}

/** Lifetime of the history entry the message's model writes under the cache settings now in effect, when known. */
function historyTtlMs(host: SessionRenderHost, message: AssistantMessage): number | undefined {
	const runtime = host.session.modelRuntime;
	const model = runtime.getModel(message.provider, message.model);
	if (!model) return undefined;
	const policy = runtime.getCachePolicy(model, undefined, host.settingsManager.getCachePreferenceLayers());
	return getPromptCacheTtlMs(model, policy.options);
}

function addCacheMissNotice(host: SessionRenderHost, miss: CacheMiss, message: AssistantMessage): void {
	if (miss.missedTokens < 20_000 && miss.missedCost < 0.1) return;

	const cost = miss.missedCost >= 0.01 ? ` (${formatCost({ cost: miss.missedCost, unpriced: false })})` : "";
	const reBilled = `${formatTokens(miss.missedTokens)} tokens re-billed${cost}`;
	const ttlMs = historyTtlMs(host, message);
	const label = cacheMissLabel(miss, ttlMs);
	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(
		noticeLine("warning", `${label}: ${reBilled}${idleWarmingHint(host, miss, message, ttlMs)}`, host.outputPad),
	);
}

/**
 * For a miss the idle gap alone explains, while idle warming is off: what one refresh would have cost, a read of the
 * previous prompt, so the warning names the setting that prevents it.
 */
export function idleWarmingHint(
	host: SessionRenderHost,
	miss: CacheMiss,
	message: AssistantMessage,
	ttlMs: number | undefined,
): string {
	if (host.settingsManager.getCacheWarmingMode() === "idle") return "";
	if (miss.apiReason || miss.modelChanged || miss.promptChanged || ttlMs === undefined || miss.idleMs < ttlMs)
		return "";
	const usage = message.usage;
	const readPerToken =
		usage.cacheRead > 0
			? usage.cost.cacheRead / usage.cacheRead
			: cacheReadRatePerToken(host.session.modelRuntime, message);
	const refresh = (usage.cacheRead + miss.missedTokens) * readPerToken;
	if (refresh <= 0) return ' · cacheWarming "idle" keeps it warm';
	return ` · cacheWarming "idle" would have kept it for ${formatCost({ cost: refresh, unpriced: false })}`;
}

export function renderInitialMessages(host: SessionRenderHost): void {
	const entries = host.sessionManager.buildContextEntries();
	renderWindowedEntries(host, entries, {
		updateFooter: true,
		populateHistory: true,
	});

	const allEntries = host.sessionManager.getEntries();
	const compactionCount = allEntries.filter((e) => e.type === "compaction").length;
	if (compactionCount > 0) {
		const times = compactionCount === 1 ? "1 time" : `${compactionCount} times`;
		host.showStatus(`Session compacted ${times}`);
	}
}

export function rebuildChatFromMessages(host: SessionRenderHost): void {
	// The reply being streamed is not saved yet, so the rebuild cannot redraw it: keep it, and its tool rows, below.
	const entries = host.sessionManager.buildContextEntries();
	const retained = retainLiveTools(entries, host.pendingTools);
	const live = host.streamingComponent;
	const liveTools = live ? [...host.pendingTools] : [];
	// The live reply and its tool rows are re-added below, so they stay subscribed.
	disposeTranscript(host.chatContainer, [
		...retained.values(),
		...(live ? [live, ...liveTools.map(([, component]) => component)] : []),
	]);
	host.chatContainer.clear();
	renderWindowedEntries(host, entries, { liveTools: retained });
	if (!live) return;
	host.chatContainer.addChild(live);
	for (const [toolCallId, component] of liveTools) {
		if (!host.pendingTools.has(toolCallId)) host.pendingTools.set(toolCallId, component);
	}
}
