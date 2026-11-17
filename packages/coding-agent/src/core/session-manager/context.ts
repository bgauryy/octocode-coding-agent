import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import { createBranchSummaryMessage, createCompactionSummaryMessage, createCustomMessage } from "../messages.ts";
import { branchPath } from "./entry-index.ts";
import type {
	CompactionEntry,
	ContextEditEntry,
	ProjectedSessionEntry,
	ReadonlySessionProjection,
	SessionContext,
	SessionEntry,
	SessionProjection,
} from "./types.ts";
import { getCompactionSystemFields, getSystemBaseDelta } from "./system-base.ts";

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
	return branchPath(index, leaf);
}

/** Whether `entries` is already the root-first path that ends at its last entry: unique ids, each the parent of the next. */
function isLinearPath(entries: readonly SessionEntry[]): boolean {
	const ids = new Set<string>();
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (ids.has(entry.id) || (i > 0 && entry.parentId !== entries[i - 1].id)) return false;
		ids.add(entry.id);
	}
	return true;
}

/** The thinking level and model a path's entries set, the later entry winning. */
interface ContextSettings {
	thinkingLevel: string;
	model: { provider: string; modelId: string } | null;
}

function applyContextSettings(settings: ContextSettings, entry: SessionEntry): void {
	if (entry.type === "thinking_level_change") {
		settings.thinkingLevel = entry.thinkingLevel;
	} else if (entry.type === "model_change") {
		settings.model = { provider: entry.provider, modelId: entry.modelId };
	} else if (entry.type === "message" && entry.message.role === "assistant") {
		settings.model = { provider: entry.message.provider, modelId: entry.message.model };
	}
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

/** The context entries of a root-first path: everything, or from the latest compaction (see `buildContextEntries`). */
function contextEntriesOfPath(path: SessionEntry[]): SessionEntry[] {
	let compactionIdx = -1;
	for (let i = path.length - 1; i >= 0; i--) {
		if (path[i].type === "compaction") {
			compactionIdx = i;
			break;
		}
	}
	if (compactionIdx < 0) return path;
	const compaction = path[compactionIdx] as CompactionEntry;

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
	for (let i = compactionIdx + 1; i < path.length; i++) contextEntries.push(path[i]);
	return contextEntries;
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
	return contextEntriesOfPath(buildSessionPath(entries, leafId, byId));
}

/**
 * Build the session context from entries using tree traversal.
 * If leafId is provided, walks from that entry to root.
 * Handles compaction and branch summaries along the path.
 */
export function projectContextEntry(entry: SessionEntry, edit: ContextEditEntry | undefined): AgentMessage[] {
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

/**
 * A branch's projection kept as the parts later appends extend (`extendProjection`), so a session can keep the projection
 * of its leaf instead of rebuilding it from the whole branch for every read (`projection-memo.ts`).
 */
export interface ProjectionParts extends ContextSettings {
	/** What `buildContextEntries` returns for the branch. */
	contextEntries: SessionEntry[];
	/** One per context entry, in order. */
	projected: ProjectedSessionEntry[];
	/** Index in `contextEntries` by entry id. */
	positions: Map<string, number>;
	/** The latest context edit in the context by target id. */
	edits: Map<string, ContextEditEntry>;
	/** The projected messages in order; undefined after an edit changed an earlier entry, until `projectionOf` rebuilds them. */
	messages: AgentMessage[] | undefined;
}

// buildContextEntries() may retain an older compaction entry because its raw ID lies inside the newest retained range.
// Only the newest compaction at index zero contributes a checkpoint and summary.
const projectAt = (
	sourceEntry: SessionEntry,
	index: number,
	edit: ContextEditEntry | undefined,
): ProjectedSessionEntry => ({
	sourceEntry,
	messages: sourceEntry.type === "compaction" && index > 0 ? [] : projectContextEntry(sourceEntry, edit),
});

/** The projection parts of a root-first path. The parts own their arrays: `path` is copied when it is the context. */
export function projectionParts(path: SessionEntry[]): ProjectionParts {
	const settings: ContextSettings = { thinkingLevel: "off", model: null };
	for (const entry of path) applyContextSettings(settings, entry);
	const found = contextEntriesOfPath(path);
	const contextEntries = found === path ? path.slice() : found;
	const edits = new Map<string, ContextEditEntry>();
	const positions = new Map<string, number>();
	for (let i = 0; i < contextEntries.length; i++) {
		const entry = contextEntries[i];
		positions.set(entry.id, i);
		if (entry.type === "context_edit") edits.set(entry.targetId, entry);
	}
	const projected = contextEntries.map((entry, index) => projectAt(entry, index, edits.get(entry.id)));
	return {
		...settings,
		contextEntries,
		projected,
		positions,
		edits,
		messages: projected.flatMap((entry) => entry.messages),
	};
}

/**
 * Add entries appended after the branch's leaf, in order, each the child of the one before: the parts become those of the
 * longer branch. A compaction changes which entries the context holds: false, and nothing changes, for any compaction.
 */
export function extendProjection(parts: ProjectionParts, appended: readonly SessionEntry[]): boolean {
	if (appended.some((entry) => entry.type === "compaction")) return false;
	for (const entry of appended) {
		applyContextSettings(parts, entry);
		const index = parts.contextEntries.push(entry) - 1;
		parts.positions.set(entry.id, index);
		if (entry.type === "context_edit") {
			parts.edits.set(entry.targetId, entry);
			const target = parts.positions.get(entry.targetId);
			if (target !== undefined && target !== index) {
				parts.projected[target] = projectAt(parts.contextEntries[target], target, entry);
				parts.messages = undefined;
			}
		}
		const projected = projectAt(entry, index, parts.edits.get(entry.id));
		parts.projected.push(projected);
		parts.messages?.push(...projected.messages);
	}
	return true;
}

/**
 * The projection `extendProjection(parts, appended)` would describe, without changing `parts`: new entry and message
 * arrays, the parts' entry records and messages. The appended ids and edits are looked up before the parts' own, so the
 * parts' maps are not copied. Undefined, as there, for any compaction.
 */
export function extendedProjection(
	parts: ProjectionParts,
	appended: readonly SessionEntry[],
): ReadonlySessionProjection | undefined {
	if (appended.some((entry) => entry.type === "compaction")) return undefined;
	const settings: ContextSettings = { thinkingLevel: parts.thinkingLevel, model: parts.model };
	const base = parts.contextEntries.length;
	const projected = parts.projected.slice();
	const positions = new Map<string, number>();
	const edits = new Map<string, ContextEditEntry>();
	const editOf = (id: string) => edits.get(id) ?? parts.edits.get(id);
	let rebuilt = false;
	for (const [offset, entry] of appended.entries()) {
		applyContextSettings(settings, entry);
		const index = base + offset;
		positions.set(entry.id, index);
		if (entry.type === "context_edit") {
			edits.set(entry.targetId, entry);
			const target = positions.get(entry.targetId) ?? parts.positions.get(entry.targetId);
			if (target !== undefined && target !== index) {
				const source = target < base ? parts.contextEntries[target] : appended[target - base];
				projected[target] = projectAt(source, target, entry);
				rebuilt = true;
			}
		}
		projected.push(projectAt(entry, index, editOf(entry.id)));
	}
	parts.messages ??= parts.projected.flatMap((entry) => entry.messages);
	const messages = rebuilt
		? projected.flatMap((entry) => entry.messages)
		: parts.messages.concat(projected.slice(base).flatMap((entry) => entry.messages));
	return { entries: projected, messages, thinkingLevel: settings.thinkingLevel, model: settings.model };
}

/**
 * The projection the parts describe, in arrays and entry records of its own (`shared` parts stay unchanged whatever the
 * caller does with them). The messages themselves are the parts' own. Unshared, it holds the parts' arrays: later
 * appends to the parts change them.
 */
export function projectionOf(parts: ProjectionParts, shared: boolean): SessionProjection {
	parts.messages ??= parts.projected.flatMap((entry) => entry.messages);
	const messages = parts.messages;
	return {
		entries: shared
			? parts.projected.map((entry) => ({ sourceEntry: entry.sourceEntry, messages: entry.messages.slice() }))
			: parts.projected,
		messages: shared ? messages.slice() : messages,
		thinkingLevel: parts.thinkingLevel,
		model: shared && parts.model ? { ...parts.model } : parts.model,
	};
}

/** Build provenance-preserving, compaction-aware model context. */
export function buildSessionProjection(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionProjection {
	return projectionOf(projectionParts(buildSessionPath(entries, leafId, byId)), false);
}

/**
 * `buildSessionProjection` of a branch as `getBranch` returns it (root first, ending at the leaf), without indexing it:
 * compaction asks for several. Anything else is indexed and walked as `buildSessionProjection` does.
 */
export function buildPathProjection(path: SessionEntry[]): SessionProjection {
	return isLinearPath(path) ? projectionOf(projectionParts(path), false) : buildSessionProjection(path);
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
	const path =
		leafId === undefined && byId === undefined && isLinearPath(entries)
			? entries
			: buildSessionPath(entries, leafId, byId);
	const projection = projectionOf(projectionParts(path), false);
	const whole = () => getCompactionSystemFields(projection.messages, timestamp);
	const kept = projection.entries.findIndex((entry) => entry.sourceEntry.id === firstKeptEntryId);
	if (kept < 0) return whole();
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
