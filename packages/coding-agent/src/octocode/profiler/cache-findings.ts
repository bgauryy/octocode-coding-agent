import { charsPerToken } from "@octocodeai/octocode-ai/utils/estimate";
import type { ProfileFinding } from "@octocodeai/octocode-contracts/profiler";
import { asRecord } from "@octocodeai/octocode-contracts/guards";
import { cacheLifetimeMs } from "./cache-lifetime.ts";
import { deriveRequests, minCacheableTokens } from "./derive.ts";
import { num, str, promptTokens, type Prepared } from "./entries.ts";
import { requestLayers, toolDefinitions } from "./layers.ts";
import type { Lane } from "./timeline.ts";

/** Thresholds of the analysis; each finding below says which one it used. */
const REWRITE_MIN_TOKENS = 5_000;
const REWRITE_HIGH_TOKENS = 50_000;
const COLD_START_MIN_TOKENS = 10_000;
const MAX_REWRITE_FINDINGS = 40;

/** Entries that change what the provider matches by design; the rewrite after one is expected. */
const EXPECTED_CAUSES: Record<string, string> = {
	compaction: "compaction",
	branch_summary: "branch summary",
	thinking_level_change: "thinking-level change",
};

const messageAt = (prepared: Prepared, k: number) => asRecord(prepared.entries[prepared.requests[k]].message);

/**
 * The expected event between request `k` and the request before it on its branch: a compaction, a branch summary or a
 * thinking-level change on the path between them (the latest wins), else a model or provider switch (the cache belongs
 * to one provider and model). The layers cannot always say it: a recorded trace whose wire messages do not join the
 * entries carries roles only.
 */
function expectedCause(prepared: Prepared, k: number, before: number): string | undefined {
	const { entries, byId } = prepared;
	const stop = prepared.requests[before];
	let at: number | undefined = prepared.requests[k];
	for (let steps = 0; at !== undefined && at !== stop && steps < entries.length; steps++) {
		const cause = EXPECTED_CAUSES[entries[at].type];
		if (cause) return cause;
		const parent: unknown = entries[at].parentId;
		at = typeof parent === "string" ? byId.get(parent) : parent === null || at === 0 ? undefined : at - 1;
	}
	const switched = (field: string, name: string) => {
		const from = str(messageAt(prepared, before)[field], "");
		const to = str(messageAt(prepared, k)[field], "");
		return from && to && from !== to ? `${name} switch (${from} → ${to})` : undefined;
	};
	return switched("model", "model") ?? switched("provider", "provider");
}

/** When request `k` started: a cache lifetime runs from the start of the request that wrote or read the entry. */
function startedAt(prepared: Prepared, k: number): number {
	const entry = prepared.entries[prepared.requests[k]];
	const message = asRecord(entry.message);
	const finished = Date.parse(String(entry.timestamp));
	return num(message.timestamp) || (Number.isFinite(finished) ? finished : 0) - num(message.durationMs);
}

/**
 * Whether the cache request `before` left had expired when request `k` started. Checked before any expected cause: a
 * compaction or thinking change after a long gap reads nothing because the entries expired, not because it lost them.
 */
function outlived(prepared: Prepared, k: number, before: number, reason: string): boolean {
	if (/idle/.test(reason)) return true;
	const lifetime = cacheLifetimeMs(prepared, before);
	return lifetime !== undefined && startedAt(prepared, k) - startedAt(prepared, before) >= lifetime;
}

/**
 * Whether request `k` read at least its tools and system prefix, estimated at the sparse end of its model family's
 * measured characters per token (`charsPerToken(model, "floor")`): a read below that floor means the prefix was
 * rewritten too.
 */
function readItsPrefix(prepared: Prepared, k: number, cacheRead: number): boolean {
	const layers = requestLayers(prepared, prepared.requests[k]);
	const chars = layers.drafts.slice(0, layers.historyStart).reduce((sum, draft) => sum + draft.chars, 0);
	const model = { id: str(messageAt(prepared, k).model, "") };
	return cacheRead > 0 && cacheRead >= chars / charsPerToken(model, "floor");
}

function rewriteFindings(lane: Lane, prepared: Prepared): ProfileFinding[] {
	const found: ProfileFinding[] = [];
	const usageAt = (k: number) => asRecord(messageAt(prepared, k).usage);
	let rewrites = 0;
	for (let k = 1; k < prepared.requests.length && rewrites < MAX_REWRITE_FINDINGS; k++) {
		const before = prepared.previous[k];
		if (before === undefined) continue;
		const usage = usageAt(k);
		const resent = num(usage.input) + num(usage.cacheWrite);
		const held = num(usageAt(before).cacheRead) + num(usageAt(before).cacheWrite);
		if (num(usage.cacheRead) >= held * 0.5 || resent < REWRITE_MIN_TOKENS) continue;
		const evidence = [{ agentId: lane.id, request: k }];
		const [request] = deriveRequests(prepared.entries, { agentId: lane.id, after: k - 1, limit: 1, prepared });
		const severity = resent >= REWRITE_HIGH_TOKENS ? "high" : "medium";
		const reason = request?.missReason ?? "";
		const expected = expectedCause(prepared, k, before);
		const switched = expected?.includes(" switch (") === true;
		// A model or provider switch misses whatever the age; any other miss after the lifetime ran out is an expiry.
		if (!switched && outlived(prepared, k, before, reason)) {
			const idleMs = request?.idleMs ?? startedAt(prepared, k) - startedAt(prepared, before);
			found.push({
				id: `${lane.id}:idle:${k}`,
				kind: "cache-idle-expiry",
				severity,
				title: `Cache expired after ${Math.round(idleMs / 60_000)}m idle and ${resent} tokens were sent again`,
				detail:
					"The gap outlived the cache lifetime. Nothing to fix unless the agent could have been kept busy or used the 1h cache.",
				agentId: lane.id,
				tokens: resent,
				evidence,
			});
			continue;
		}
		const broken = request?.firstBreak === undefined ? undefined : request.layers[request.firstBreak];
		const cause =
			expected ??
			(broken
				? broken.kind === "tools"
					? "tool-set change"
					: broken.kind === "system"
						? `section update (${broken.label})`
						: `${broken.kind} change`
				: reason || "unknown cause");
		rewrites++;
		// A compaction, branch summary or thinking change rewrites the history only; one that also lost the prefix is no
		// longer explained by it.
		const prefixLost = expected !== undefined && !switched && !readItsPrefix(prepared, k, num(usage.cacheRead));
		found.push({
			id: `${lane.id}:rewrite:${k}`,
			kind: "cache-rewrite",
			severity: expected && !prefixLost ? "low" : severity,
			title: `${cause} rewrote ${resent} cached tokens`,
			detail: !expected
				? `Cause: ${cause}. A change early in the prompt invalidates everything after it; keep the changing part at the tail.`
				: switched
					? `Cause: ${cause}. The cache belongs to one provider and model, so the new one writes the whole prompt once.`
					: prefixLost
						? `Cause: ${cause}, yet only ${num(usage.cacheRead)} tokens were read: the tools and system blocks were rewritten too, which a ${cause} does not explain. Look for a tool or instruction change made with it.`
						: `Cause: ${cause}. It changes the prompt by design, so the part after the change is written once; the blocks before it stay cached.`,
			agentId: lane.id,
			tokens: resent,
			evidence,
		});
	}
	return found;
}

function tooShortFinding(lane: Lane, prepared: Prepared): ProfileFinding[] {
	let count = 0;
	let tokens = 0;
	for (let k = 0; k < prepared.requests.length; k++) {
		const usage = asRecord(messageAt(prepared, k).usage);
		const prompt = promptTokens(usage);
		if (
			num(usage.cacheRead) ||
			num(usage.cacheWrite) ||
			prompt >= minCacheableTokens(str(messageAt(prepared, k).model, ""))
		)
			continue;
		count++;
		tokens += prompt;
	}
	if (!count) return [];
	return [
		{
			id: `${lane.id}:short`,
			kind: "cache-too-short",
			severity: "low",
			title: `${count} requests were too short to cache`,
			detail: "Prompts under the model's minimum cacheable length are never cached; that is not a miss.",
			agentId: lane.id,
			tokens,
			evidence: [{ agentId: lane.id }],
		},
	];
}

/** A lane's first request, as a cold-start comparison reads it. */
interface Start {
	lane: Lane;
	prepared: Prepared;
	startedAt: number;
	finishedAt: number;
	cacheKey: string;
	tools: string;
}

function startOf(lane: Lane): Start | undefined {
	const prepared = lane.prepared;
	if (!prepared?.requests.length) return undefined;
	const entry = prepared.entries[prepared.requests[0]];
	const message = asRecord(entry.message);
	const finished = Date.parse(String(entry.timestamp));
	const finishedAt = Number.isFinite(finished) ? finished : num(message.timestamp);
	const head = requestLayers(prepared, prepared.requests[0]);
	return {
		lane,
		prepared,
		startedAt: num(message.timestamp) || finishedAt - num(message.durationMs),
		finishedAt,
		cacheKey: `${str(message.provider, "")}|${str(message.model, "")}`,
		tools: head.drafts.find((draft) => draft.kind === "tools")?.label ?? "",
	};
}

/**
 * The last request of `start`'s lane that finished before `at`, with the lifetime of the cache it left; `at` is when it
 * started, since a lifetime runs from the start of the request that wrote or read the entry. Undefined lifetime: unknown.
 */
function lastBefore(start: Start, at: number): { at: number; lifetime: number | undefined } | undefined {
	let found: { at: number; lifetime: number | undefined } | undefined;
	start.prepared.requests.forEach((position, k) => {
		const entry = start.prepared.entries[position];
		const message = asRecord(entry.message);
		const finished = Date.parse(String(entry.timestamp));
		if (!Number.isFinite(finished) || finished > at) return;
		const startedAt = num(message.timestamp) || finished - num(message.durationMs);
		// A new child reads only the instructions a sibling left, so their tier decides.
		found = { at: startedAt, lifetime: cacheLifetimeMs(start.prepared, k, "instructions") };
	});
	return found;
}

/** The tools whose definitions differ between two first requests, by name, as their transcripts list them. */
function changedTools(a: Start, b: Start): string[] {
	const mine = toolDefinitions(a.prepared, a.prepared.requests[0]);
	const theirs = toolDefinitions(b.prepared, b.prepared.requests[0]);
	const names = new Set([...mine.keys(), ...theirs.keys()]);
	return [...names].filter((name) => mine.get(name) !== theirs.get(name)).slice(0, 5);
}

/** Why a child's first request read nothing: the evidence from the agents that ran on the same provider and model. */
function coldStart(
	start: Start,
	starts: Start[],
	written: number,
): Pick<ProfileFinding, "severity" | "title" | "detail"> {
	const id = start.lane.id;
	const model = start.cacheKey.split("|")[1];
	const earlier = starts.filter((s) => s !== start && s.cacheKey === start.cacheKey && s.startedAt < start.startedAt);
	if (!earlier.length)
		return {
			severity: "low",
			title: `${id} started cold: the first ${model} request of the session`,
			detail: "No earlier agent on this provider and model left a cache to read. Expected.",
		};
	const sameTools = earlier.filter((s) => s.tools === start.tools);
	const pool = sameTools.length ? sameTools : earlier;
	const latest = (list: Start[]) => list.reduce((best, s) => (s.startedAt > best.startedAt ? s : best));
	// Concurrent only when no sibling had finished its first request yet: one that had left a cache to read.
	const finished = pool.filter((s) => s.finishedAt <= start.startedAt);
	if (!finished.length)
		return {
			severity: "low",
			title: `${id} started cold while ${latest(pool).lane.id}'s first request was still writing`,
			detail:
				"A cache entry exists only once the first reply starts streaming, so agents that start together each write it. Expected.",
		};
	const nearest = latest(finished);
	const recent = pool
		.map((s) => lastBefore(s, start.startedAt))
		.filter((last) => last !== undefined)
		.reduce<{ at: number; lifetime: number | undefined } | undefined>(
			(best, last) => (!best || last.at > best.at ? last : best),
			undefined,
		);
	if (recent?.lifetime !== undefined && start.startedAt - recent.at > recent.lifetime)
		return {
			severity: "low",
			title: `${id} started cold: the shared ${model} cache had expired (last request ${Math.round((start.startedAt - recent.at) / 60_000)}m before)`,
			detail: `No ${model} request ran within the cache lifetime (${Math.round(recent.lifetime / 60_000)}m) before it started. Expected.`,
		};
	if (!sameTools.length)
		return {
			severity: "low",
			title: `${id} started cold: the first ${model} request with ${start.tools || "its tool set"}`,
			detail: "Earlier agents on this model sent a different tool set, and the tools lead the cached prefix. Expected.",
		};
	const mine = requestLayers(start.prepared, start.prepared.requests[0]);
	const theirs = requestLayers(nearest.prepared, nearest.prepared.requests[0]);
	const differs =
		mine.estimated === theirs.estimated
			? mine.drafts
					.slice(0, mine.historyStart)
					.find((draft, i) => i >= theirs.historyStart || theirs.drafts[i].key !== draft.key)
			: undefined;
	const minutes = Math.round((start.startedAt - nearest.startedAt) / 60_000);
	if (differs) {
		const changed = differs.kind === "tools" ? changedTools(start, nearest) : [];
		const which = changed.length ? ` (${changed.join(", ")} changed)` : "";
		return {
			severity: "medium",
			title: `${id} started cold: its ${differs.label} layer differs from ${nearest.lane.id}'s${which}`,
			detail: `${nearest.lane.id} started ${minutes}m earlier on ${model} with ${start.tools}, but its ${differs.label} layer had other bytes, so nothing it cached matched and ${written} tokens were written. A change to that layer between starts (an edited tool description or instruction, a rebuilt binary) does this.`,
		};
	}
	return {
		severity: "medium",
		title: `${id} started cold and wrote ${written} tokens`,
		detail: `${nearest.lane.id} started ${minutes}m earlier on ${model} with the same tools and system layers, yet nothing was read. A byte-identical shared base block would let sibling agents read each other's cache.`,
	};
}

/** Cache findings of every lane: rewrites and idle expiries, cold child starts and prompts too short to cache. */
export function cacheFindings(lanes: Lane[]): ProfileFinding[] {
	const starts = lanes.map(startOf).filter((start) => start !== undefined);
	const found: ProfileFinding[] = [];
	for (const lane of lanes) {
		const prepared = lane.prepared;
		if (!prepared?.requests.length) continue;
		const usage = asRecord(messageAt(prepared, 0).usage);
		const written = num(usage.cacheWrite);
		const start = starts.find((s) => s.lane === lane);
		if (start && lane.parentId && written >= COLD_START_MIN_TOKENS && !num(usage.cacheRead))
			found.push({
				id: `${lane.id}:cold`,
				kind: "cache-cold-start",
				...coldStart(start, starts, written),
				agentId: lane.id,
				tokens: written,
				evidence: [{ agentId: lane.id, request: 0 }],
			});
		found.push(...rewriteFindings(lane, prepared), ...tooShortFinding(lane, prepared));
	}
	return found;
}
