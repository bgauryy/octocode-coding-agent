import type {
	ProfileAgent,
	ProfileCacheState,
	ProfileLayer,
	ProfileRequest,
	ProfileUsage,
} from "@octocodeai/octocode-contracts/profiler";
import { asRecord } from "@octocodeai/octocode-contracts/guards";
import { cacheMissLabel } from "../../core/cache-stats.ts";
import { cacheGroupAt, hasCacheGroup, providerMissReason } from "./cache-group.ts";
import { cacheLifetimeMs } from "./cache-lifetime.ts";
import { num, str, prepare, promptTokens, type Entry, type Prepared } from "./entries.ts";
import { requestLayers, type Draft, type RequestLayers } from "./layers.ts";

/**
 * Size rules, so a payload stays small:
 * - A page holds at most `MAX_PAGE` requests (`MAX_DETAIL_PAGE` with `detail`, which lists every layer).
 * - Without `detail`, the unchanged leading history (the part the provider matched against the previous request) is one
 *   `history (N messages)` layer when it spans `MIN_GROUP` layers or more. The first request of an agent has no previous
 *   one: its history is grouped except the last `KEEP_RECENT` layers.
 * - Tools and system layers are never grouped: they are where a break shows.
 */
const MAX_PAGE = 50;
const MAX_DETAIL_PAGE = 10;
const MIN_GROUP = 4;
const KEEP_RECENT = 8;

/**
 * The smallest prompt a provider caches; under it a provider reports zero cache tokens and that is no miss. Anthropic
 * documents it per model (matched also on Bedrock, Vertex and gateway ids, whose versions may use dots): 512 for Opus 5, Fable 5
 * and 5.1, Mythos 5 and 5.1 and the 5.5 family; 2048 for Opus 4.7, Mythos Preview and the Haiku 3 line; 4096 for Opus
 * 4.5, Opus 4.6 and Haiku 4.5; 1024 for the other Claude models. Bedrock ids get Anthropic's table by assumption,
 * not checked against Bedrock's documentation. Other providers use the 1024 their automatic caching documents.
 */
const MINIMUM_CACHEABLE: Array<[RegExp, number]> = [
	[/claude-(opus-5|fable-5|mythos-5|(opus|sonnet|haiku)-5[-.]5)/i, 512],
	[/claude-(opus-4[-.][56]|haiku-4[-.]5)/i, 4096],
	[/claude-(mythos-preview|opus-4[-.]7|3([-.]5)?-haiku|haiku-3)/i, 2048],
];

export function minCacheableTokens(model: string): number {
	return MINIMUM_CACHEABLE.find(([pattern]) => pattern.test(model))?.[1] ?? 1024;
}

export interface DeriveOptions {
	agentId: string;
	/** Return the requests after this index (all when absent). */
	after?: number;
	limit?: number;
	/** Keep every layer instead of grouping the unchanged history. */
	detail?: boolean;
	/** The parse of `entries`, when the caller keeps one between calls. */
	prepared?: Prepared;
}

function usageOf(message: Record<string, unknown>): ProfileUsage {
	const usage = asRecord(message.usage);
	const cost = num(asRecord(usage.cost).total);
	return {
		input: num(usage.input),
		output: num(usage.output),
		cacheRead: num(usage.cacheRead),
		cacheWrite: num(usage.cacheWrite),
		...(cost > 0 ? { cost } : {}),
	};
}

function finishedAt(entry: Entry, message: Record<string, unknown>): number {
	const at = Date.parse(String(entry.timestamp));
	return Number.isFinite(at) ? at : num(message.timestamp);
}

/** Marks each layer changed against the same position of the previous request, and where the cached prefix broke. */
function compare(current: RequestLayers, previous: RequestLayers | undefined): void {
	const before = previous?.drafts ?? [];
	const comparable = previous !== undefined && previous.estimated === current.estimated;
	current.drafts.forEach((draft, i) => {
		const old = before[i];
		draft.changed = previous !== undefined && (!old || (comparable && old.key !== draft.key));
		draft.broke = !!old && comparable && old.key !== draft.key;
	});
}

/** One `history (N messages)` layer for the history that kept its position, per the size rules above. */
function compact(layers: RequestLayers, hasPrevious: boolean): Draft[] {
	const { drafts, historyStart } = layers;
	const history = drafts.slice(historyStart);
	let count = 0;
	if (hasPrevious) while (count < history.length && !history[count].changed) count++;
	else count = Math.max(0, history.length - KEEP_RECENT);
	if (count < MIN_GROUP) return drafts;
	const group = history.slice(0, count);
	return [
		...drafts.slice(0, historyStart),
		{
			kind: "message",
			label: `history (${count} messages)`,
			chars: group.reduce((sum, draft) => sum + draft.chars, 0),
			key: "",
			changed: false,
			broke: false,
			...(group[count - 1].breakpoint ? { breakpoint: true } : {}),
		},
		...history.slice(count),
	];
}

/**
 * Tokens and states. Layer tokens are chars / 4 scaled so they sum to the provider's prompt total (rounded cumulatively,
 * so the sum is exact). The provider matches a prefix: the first `cacheRead` tokens are `cached`, the next `cacheWrite`
 * `written`, the rest `uncached`; a layer that crosses a boundary is split there, so per-state sums equal the usage.
 */
function assign(drafts: Draft[], usage: ProfileUsage, tooShort: boolean): { layers: ProfileLayer[]; starts: number[] } {
	const total = usage.input + usage.cacheRead + usage.cacheWrite;
	const sized = drafts.some((draft) => draft.chars > 0);
	const sizeOf = (draft: Draft) => (sized ? draft.chars : 1);
	const weight = drafts.reduce((sum, draft) => sum + sizeOf(draft), 0);
	const layers: ProfileLayer[] = [];
	const starts: number[] = [];
	let cumulative = 0;
	let rounded = 0;
	const stateAt = (token: number): ProfileCacheState =>
		tooShort
			? "too-short"
			: token < usage.cacheRead
				? "cached"
				: token < usage.cacheRead + usage.cacheWrite
					? "written"
					: "uncached";
	for (const draft of drafts) {
		starts.push(layers.length);
		cumulative += sizeOf(draft);
		const end = Math.round((cumulative / weight) * total);
		const start = rounded;
		rounded = end;
		const base = {
			kind: draft.kind,
			label: draft.label,
			...(draft.entry === undefined ? {} : { entry: draft.entry }),
		};
		const cuts = [
			start,
			...[usage.cacheRead, usage.cacheRead + usage.cacheWrite].filter((c) => c > start && c < end),
			end,
		];
		for (let i = 0; i + 1 < cuts.length; i++) {
			const last = i + 2 === cuts.length;
			layers.push({
				...base,
				tokens: cuts[i + 1] - cuts[i],
				state: stateAt(cuts[i]),
				changed: i === 0 && draft.changed === true,
				...(last && draft.breakpoint ? { breakpoint: true } : {}),
			});
		}
	}
	return { layers, starts };
}

/**
 * The requests of a transcript after `opts.after`, oldest first, each with its prompt in layers. Layers come from the
 * recorded `requestTrace` when the assistant entry has one (`estimated: false`) and are inferred from the entries
 * otherwise. Context edits are not modelled: an edited entry shows up only through an exact trace.
 */
export function deriveRequests(entries: Entry[], opts: DeriveOptions): ProfileRequest[] {
	const prepared = opts.prepared ?? prepare(entries);
	const cap = opts.detail ? MAX_DETAIL_PAGE : MAX_PAGE;
	const first = (opts.after ?? -1) + 1;
	const last = Math.min(prepared.requests.length, first + Math.min(opts.limit ?? cap, cap));
	const memo = new Map<number, RequestLayers>();
	const layersOf = (k: number): RequestLayers => {
		let found = memo.get(k);
		if (!found) memo.set(k, (found = requestLayers(prepared, prepared.requests[k])));
		return found;
	};
	const grouped = hasCacheGroup(prepared.entries);
	const result: ProfileRequest[] = [];
	for (let k = Math.max(0, first); k < last; k++) {
		const position = prepared.requests[k];
		const entry = prepared.entries[position];
		const message = asRecord(entry.message);
		const usage = usageOf(message);
		const model = str(message.model, "");
		const current = layersOf(k);
		// The request before it on its own branch: after `/tree` that is not always the one written before it.
		const before = prepared.previous[k];
		const previous = before === undefined ? undefined : layersOf(before);
		compare(current, previous);
		const at = finishedAt(entry, message);
		const previousEntry = before === undefined ? undefined : prepared.entries[prepared.requests[before]];
		const previousMessage = previousEntry ? asRecord(previousEntry.message) : undefined;
		const previousAt = previousEntry ? finishedAt(previousEntry, previousMessage!) : undefined;
		const started = num(message.timestamp) || at - num(message.durationMs);
		const tooShort =
			usage.cacheRead === 0 &&
			usage.cacheWrite === 0 &&
			promptTokens(asRecord(message.usage)) < minCacheableTokens(model);
		const drafts = opts.detail ? current.drafts : compact(current, previous !== undefined);
		const { layers, starts } = assign(drafts, usage, tooShort);
		const broke = drafts.findIndex((draft) => draft.broke);
		const miss = prepared.misses.get(position);
		const group = grouped ? cacheGroupAt(prepared, position) : undefined;
		const providerReason = providerMissReason(message);
		const firstBreak = broke < 0 ? undefined : starts[broke];
		const outcomes = prepared.outcomes.get(k);
		result.push({
			agentId: opts.agentId,
			index: k,
			at,
			...(num(message.durationMs) ? { durationMs: num(message.durationMs) } : {}),
			model,
			...(message.provider ? { provider: str(message.provider, "") } : {}),
			usage,
			layers,
			...(outcomes ? { outcomes } : {}),
			...(firstBreak !== undefined ? { firstBreak } : {}),
			...(miss
				? { missReason: cacheMissLabel(miss, before === undefined ? undefined : cacheLifetimeMs(prepared, before)) }
				: {}),
			...(providerReason ? { providerMissReason: providerReason } : {}),
			...(group ? { cacheGroup: group } : {}),
			...(previousAt === undefined ? {} : { idleMs: Math.max(0, started - previousAt) }),
			estimated: current.estimated,
		});
	}
	return result;
}

/** What the team row says about an agent; the transcript supplies the rest of its `ProfileAgent`. */
export type AgentBase = Pick<ProfileAgent, "id" | "role" | "status"> &
	Partial<Pick<ProfileAgent, "parentId" | "model" | "provider" | "goal" | "outcome">>;

/** A listed agent: its team row facts, which the timeline reads for spawn and exit. */
export interface ProfilerMember extends AgentBase {
	joinedAt?: number;
	updatedAt?: number;
	/** How its run ended; set once it did. */
	outcome?: string;
	/** Blocked on the user (a permission dialog or a question), as the team row says. */
	waiting?: "approval" | "reply";
	/** The tool its team row says it runs now. */
	activity?: string;
}

/** The agent's row: totals over every request of `prepared`; unprofiled (no transcript) when it is absent. */
export function agentRow(base: AgentBase, prepared?: Prepared): ProfileAgent {
	const totals: ProfileUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	let cost = 0;
	let model = base.model;
	let provider = base.provider;
	let lastRequestAt: number | undefined;
	let cacheGroup: ProfileAgent["cacheGroup"];
	const lastRequest = prepared?.requests[prepared.requests.length - 1];
	if (prepared && lastRequest !== undefined && hasCacheGroup(prepared.entries))
		cacheGroup = cacheGroupAt(prepared, lastRequest);
	for (const position of prepared?.requests ?? []) {
		const entry = prepared!.entries[position];
		const message = asRecord(entry.message);
		const usage = usageOf(message);
		totals.input += usage.input;
		totals.output += usage.output;
		totals.cacheRead += usage.cacheRead;
		totals.cacheWrite += usage.cacheWrite;
		cost += usage.cost ?? 0;
		model = str(message.model, "") || model;
		provider = message.provider ? str(message.provider, "") : provider;
		lastRequestAt = finishedAt(entry, message);
	}
	const prompt = totals.input + totals.cacheRead + totals.cacheWrite;
	const requests = prepared?.requests.length ?? 0;
	return {
		id: base.id,
		role: base.role,
		status: base.status,
		...(base.parentId ? { parentId: base.parentId } : {}),
		...(base.goal ? { goal: base.goal } : {}),
		...(base.outcome ? { outcome: base.outcome } : {}),
		...(model ? { model } : {}),
		...(provider ? { provider } : {}),
		requests,
		totals: { ...totals, ...(cost > 0 ? { cost } : {}) },
		...(prompt > 0 ? { hitRate: totals.cacheRead / prompt } : {}),
		...(lastRequestAt === undefined ? {} : { lastRequestAt }),
		...(cacheGroup ? { cacheGroup } : {}),
		profiled: prepared !== undefined,
	};
}
