/**
 * Differential check of the kept session projection (`projection-memo.ts`) against the projection as it was computed
 * before it was kept: the whole branch walked from the root for every read. Random session trees get appends, branches,
 * leaf moves, compactions (kept ids on and off the branch), branch summaries, custom and system messages, model and
 * thinking changes, labels, names, context edits and entry rewrites, with reads at random points between them.
 */
import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import { getCurrentSystemMessage, type Model } from "@octocodeai/octocode-ai";
import { estimateContextTokens, estimateLeafContextTokens, estimateTokens } from "../../src/core/compaction/tokens.ts";
import { calculateContextTokens } from "@octocodeai/octocode-ai/utils/estimate";
import {
	type CompactionEntry,
	type ContextEditEntry,
	type ProjectedSessionEntry,
	type ReadonlySessionProjection,
	type SessionEntry,
	SessionManager,
	type SessionProjection,
} from "../../src/core/session-manager.ts";
import { pathFromRoot } from "../../src/core/session-manager/ancestors.ts";
import { buildPathProjection, projectContextEntry } from "../../src/core/session-manager/context.ts";
import type { DraftAppender } from "../../src/core/session-manager/projection-memo.ts";
import { computeContextUsage } from "../../src/core/session-stats.ts";

// ---- The oracle: the projection, context entries and usage as computed before the projection was kept. ----

function oraclePath(entries: SessionEntry[], leafId: string | null, byId: ReadonlyMap<string, SessionEntry>) {
	if (leafId === null) return [];
	const leaf = byId.get(leafId) ?? entries[entries.length - 1];
	return pathFromRoot(leaf, (id) => byId.get(id));
}

function oracleContextEntries(path: SessionEntry[]): SessionEntry[] {
	let compaction: CompactionEntry | null = null;
	for (const entry of path) if (entry.type === "compaction") compaction = entry;
	if (!compaction) return path;
	const compactionIdx = path.findIndex((entry) => entry.id === compaction.id);
	const contextEntries: SessionEntry[] = [compaction];
	const keepSystem = compaction.systemFold === "summarized";
	let foundFirstKept = false;
	for (let i = 0; i < compactionIdx; i++) {
		const entry = path[i];
		if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
		const system = entry.type === "message" && entry.message.role === "system";
		if (foundFirstKept && (keepSystem || !system)) contextEntries.push(entry);
	}
	contextEntries.push(...path.slice(compactionIdx + 1));
	return contextEntries;
}

function oracleProjectionOfPath(path: SessionEntry[]): SessionProjection {
	let thinkingLevel = "off";
	let model: { provider: string; modelId: string } | null = null;
	for (const entry of path) {
		if (entry.type === "thinking_level_change") thinkingLevel = entry.thinkingLevel;
		else if (entry.type === "model_change") model = { provider: entry.provider, modelId: entry.modelId };
		else if (entry.type === "message" && entry.message.role === "assistant")
			model = { provider: entry.message.provider, modelId: entry.message.model };
	}
	const contextEntries = oracleContextEntries(path);
	const edits = new Map<string, ContextEditEntry>();
	for (const entry of contextEntries) if (entry.type === "context_edit") edits.set(entry.targetId, entry);
	const entries = contextEntries.map((sourceEntry, index): ProjectedSessionEntry => ({
		sourceEntry,
		messages:
			sourceEntry.type === "compaction" && index > 0 ? [] : projectContextEntry(sourceEntry, edits.get(sourceEntry.id)),
	}));
	return { entries, messages: entries.flatMap((entry) => entry.messages), thinkingLevel, model };
}

const stateOf = (session: SessionManager) =>
	(session as unknown as { state: { byId: Map<string, SessionEntry>; leafId: string | null; fileEntries: unknown[] } })
		.state;

export function oracleProjection(session: SessionManager): SessionProjection {
	const state = stateOf(session);
	return oracleProjectionOfPath(oraclePath(session.getEntries(), state.leafId, state.byId));
}

function oracleEstimate(projection: SessionProjection, branch: SessionEntry[]) {
	const estimate = estimateContextTokens(projection.messages);
	if (estimate.lastUsageIndex !== null) {
		let index = 0;
		let usageEntryId: string | undefined;
		for (const entry of projection.entries) {
			const next = index + entry.messages.length;
			if (estimate.lastUsageIndex < next) {
				usageEntryId = entry.sourceEntry.id;
				break;
			}
			index = next;
		}
		const usageEntryIndex = usageEntryId ? branch.findIndex((entry) => entry.id === usageEntryId) : -1;
		if (usageEntryIndex >= 0) {
			const prefixIds = new Set(branch.slice(0, usageEntryIndex + 1).map((entry) => entry.id));
			const changed = branch
				.slice(usageEntryIndex + 1)
				.some(
					(entry) => entry.type === "compaction" || (entry.type === "context_edit" && prefixIds.has(entry.targetId)),
				);
			if (!changed) return estimate;
		}
	}
	const currentSystem = getCurrentSystemMessage(projection.messages);
	let tokens = currentSystem ? estimateTokens(currentSystem) : 0;
	for (const message of projection.messages) if (message.role !== "system") tokens += estimateTokens(message);
	return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
}

function oracleUsage(session: SessionManager, contextWindow: number) {
	const projection = oracleProjection(session);
	const branch = session.getBranch();
	let latest: CompactionEntry | undefined;
	for (const entry of branch) if (entry.type === "compaction") latest = entry;
	if (latest) {
		const assistants = new Set(
			projection.entries.flatMap((entry) =>
				entry.messages.some(
					(m) =>
						m.role === "assistant" &&
						m.stopReason !== "aborted" &&
						m.stopReason !== "error" &&
						calculateContextTokens(m.usage) > 0,
				)
					? [entry.sourceEntry.id]
					: [],
			),
		);
		const at = branch.findIndex((entry) => entry.id === latest.id);
		if (!branch.slice(at + 1).some((entry) => assistants.has(entry.id)))
			return { tokens: null, contextWindow, percent: null };
	}
	const estimate = oracleEstimate(projection, branch);
	return { tokens: estimate.tokens, contextWindow, percent: (estimate.tokens / contextWindow) * 100 };
}

// ---- Random sessions ----

/** Mulberry32: a small seeded generator, so a failing seed replays. */
export function random(seed: number) {
	let a = seed >>> 0;
	const next = () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return {
		next,
		int: (n: number) => Math.floor(next() * n),
		pick: <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)],
		chance: (p: number) => next() < p,
	};
}
type Random = ReturnType<typeof random>;

const usage = (input: number) => ({
	input,
	output: 10,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: input + 10,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function message(rng: Random, n: number): AgentMessage {
	const timestamp = 1_000 + n;
	switch (rng.int(5)) {
		case 0:
			return { role: "user", content: [{ type: "text", text: `user ${n}` }], timestamp };
		case 1:
			return {
				role: "assistant",
				content: [{ type: "text", text: `reply ${n}` }],
				api: "anthropic-messages",
				provider: rng.pick(["p1", "p2"]),
				model: rng.pick(["m1", "m2"]),
				usage: usage(rng.pick([0, 100 + n])),
				stopReason: rng.pick(["stop", "stop", "error", "aborted", "toolUse"] as const),
				timestamp,
			};
		case 2:
			return {
				role: "toolResult",
				toolCallId: `call${n}`,
				toolName: "bash",
				content: [{ type: "text", text: `result ${n}` }],
				isError: false,
				timestamp,
			};
		case 3:
			return { role: "system", content: `prompt ${n}`, timestamp };
		default:
			return { role: "user", content: null, timestamp } as unknown as AgentMessage;
	}
}

const editable = (entry: SessionEntry) =>
	entry.type === "custom_message" ||
	(entry.type === "message" && ["user", "assistant", "toolResult"].includes(entry.message.role));

/** One random change to the session; returns a label for failure messages. */
function mutate(rng: Random, session: SessionManager, n: number): string {
	const state = stateOf(session);
	const all = session.getEntries();
	const branch = session.getBranch();
	const roll = rng.int(100);
	if (roll < 30) {
		session.appendMessage(message(rng, n) as never);
		return "message";
	}
	if (roll < 38) {
		session.appendCustomMessageEntry(
			`note${n % 3}`,
			rng.chance(0.5) ? `custom ${n}` : [{ type: "text", text: `c${n}` }],
			rng.chance(0.5),
			{ n },
		);
		return "custom_message";
	}
	if (roll < 42) {
		session.appendCustomEntry("state", { n });
		return "custom";
	}
	if (roll < 46) {
		session.appendThinkingLevelChange(rng.pick(["low", "high", "off"]));
		return "thinking";
	}
	if (roll < 50) {
		session.appendModelChange(rng.pick(["p1", "p3"]), `m${n}`);
		return "model";
	}
	if (roll < 53 && all.length > 0) {
		session.appendLabelChange(rng.pick(all).id, rng.chance(0.7) ? `label${n}` : undefined);
		return "label";
	}
	if (roll < 55) {
		session.appendSessionInfo(`name ${n}`);
		return "session_info";
	}
	if (roll < 62) {
		const targets = branch.filter(editable);
		if (targets.length === 0) return "none";
		const replacement = rng.pick([
			null,
			{ content: `edited ${n}` },
			{ content: [{ type: "text" as const, text: `e${n}` }] },
		]);
		session.appendContextEdit(rng.pick(targets).id, replacement);
		return "context_edit";
	}
	if (roll < 68 && branch.length > 0) {
		const kept = rng.pick([rng.pick(branch).id, rng.pick(branch).id, "missing-kept-id", null]);
		session.appendCompaction(`summary ${n}`, kept, 100 + n);
		return "compaction";
	}
	if (roll < 74 && all.length > 0) {
		session.branch(rng.pick(all).id);
		return "branch";
	}
	if (roll < 77 && all.length > 0) {
		session.branchWithSummary(rng.pick(all).id, `branch summary ${n}`);
		return "branch_summary";
	}
	if (roll < 79) {
		session.resetLeaf();
		return "reset_leaf";
	}
	if (roll < 83 && all.length > 0) {
		// A rewrite: an entry replaced by a changed copy, as a reload or a merged write does.
		const target = rng.pick(all);
		const copy =
			target.type === "custom_message"
				? { ...target, content: `rewritten ${n}` }
				: target.type === "message"
					? { ...target, message: { ...target.message, timestamp: 9_999_999 } }
					: { ...target };
		state.byId.set(target.id, copy);
		state.fileEntries[state.fileEntries.indexOf(target)] = copy;
		return "rewrite";
	}
	if (roll < 85 && session.getLeafEntry() && state.fileEntries.includes(session.getLeafEntry())) {
		// A rolled-back append: the leaf removed and its parent the leaf again.
		const leaf = session.getLeafEntry()!;
		state.byId.delete(leaf.id);
		state.fileEntries.splice(state.fileEntries.indexOf(leaf), 1);
		state.leafId = leaf.parentId;
		return "rollback";
	}
	if (roll < 86) {
		state.leafId = "ghost-leaf";
		return "unknown_leaf";
	}
	session.appendMessage(message(rng, n) as never);
	return "message";
}

// ---- Comparisons ----

type Draft =
	| { type: "custom"; customType: string; data: unknown }
	| { type: "custom_message"; customType: string; content: string; display: boolean }
	| { type: "context_edit"; targetId: string; replacement: ContextEditEntry["replacement"] };

function randomDrafts(rng: Random, session: SessionManager, n: number): Draft[] {
	const drafts: Draft[] = [];
	const targets = session.getBranch().filter(editable);
	for (let k = rng.int(4); k > 0; k--) {
		const roll = rng.int(3);
		if (roll === 0) drafts.push({ type: "custom", customType: "draft", data: { n, k } });
		else if (roll === 1 || targets.length === 0)
			drafts.push({
				type: "custom_message",
				customType: "draft",
				content: `draft ${n}.${k}`,
				display: rng.chance(0.5),
			});
		else
			drafts.push({
				type: "context_edit",
				targetId: rng.pick(targets).id,
				replacement: rng.pick([null, { content: `d${k}` }]),
			});
	}
	return drafts;
}

function applyDrafts(appender: DraftAppender, drafts: Draft[]): void {
	for (const draft of drafts) {
		if (draft.type === "custom") appender.appendCustomEntry(draft.customType, draft.data);
		else if (draft.type === "custom_message")
			appender.appendCustomMessageEntry(draft.customType, draft.content, draft.display);
		else appender.appendContextEdit(draft.targetId, draft.replacement);
	}
}

/** The projection with the ids of entries the session does not hold (drafts) numbered in order of appearance. */
function withDraftIds(projection: ReadonlySessionProjection, live: SessionManager): unknown {
	const ids = new Map<string, string>();
	const rename = (id: string | null) => (id !== null && ids.has(id) ? ids.get(id)! : id);
	for (const { sourceEntry } of projection.entries) {
		if (live.getEntry(sourceEntry.id) !== sourceEntry) ids.set(sourceEntry.id, `draft-${ids.size}`);
	}
	return {
		...projection,
		entries: projection.entries.map(({ sourceEntry, messages }) => ({
			sourceEntry: {
				...sourceEntry,
				id: rename(sourceEntry.id),
				parentId: rename(sourceEntry.parentId),
				...(sourceEntry.type === "context_edit" ? { targetId: rename(sourceEntry.targetId) } : {}),
			},
			messages,
		})),
	};
}

function outcome<T>(run: () => T): { value: T } | { error: true } {
	try {
		return { value: run() };
	} catch {
		return { error: true };
	}
}

export interface Mismatch {
	seed: number;
	step: number;
	op: string;
	what: string;
}

// An id outside every tokenizer family: the estimate uses the default ratio, as the oracle does.
const model = { id: "test-model", contextWindow: 50_000 } as Model<any>;

/** Every read the kept projection serves compared with the oracle; returns the first mismatch. */
function compare(session: SessionManager, rng: Random, n: number, freeze: boolean): string | undefined {
	const expected = oracleProjection(session);
	const projection = session.buildSessionProjection();
	if (freeze) deepFreeze(projection);
	if (!deepEqual(projection, expected)) return "buildSessionProjection";
	// The view is the kept arrays themselves: never frozen, since the session extends them.
	if (!deepEqual(session.readSessionProjection(), expected)) return "readSessionProjection";
	const entries = session.buildContextEntries();
	const expectedEntries = expected.entries.map((entry) => entry.sourceEntry);
	if (entries.length !== expectedEntries.length || entries.some((entry, i) => entry !== expectedEntries[i]))
		return "buildContextEntries";
	if (
		!deepEqual(session.buildSessionContext(), {
			messages: expected.messages,
			thinkingLevel: expected.thinkingLevel,
			model: expected.model,
		})
	)
		return "buildSessionContext";
	if (!deepEqual(computeContextUsage(session, model), oracleUsage(session, model.contextWindow)))
		return "computeContextUsage";
	if (!deepEqual(estimateLeafContextTokens(projection, session), oracleEstimate(expected, session.getBranch())))
		return "estimateLeafContextTokens";
	const branch = session.getBranch();
	const state = stateOf(session);
	const leaf = state.leafId === null ? undefined : state.byId.get(state.leafId);
	const expectedBranch = pathFromRoot(leaf, (id) => state.byId.get(id));
	if (branch.length !== expectedBranch.length || branch.some((entry, i) => entry !== expectedBranch[i]))
		return "getBranch";
	if (!deepEqual(buildPathProjection(branch), oracleProjectionOfPath(branch))) return "buildPathProjection";
	// The boundary preview: the kept projection with drafts, against a copy of the branch with the drafts applied.
	const drafts = randomDrafts(rng, session, n);
	const preview = outcome(() => {
		const value = session.previewProjection((appender) => applyDrafts(appender, drafts));
		// Its entry records are the kept ones: frozen, the session's later reads and appends must still work.
		if (freeze && value) deepFreeze(value);
		return value;
	});
	const copied = outcome(() => {
		const copy = SessionManager.inMemory(session.getCwd(), undefined, [session.getHeader()!, ...branch]);
		applyDrafts(copy, drafts);
		return oracleProjection(copy);
	});
	if (stateOf(session).leafId !== null && !session.getLeafEntry()) {
		if ("value" in preview && preview.value !== undefined) return "previewProjection (unknown leaf)";
	} else if ("error" in preview || "error" in copied) {
		if (!("error" in preview && "error" in copied)) return "previewProjection (error)";
	} else if (!preview.value || !deepEqual(withDraftIds(preview.value, session), withDraftIds(copied.value, session)))
		return "previewProjection";
	// The session itself is unchanged by the preview.
	if (!deepEqual(session.buildSessionProjection(), expected)) return "after preview";
	return undefined;
}

/** Freezes a projection with every object it reaches: anything that changes it later throws. */
function deepFreeze(value: unknown, seen = new Set<unknown>()): void {
	if (value === null || typeof value !== "object" || seen.has(value)) return;
	seen.add(value);
	for (const child of Object.values(value)) deepFreeze(child, seen);
	Object.freeze(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Runs `steps` random changes on a fresh session for each seed and compares after each (or a few) of them. Several
 * changes between reads make the kept projection extend over more than one entry. Returns the mismatches found.
 */
export function runProperty(seeds: readonly number[], steps: number, options: { freeze?: boolean } = {}): Mismatch[] {
	const mismatches: Mismatch[] = [];
	for (const seed of seeds) {
		const rng = random(seed);
		const session = SessionManager.inMemory("/tmp/projection-property");
		for (let step = 0; step < steps; step++) {
			let op = "";
			for (let k = rng.chance(0.6) ? 1 : 1 + rng.int(4); k > 0; k--) op += `${mutate(rng, session, step * 10 + k)} `;
			let what: string | undefined;
			try {
				what = compare(session, rng, step, options.freeze === true);
			} catch (error) {
				what = `threw: ${error instanceof Error ? error.message : String(error)}`;
			}
			if (what) {
				mismatches.push({ seed, step, op: op.trim(), what });
				break;
			}
		}
	}
	return mismatches;
}
