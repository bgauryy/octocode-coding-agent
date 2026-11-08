import type {
	ProfileActivity,
	ProfileAgent,
	ProfileLayerKind,
	ProfileRequest,
} from "@octocodeai/octocode-contracts/profiler";
import { asRecord } from "@octocodeai/octocode-contracts/guards";
import type { Traffic } from "@octocodeai/octocode-contracts/team";
import { builtInCompactionSettings } from "../../core/compaction/settings.ts";
import { cacheLifetimeMs } from "./cache-lifetime.ts";
import { deriveRequests, type ProfilerMember } from "./derive.ts";
import { num, str, type Entry, type Prepared } from "./entries.ts";

/** Largest layers listed in `contextTop`. */
const TOP_LAYERS = 5;

/** What the profiler needs to turn an agent's base row into the live one. */
export interface AgentContext {
	member: ProfilerMember;
	prepared?: Prepared;
	traffic: readonly Traffic[];
	now: number;
	/** The window the agent compacts against; absent for stored sources. */
	contextWindowOf?: (provider: string, model: string) => number | undefined;
	/** Layer breakdowns by agent, so a poll recomputes one only when the agent made a request. */
	cache?: Map<string, { key: string; value: Breakdown }>;
}

interface Breakdown {
	layers: NonNullable<ProfileAgent["contextLayers"]>;
	top: NonNullable<ProfileAgent["contextTop"]>;
	estimated: boolean;
}

const entryAt = (entry: Entry | undefined): number | undefined => {
	const at = Date.parse(String(entry?.timestamp));
	return Number.isFinite(at) ? at : undefined;
};

/** Layers of the latest request, summed by kind, with the biggest single layers (a layer split at a cache boundary counts once). */
function breakdownOf(request: ProfileRequest): Breakdown {
	const kinds = new Map<ProfileLayerKind, number>();
	const single = new Map<string, { kind: ProfileLayerKind; label: string; tokens: number }>();
	for (const layer of request.layers) {
		if (layer.tokens <= 0) continue;
		kinds.set(layer.kind, (kinds.get(layer.kind) ?? 0) + layer.tokens);
		const key = `${layer.kind}\0${layer.label}\0${layer.entry ?? ""}`;
		const known = single.get(key);
		if (known) known.tokens += layer.tokens;
		else single.set(key, { kind: layer.kind, label: layer.label, tokens: layer.tokens });
	}
	return {
		layers: [...kinds].map(([kind, tokens]) => ({ kind, tokens })).sort((a, b) => b.tokens - a.tokens),
		top: [...single.values()].sort((a, b) => b.tokens - a.tokens).slice(0, TOP_LAYERS),
		estimated: request.estimated,
	};
}

/** True when a compaction entry was written after the agent's latest request: its usage then describes the old context. */
function compactedSince(prepared: Prepared): boolean {
	const last = prepared.requests.at(-1) ?? -1;
	for (let i = prepared.entries.length - 1; i > last; i--) if (prepared.entries[i].type === "compaction") return true;
	return false;
}

function toolCalls(entry: Entry): Array<{ id: string; name: string }> {
	const content = asRecord(entry.message).content;
	if (!Array.isArray(content)) return [];
	return content
		.map(asRecord)
		.filter((part) => part.type === "toolCall")
		.map((part) => ({ id: str(part.id, ""), name: str(part.name, "tool") }));
}

/** What a working agent does now, read from the end of its transcript and the team's facts about it. */
function inferActivity(ctx: AgentContext, model: string | undefined): ProfileActivity | undefined {
	const { member, prepared, now } = ctx;
	if (member.status !== "working") return undefined;
	// Never `now`: a moving stamp would make every poll look like a change.
	const fallbackAt = member.updatedAt ?? entryAt(prepared?.entries.at(-1)) ?? member.joinedAt ?? now;
	if (member.waiting)
		return {
			kind: "wait",
			label: member.waiting === "approval" ? "permission" : "reply",
			since: fallbackAt,
			peer: "user",
		};
	const entries = prepared?.entries ?? [];
	let tail = entries.length - 1;
	while (tail >= 0) {
		const entry = entries[tail];
		const role = entry.type === "message" ? asRecord(entry.message).role : undefined;
		if (role === "assistant" || role === "user" || role === "toolResult") break;
		tail--;
	}
	const last = tail >= 0 ? entries[tail] : undefined;
	const role = last ? asRecord(last.message).role : undefined;
	if (last && role === "toolResult") {
		// Tool calls of the latest assistant message that have no result yet.
		let start = tail;
		while (start >= 0 && asRecord(entries[start].message).role !== "assistant") start--;
		const answered = new Set(
			entries.slice(start + 1, tail + 1).map((entry) => str(asRecord(entry.message).toolCallId, "")),
		);
		const pending = start < 0 ? [] : toolCalls(entries[start]).filter((call) => !answered.has(call.id));
		if (pending.length) return toolActivity(pending, entryAt(entries[start]) ?? fallbackAt);
	} else if (last && role === "assistant") {
		const pending = toolCalls(last);
		if (pending.length) return toolActivity(pending, entryAt(last) ?? fallbackAt);
	}
	const awaited = ctx.traffic
		.filter((message) => message.from === member.id && message.state === "awaiting reply")
		.sort((a, b) => a.at - b.at)[0];
	if (awaited) {
		const peer = awaited.to[0];
		return { kind: "wait", label: `reply from ${peer}`, since: awaited.at, peer };
	}
	if (last && (role === "user" || role === "toolResult"))
		return { kind: "request", label: model ?? "request", since: entryAt(last) ?? fallbackAt };
	if (!prepared && member.activity) return { kind: "tool", label: member.activity, since: fallbackAt };
	return { kind: "request", label: model ?? "request", since: fallbackAt };
}

function toolActivity(pending: Array<{ name: string }>, since: number): ProfileActivity {
	return {
		kind: "tool",
		label: pending[0].name.slice(0, 60),
		since,
		...(pending.length > 1 ? { count: pending.length } : {}),
	};
}

/** The agent's row with the window, context breakdown, lifetime and activity that need more than its totals. */
export function withContext(row: ProfileAgent, ctx: AgentContext): ProfileAgent {
	const { member, prepared } = ctx;
	const startedAt = member.joinedAt ?? entryAt(prepared?.entries[0]);
	const endedAt = member.outcome ? member.updatedAt : undefined;
	const activity = inferActivity(ctx, row.model);
	const window = row.provider && row.model ? ctx.contextWindowOf?.(row.provider, row.model) : undefined;
	const out: ProfileAgent = {
		...row,
		...(startedAt ? { startedAt } : {}),
		...(endedAt ? { endedAt } : {}),
		...(activity ? { activity } : {}),
	};
	if (window && window > 0) {
		out.contextWindow = window;
		// The same threshold `shared/tokens.ts autoCompactAt` gives, at the default thinking (the transcript has no budgets).
		out.compactAt = Math.max(0, window - builtInCompactionSettings({ contextWindow: window }).reserveTokens);
	}
	const lastPosition = prepared?.requests.at(-1);
	if (!prepared || lastPosition === undefined) return out;
	const lastMessage = asRecord(prepared.entries[lastPosition].message);
	const ttl = cacheLifetimeMs(prepared, prepared.requests.length - 1);
	if (ttl) out.cacheTtlMs = ttl;
	if (compactedSince(prepared)) return out;
	const usage = asRecord(lastMessage.usage);
	out.contextTokens = num(usage.input) + num(usage.cacheRead) + num(usage.cacheWrite) + num(usage.output);
	const breakdown = breakdownFor(row.id, prepared, ctx.cache);
	if (breakdown) {
		out.contextLayers = breakdown.layers;
		out.contextTop = breakdown.top;
		out.contextEstimated = breakdown.estimated;
	}
	return out;
}

function breakdownFor(agentId: string, prepared: Prepared, cache: AgentContext["cache"]): Breakdown | undefined {
	const count = prepared.requests.length;
	const key = `${count}:${prepared.entries[prepared.requests[count - 1]].id}`;
	const known = cache?.get(agentId);
	if (known?.key === key) return known.value;
	const [request] = deriveRequests(prepared.entries, { agentId, after: count - 2, limit: 1, detail: true, prepared });
	if (!request) return undefined;
	const value = breakdownOf(request);
	cache?.set(agentId, { key, value });
	return value;
}
