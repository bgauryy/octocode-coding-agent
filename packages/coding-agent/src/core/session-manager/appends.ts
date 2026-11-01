import type { ImageContent, Message, TextContent, Usage } from "@octocodeai/octocode-ai";
import type { BashExecutionMessage, CustomMessage } from "../messages.ts";
import { buildSessionProjection } from "./context.ts";
import { generateId } from "./entries.ts";
import { appendEntry } from "./persistence.ts";
import { getCompactionSystemFields } from "./system-base.ts";
import { getBranchEntries, getSessionEntries, type SessionState } from "./state.ts";
import { normalizeContextEditReplacement } from "./tree.ts";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	ContextEditEntry,
	CustomEntry,
	CustomMessageEntry,
	LabelEntry,
	ModelChangeEntry,
	SessionInfoEntry,
	SessionMessageEntry,
	SessionNameSource,
	ThinkingLevelChangeEntry,
	UsageEntry,
} from "./types.ts";

// Entry builders behind SessionManager's append methods. Each creates a child of the current leaf and advances it.

export function appendMessage(state: SessionState, message: Message | CustomMessage | BashExecutionMessage): string {
	const entry: SessionMessageEntry = {
		type: "message",
		id: generateId(state.byId),
		parentId: state.leafId,
		timestamp: new Date().toISOString(),
		message,
	};
	appendEntry(state, entry);
	return entry.id;
}

export function appendThinkingLevelChange(state: SessionState, thinkingLevel: string): string {
	const entry: ThinkingLevelChangeEntry = {
		type: "thinking_level_change",
		id: generateId(state.byId),
		parentId: state.leafId,
		timestamp: new Date().toISOString(),
		thinkingLevel,
	};
	appendEntry(state, entry);
	return entry.id;
}

export function appendModelChange(state: SessionState, provider: string, modelId: string): string {
	const entry: ModelChangeEntry = {
		type: "model_change",
		id: generateId(state.byId),
		parentId: state.leafId,
		timestamp: new Date().toISOString(),
		provider,
		modelId,
	};
	appendEntry(state, entry);
	return entry.id;
}

export function appendUsage(
	state: SessionState,
	kind: string,
	provider: string,
	model: string,
	usage: Usage,
	note?: string,
	cacheRequestedAt?: number,
): UsageEntry {
	const entry: UsageEntry = {
		type: "usage",
		id: generateId(state.byId),
		parentId: state.leafId,
		timestamp: new Date().toISOString(),
		kind,
		...(kind === "cache_warm" && cacheRequestedAt !== undefined && Number.isFinite(cacheRequestedAt)
			? { cacheRequestedAt: new Date(cacheRequestedAt).toISOString() }
			: {}),
		provider,
		model,
		usage,
		...(note ? { note } : {}),
	};
	appendEntry(state, entry);
	return entry;
}

export function appendCompaction<T = unknown>(
	state: SessionState,
	summary: string,
	firstKeptEntryId: string | null,
	tokensBefore: number,
	details?: T,
	fromHook?: boolean,
	usage?: Usage,
): string {
	const timestamp = new Date().toISOString();
	const system = getCompactionSystemFields(
		buildSessionProjection(getSessionEntries(state), state.leafId, state.byId).messages,
		new Date(timestamp).getTime(),
	);
	const id = generateId(state.byId);
	const entry: CompactionEntry<T> = {
		type: "compaction",
		id,
		parentId: state.leafId,
		timestamp,
		summary,
		firstKeptEntryId: firstKeptEntryId ?? id,
		tokensBefore,
		details,
		usage,
		fromHook,
		...system,
	};
	appendEntry(state, entry);
	return entry.id;
}

export function appendCustomEntry(state: SessionState, customType: string, data?: unknown): string {
	const entry: CustomEntry = {
		type: "custom",
		customType,
		data,
		id: generateId(state.byId),
		parentId: state.leafId,
		timestamp: new Date().toISOString(),
	};
	appendEntry(state, entry);
	return entry.id;
}

export function appendSessionInfo(state: SessionState, name: string, source: SessionNameSource = "user"): string {
	const sanitizedName = name.replace(/[\r\n]+/g, " ").trim();
	const entry: SessionInfoEntry = {
		type: "session_info",
		id: generateId(state.byId),
		parentId: state.leafId,
		timestamp: new Date().toISOString(),
		name: sanitizedName,
		...(source === "user" ? {} : { source }),
	};
	appendEntry(state, entry);
	return entry.id;
}

export function appendCustomMessageEntry<T = unknown>(
	state: SessionState,
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details?: T,
	timestamp?: number,
): string {
	const entry: CustomMessageEntry<T> = {
		type: "custom_message",
		customType,
		content,
		display,
		details,
		id: generateId(state.byId),
		parentId: state.leafId,
		timestamp: entryTimestamp(timestamp),
	};
	appendEntry(state, entry);
	return entry.id;
}

/** The entry time for a message created at `createdAt`; now when it is absent or not a valid time. */
function entryTimestamp(createdAt: number | undefined): string {
	const at = new Date(createdAt ?? Date.now());
	return (Number.isNaN(at.getTime()) ? new Date() : at).toISOString();
}

export function appendContextEdit(
	state: SessionState,
	targetId: string,
	replacement: ContextEditEntry["replacement"],
): string {
	const normalizedReplacement = normalizeContextEditReplacement(targetId, replacement, state.byId, () =>
		getBranchEntries(state),
	);
	const entry: ContextEditEntry = {
		type: "context_edit",
		id: generateId(state.byId),
		parentId: state.leafId,
		timestamp: new Date().toISOString(),
		targetId,
		replacement: normalizedReplacement,
	};
	appendEntry(state, entry);
	return entry.id;
}

export function appendLabelChange(state: SessionState, targetId: string, label: string | undefined): string {
	if (!state.byId.has(targetId)) {
		throw new Error(`Entry ${targetId} not found`);
	}
	const entry: LabelEntry = {
		type: "label",
		id: generateId(state.byId),
		parentId: state.leafId,
		timestamp: new Date().toISOString(),
		targetId,
		label,
	};
	appendEntry(state, entry);
	if (label) {
		state.labelsById.set(targetId, label);
		state.labelTimestampsById.set(targetId, entry.timestamp);
	} else {
		state.labelsById.delete(targetId);
		state.labelTimestampsById.delete(targetId);
	}
	return entry.id;
}

export function branchWithSummary(
	state: SessionState,
	branchFromId: string | null,
	summary: string,
	details?: unknown,
	fromHook?: boolean,
	usage?: Usage,
): string {
	if (branchFromId !== null && !state.byId.has(branchFromId)) {
		throw new Error(`Entry ${branchFromId} not found`);
	}
	const fromId = state.leafId ?? "root";
	// The entry names its parent; appendEntry moves the leaf to it only once it is saved.
	const entry: BranchSummaryEntry = {
		type: "branch_summary",
		id: generateId(state.byId),
		parentId: branchFromId,
		timestamp: new Date().toISOString(),
		fromId,
		summary,
		details,
		usage,
		fromHook,
	};
	appendEntry(state, entry);
	return entry.id;
}
