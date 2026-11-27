import { activeRates, type Api, type Model } from "@octocodeai/octocode-ai";
import { asRecord } from "@octocodeai/octocode-contracts/guards";
import { charsToTokens } from "@octocodeai/octocode-ai/utils/estimate";
import { MAX_COMPACTION_INSTRUCTIONS } from "../../core/compaction/manual-options.ts";
import { builtInCompactionSettings } from "../../core/compaction/settings.ts";
import type { FeatureContext, FeatureSetup } from "../../core/features/index.ts";
import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";
import { BACKLOG_DONE_CHANNEL, type BacklogDone } from "../shared/agent-chain.ts";
import { autoCompactAt, compactionThinking } from "../shared/tokens.ts";
import { COMPACT_MIN_SHARE, type CompactRequests } from "../native/tools/compact/tool.ts";
import { averageRequestsPerItem, doneGain, expectedRequests } from "./done-gain.ts";
import { limitsFor } from "./limits.ts";
import { contextTokens, toolDefinitionChars } from "./pacing.ts";
import { recordCompactionNote } from "./record.ts";

/** The finished items this many turns back set the average requests per item. */
const RECENT_ITEMS = 8;

type OnDoneApi = Pick<FeatureSetup, "channels" | "settings" | "tools" | "models" | "session">;

/** One decision's measures, written to the session once its outcome is known. */
interface Decision {
	reason: string;
	measures: Record<string, number | string | boolean>;
}

export interface CompactOnDone {
	/** At a turn's end: judges the items finished in the turn. */
	turnEnd(ctx: FeatureContext): void;
	/** A compaction starts; `item`: this feature asked for it. */
	begin(item: boolean): void;
	/** A compaction committed; `details` reads its entry's details (the context it left). Whether it was this feature's. */
	compacted(details: () => unknown): boolean;
	/** A compaction failed or was cancelled. */
	failed(): void;
	reset(): void;
}

const NOOP: CompactOnDone = {
	turnEnd: () => undefined,
	begin: () => undefined,
	compacted: () => false,
	failed: () => undefined,
	reset: () => undefined,
};

/**
 * Compaction at a finished backlog item (main session only). A `done` is noted when it commits; at the turn's end the
 * history (the context less the system prompt and tool declarations) must be at least the `backlog.compactOnDone`
 * share of the room before automatic compaction, and the compaction must pay (`done-gain.ts`): the history it frees,
 * read by the requests this session still expects for its own open items, against the summary it costs. It then runs at
 * the item boundary, before the run's next model request, while work remains for this session; with nothing left it
 * runs when the reply ends, only when the context is nearly full. Several items done in one turn are focused together.
 * The compact tool's thrash and cooldown refusals apply silently. Each decision is recorded in the session.
 */
export function registerCompactOnDone(
	api: OnDoneApi,
	requests: CompactRequests,
	isSubagent: boolean,
	/** Whether the provider reads this session's prefix from a cache. */
	cached: (ctx: FeatureContext) => boolean,
): CompactOnDone {
	if (isSubagent) return NOOP;
	let done: BacklogDone[] = [];
	/** Turns this session made for each of its latest finished items. */
	let perItem: number[] = [];
	let turns = 0;
	let decision: Decision | undefined;
	/** The compaction running was asked for at a finished item. */
	let asked = false;
	api.channels.on(BACKLOG_DONE_CHANNEL, (value) => {
		done.push(value as BacklogDone);
	});
	const flush = (outcome: string, tokensAfter?: number) => {
		if (!decision) return;
		const { reason, measures } = decision;
		decision = undefined;
		recordCompactionNote(api, "done-compaction", reason, {
			...measures,
			outcome,
			...(tokensAfter === undefined ? {} : { tokensAfter }),
		});
	};
	const skip = (reason: string, measures: Decision["measures"]) => {
		decision = { reason, measures };
		flush("skipped");
	};
	return {
		turnEnd(ctx) {
			turns += 1;
			const finished = done;
			done = [];
			if (finished.length === 0) return;
			// A request of an earlier decision that never ran (its run ended stopped) is closed first.
			flush("dropped");
			perItem = [...perItem, ...finished.map(() => Math.max(1, turns / finished.length))].slice(-RECENT_ITEMS);
			turns = 0;
			const floor = api.settings.get().backlog?.compactOnDone ?? SETTINGS_DEFAULTS.backlog.compactOnDone;
			if (!(floor > 0)) return;
			const latest = finished[finished.length - 1];
			const open = latest.open;
			if (requests.pending) return skip("an agent compact request is queued", {});
			const refusal = requests.refusal(api, ctx, 0);
			if (refusal) return skip(refusal, {});
			const model = ctx.model as Model<Api> | undefined;
			const tokens = contextTokens(ctx, toolDefinitionChars(api));
			if (!model || tokens === undefined) return skip("the context size is unknown", {});
			const fixedTokens = charsToTokens(ctx.getSystemPrompt().length + toolDefinitionChars(api), model);
			const limits = limitsFor(api, model).compaction;
			const thinking = compactionThinking(api);
			const limit = autoCompactAt(model, thinking, limits);
			const average = averageRequestsPerItem(perItem);
			const expected = expectedRequests(average, latest.remaining);
			const gain = doneGain({
				tokens,
				fixedTokens,
				keepTokens: builtInCompactionSettings(model, thinking, limits).keepRecentTokens,
				cached: cached(ctx),
				cost: model.cost ? activeRates(model.cost) : undefined,
				expectedRequests: expected,
			});
			const share = gain.historyTokens / Math.max(1, limit);
			const measures = {
				tokens,
				historyTokens: gain.historyTokens,
				freed: gain.freed,
				estCost: Math.round(gain.estCost) / 1e6,
				estSaving: Math.round(gain.estSaving) / 1e6,
				// USD when the model states its input price; else millions of input-token equivalents (the fallback prices).
				costUnit: model.cost && model.cost.input > 0 ? "usd" : "million-input-tokens",
				expectedRequests: expected,
			};
			// The floor on the history's share limits how often this runs; with nothing left to do only a nearly full context does.
			const needed = open ? floor : Math.max(floor, COMPACT_MIN_SHARE);
			if (share < needed)
				return skip(
					`the history is ${Math.floor(share * 100)}% of the room, below ${Math.round(needed * 100)}%`,
					measures,
				);
			if (open && !gain.pays) return skip("the requests still expected do not repay the summary", measures);
			// The newest item last: a joined focus over the limit keeps the newest ones.
			const focus = finished
				.map(({ ref, summary }) => `${ref}: ${summary}`)
				.join("\n")
				.slice(-MAX_COMPACTION_INSTRUCTIONS);
			decision = { reason: open ? "at the item boundary" : "when the reply ends", measures };
			// Runs before the run's next request, if it makes one (the model goes on by itself, so no resume is needed); a run
			// that ends first compacts when it settles and resumes only while this session has work left.
			requests.request(focus, open, true);
			if (open) ctx.requestBoundaryCompaction({ customInstructions: focus, requestedBy: "item" });
		},
		begin: (item) => {
			asked = item;
		},
		compacted: (details) => {
			const item = asked;
			asked = false;
			const after = item ? asRecord(details()).estimatedTokensAfter : undefined;
			if (item) flush("compacted", typeof after === "number" ? after : undefined);
			return item;
		},
		failed: () => {
			if (asked) flush("failed");
			asked = false;
		},
		reset() {
			flush("dropped");
			done = [];
			perItem = [];
			turns = 0;
		},
	};
}
