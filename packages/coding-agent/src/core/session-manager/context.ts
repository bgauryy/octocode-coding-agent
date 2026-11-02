import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import { createBranchSummaryMessage, createCompactionSummaryMessage, createCustomMessage } from "../messages.ts";
import { pathFromRoot } from "./ancestors.ts";
import type {
	CompactionEntry,
	ContextEditEntry,
	ProjectedSessionEntry,
	SessionContext,
	SessionEntry,
	SessionProjection,
} from "./types.ts";
import { getCompactionSystemFields, getSystemBaseDelta } from "./system-base.ts";

export function getLatestCompactionEntry(entries: SessionEntry[]): CompactionEntry | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") {
			return entries[i] as CompactionEntry;
		}
	}
	return null;
}

function buildEntryIndex(entries: SessionEntry[], byId?: Map<string, SessionEntry>): Map<string, SessionEntry> {
	if (byId) return byId;
	const index = new Map<string, SessionEntry>();
	for (const entry of entries) {
		index.set(entry.id, entry);
	}
	return index;
}

function buildSessionPath(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionEntry[] {
	const index = buildEntryIndex(entries, byId);
	let leaf: SessionEntry | undefined;
	if (leafId === null) {
		return [];
	}
	if (leafId) {
		leaf = index.get(leafId);
	}
	leaf ??= entries[entries.length - 1];
	return pathFromRoot(leaf, (id) => index.get(id));
}

function getSessionContextSettings(path: SessionEntry[]): Pick<SessionContext, "thinkingLevel" | "model"> {
	let thinkingLevel = "off";
	let model: { provider: string; modelId: string } | null = null;

	for (const entry of path) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel;
		} else if (entry.type === "model_change") {
			model = { provider: entry.provider, modelId: entry.modelId };
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			model = { provider: entry.message.provider, modelId: entry.message.model };
		}
	}

	return { thinkingLevel, model };
}

/**
 * Project one selected session entry into LLM/runtime messages.
 * Plain custom entries are display/state entries and do not participate in context.
 */
export function sessionEntryToContextMessages(entry: SessionEntry): AgentMessage[] {
	if (entry.type === "message") {
		const message = entry.message;
		// Session files are parsed without validation; old versions, forks, or
		// hand-edited files can contain messages with null/missing content.
		if (message.role === "system" && message.content == null) return [{ ...message, content: "" }];
		if (
			(message.role === "user" || message.role === "assistant" || message.role === "toolResult") &&
			message.content == null
		) {
			return [{ ...message, content: [] }];
		}
		return [message];
	}
	if (entry.type === "custom_message") {
		return [createCustomMessage(entry.customType, entry.content ?? [], entry.display, entry.details, entry.timestamp)];
	}
	if (entry.type === "branch_summary" && entry.summary) {
		return [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)];
	}
	if (entry.type === "compaction") {
		const summary = createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);
		if (!entry.systemMessage) return [summary];
		const delta = entry.systemBase ? getSystemBaseDelta(entry.systemBase, entry.systemMessage) : null;
		if (!entry.systemBase || delta === null) return [entry.systemMessage, summary];
		return delta ? [entry.systemBase, summary, delta] : [entry.systemBase, summary];
	}
	return [];
}

/**
 * Build the active, compaction-aware session entry list.
 *
 * This follows the current leaf path. If the path contains compaction entries,
 * the latest compaction is represented by the compaction entry itself, followed
 * by the kept entries starting at firstKeptEntryId and all entries after the
 * compaction entry. Older summarized entries are omitted.
 */
export function buildContextEntries(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionEntry[] {
	const path = buildSessionPath(entries, leafId, byId);
	let compaction: CompactionEntry | null = null;

	for (const entry of path) {
		if (entry.type === "compaction") {
			compaction = entry;
		}
	}

	if (!compaction) {
		return path;
	}

	const compactionIdx = path.findIndex((entry) => entry.id === compaction.id);
	if (compactionIdx < 0) {
		return path;
	}

	const contextEntries: SessionEntry[] = [compaction];
	// Kept system messages replay in place when the compaction's state stops at the boundary; an older entry's state
	// already holds them.
	const keepSystem = compaction.systemFold === "summarized";
	let foundFirstKept = false;
	for (let i = 0; i < compactionIdx; i++) {
		const entry = path[i];
		if (entry.id === compaction.firstKeptEntryId) {
			foundFirstKept = true;
		}
		if (foundFirstKept && (keepSystem || !isSystemEntry(entry))) {
			contextEntries.push(entry);
		}
	}
	contextEntries.push(...path.slice(compactionIdx + 1));
	return contextEntries;
}

/**
 * Build the session context from entries using tree traversal.
 * If leafId is provided, walks from that entry to root.
 * Handles compaction and branch summaries along the path.
 */
function projectContextEntry(entry: SessionEntry, edit: ContextEditEntry | undefined): AgentMessage[] {
	const messages = sessionEntryToContextMessages(entry);
	if (!edit) return messages;
	const replacement = edit.replacement;
	if (replacement === null) return [];

	return messages.map((message) => {
		if (
			message.role !== "user" &&
			message.role !== "assistant" &&
			message.role !== "toolResult" &&
			message.role !== "custom"
		) {
			return message;
		}
		const content =
			(message.role === "assistant" || message.role === "toolResult") && typeof replacement.content === "string"
				? [{ type: "text" as const, text: replacement.content }]
				: replacement.content;
		return { ...message, content } as AgentMessage;
	});
}

/** Build provenance-preserving, compaction-aware model context. */
export function buildSessionProjection(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionProjection {
	const path = buildSessionPath(entries, leafId, byId);
	const { thinkingLevel, model } = getSessionContextSettings(path);
	const contextEntries = buildContextEntries(entries, leafId, byId);
	const edits = new Map<string, ContextEditEntry>();
	for (const entry of contextEntries) {
		if (entry.type === "context_edit") edits.set(entry.targetId, entry);
	}
	const projectedEntries = contextEntries.map((sourceEntry, index): ProjectedSessionEntry => ({
		sourceEntry,
		// buildContextEntries() may retain an older compaction entry because its
		// raw ID lies inside the newest retained range. Only the newest compaction
		// at index zero contributes a checkpoint and summary.
		messages:
			sourceEntry.type === "compaction" && index > 0 ? [] : projectContextEntry(sourceEntry, edits.get(sourceEntry.id)),
	}));
	return {
		entries: projectedEntries,
		messages: projectedEntries.flatMap((entry) => entry.messages),
		thinkingLevel,
		model,
	};
}

const isSystemEntry = (entry: SessionEntry) => entry.type === "message" && entry.message.role === "system";

/**
 * The prompt and tool state a compaction that keeps `firstKeptEntryId` stores: the state through the entries it
 * summarizes, so the kept system messages replay once, in place, after the summary (`systemFold`). Falls back to the
 * state through the whole branch, with the kept system messages left out, where that replay would differ from the
 * current context: the boundary is not in the context (nothing is kept), an older compaction left kept system messages
 * out, or no prompt precedes the boundary (the leading message must stay first).
 */
export function getCompactionBoundarySystem(
	entries: SessionEntry[],
	leafId: string | null | undefined,
	byId: Map<string, SessionEntry> | undefined,
	firstKeptEntryId: string,
	timestamp: number,
): Pick<CompactionEntry, "systemMessage" | "systemBase" | "systemFold"> {
	const projection = buildSessionProjection(entries, leafId, byId);
	const whole = () => getCompactionSystemFields(projection.messages, timestamp);
	const kept = projection.entries.findIndex((entry) => entry.sourceEntry.id === firstKeptEntryId);
	if (kept < 0) return whole();
	const path = buildSessionPath(entries, leafId, byId);
	const projected = new Set(projection.entries.slice(kept).map((entry) => entry.sourceEntry.id));
	const replayed = path.slice(path.findIndex((entry) => entry.id === firstKeptEntryId)).filter(isSystemEntry);
	if (replayed.some((entry) => !projected.has(entry.id))) return whole();
	const fields = getCompactionSystemFields(
		projection.entries.slice(0, kept).flatMap((entry) => entry.messages),
		timestamp,
	);
	return fields.systemMessage ? { ...fields, systemFold: "summarized" } : whole();
}

/** Build the finalized model context from the canonical session projection. */
export function buildSessionContext(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionContext {
	const { messages, thinkingLevel, model } = buildSessionProjection(entries, leafId, byId);
	return { messages, thinkingLevel, model };
}
