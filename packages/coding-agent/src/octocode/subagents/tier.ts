import { activeRates } from "@octocodeai/octocode-ai";
import { DAY_MS } from "../shared/util.ts";
import { formatTokens } from "../shared/format.ts";
import { type Catalog, listedCost, lookup } from "./catalog.ts";

/** A model the parent can use, as Octocode's model registry lists it (prices per million tokens). */
export interface ModelRef {
	provider: string;
	id: string;
	/** A time-limited price also carries its last day (`until`) and the rates that follow it (`after`). */
	cost?: { input: number; output: number; until?: string; after?: { input: number; output: number } };
	contextWindow?: number;
	input?: readonly string[];
}

/** The input and output rates in effect at `now` (`activeRates`): a time-limited price gives way to its `after` rates. */
export function currentPrice(
	cost: ModelRef["cost"],
	now: Date | number = Date.now(),
): { input: number; output: number } | undefined {
	if (!cost) return undefined;
	const rates = ({ input, output }: { input: number; output: number }) => ({
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
	});
	return activeRates(
		{
			...rates(cost),
			...(cost.until !== undefined ? { until: cost.until } : {}),
			...(cost.after ? { after: rates(cost.after) } : {}),
		},
		now,
	);
}

/**
 * Purposes a profile can name instead of a model id: `small` is the cheapest capable model the parent can use (search,
 * reading, documentation checks, browsing), `medium` the next tier below the parent's (coding and review when the
 * parent runs a frontier model). Each resolves among the user's own models, so no profile hard-codes a vendor.
 */
export const MODEL_TIERS = ["small", "medium"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];
export const isModelTier = (value: string): value is ModelTier => (MODEL_TIERS as readonly string[]).includes(value);

/**
 * The purpose of a child whose call names no model and no profile. Not the parent's: the coordinator's model is usually
 * the dearest, and a worker needs only the tier its task needs (an Opus coordinator sends work
 * to Sonnet). With no capable model in the band, the purpose falls back to the parent's model. A profile without a
 * model keeps the parent's (a plugin agent's `model: inherit`).
 */
export const SUBAGENT_DEFAULT_TIER: ModelTier = "medium";

/** A subagent starts fresh but reads files and tool output: a model with a smaller window is not a candidate. */
const MIN_SUBAGENT_CONTEXT = 100_000;

interface Facts {
	ref: ModelRef;
	price: number | undefined;
	context: number | undefined;
	input: readonly string[] | undefined;
	toolCall: boolean | undefined;
	family: string | undefined;
	released: string | undefined;
	deprecated: boolean;
	lab: string | undefined;
}

/**
 * `medium` is the next tier down: between these shares of the parent's price (Sonnet is half of Opus; Haiku, a
 * twentieth, is the small tier, not a coder for an Opus or Sonnet parent).
 */
const MEDIUM_MAX_SHARE = 0.8;
const MEDIUM_MIN_SHARE = 0.15;
/** Candidates released this long before the parent are an older generation, used only when nothing newer qualifies. */
const STALE_AFTER_MS = 548 * DAY_MS;

/** Octocode's metadata, with what it lacks from models.dev. Price: three input tokens to one output, as agent turns spend. */
function facts(ref: ModelRef, catalog: Catalog | undefined): Facts {
	const known = lookup(catalog, ref.provider, ref.id);
	const own = currentPrice(ref.cost);
	const cost = own && own.input + own.output > 0 ? own : listedCost(catalog, ref.provider, ref.id);
	// An id like `anthropic/claude-x` (a router's) names its lab when models.dev does not.
	const slash = ref.id.indexOf("/");
	return {
		ref,
		price: cost && cost.input + cost.output > 0 ? (3 * cost.input + cost.output) / 4 : undefined,
		context: ref.contextWindow !== undefined && ref.contextWindow !== 0 ? ref.contextWindow : known?.context,
		input: ref.input ?? known?.input,
		toolCall: known?.toolCall,
		family: known?.family,
		released: known?.released,
		deprecated: known?.status === "deprecated",
		lab: known?.lab ?? (slash > 0 ? ref.id.slice(0, slash) : undefined),
	};
}

/**
 * Why a model cannot run a subagent's task, or undefined when it can (or when nothing known says otherwise): a model
 * absent from the catalog stays allowed. Purposes and explicit ids share this rule.
 */
export function taskBlocker(model: ModelRef, catalog: Catalog | undefined): string | undefined {
	const known = facts(model, catalog);
	const reasons = [
		...(known.deprecated ? ["deprecated"] : []),
		...(known.toolCall === false ? ["no tool calls"] : []),
		...(known.context !== undefined && known.context < MIN_SUBAGENT_CONTEXT
			? [`context ${formatTokens(known.context)} (needs ${formatTokens(MIN_SUBAGENT_CONTEXT)})`]
			: []),
	];
	return reasons.length > 0 ? reasons.join(", ") : undefined;
}

/** Whether a task can run on `model`: not deprecated, tool calls not known to be missing, a window of `MIN_SUBAGENT_CONTEXT` when known. */
export const canRunTask = (model: ModelRef, catalog: Catalog | undefined): boolean =>
	taskBlocker(model, catalog) === undefined;

const time = (date: string | undefined) => (date ? Date.parse(date) : NaN);

/**
 * Only each family's newest release among `all` (the parent included: an older sibling of the parent's own family is
 * an older generation); a router lists every generation and alias. Models without a family or date stay.
 */
function currentGeneration(models: Facts[], all: Facts[]): Facts[] {
	const newest = new Map<string, number>();
	for (const model of all)
		if (model.family && !Number.isNaN(time(model.released)))
			newest.set(model.family, Math.max(newest.get(model.family) ?? -Infinity, time(model.released)));
	return models.filter(
		(model) => !model.family || !newest.has(model.family) || time(model.released) === newest.get(model.family),
	);
}

/** The first non-empty group: candidates nearest the parent come first. */
const firstNonEmpty = (...groups: Facts[][]): Facts[] => groups.find((group) => group.length > 0) ?? [];

/**
 * The model a tier resolves to among `available`, or undefined to stay on the parent's. Works for any list: one model,
 * a few, or a router's hundreds. Candidates call tools, hold `MIN_SUBAGENT_CONTEXT`, take images when the parent does,
 * are not deprecated, cost less than the parent, and are their family's current generation; ones not much older than
 * the parent come first. The parent's provider ranks before its lab: only that provider's auth and endpoint are proven
 * (another provider counts as available once a key is configured, even an expired one). So the order is the parent's
 * provider and lab, its provider, its lab elsewhere, then anything. `small` is the cheapest; `medium` the dearest
 * between `MEDIUM_MIN_SHARE` and `MEDIUM_MAX_SHARE` of the parent's price. A model the user's plan pays for costs
 * nothing more per request, so it qualifies whatever its list price and a capable one is chosen before any metered
 * model (its list price still places it in a tier); a background child leaves out plans that forbid unattended use.
 */
export function resolveTier(
	tier: ModelTier,
	available: readonly ModelRef[],
	parent: ModelRef | undefined,
	catalog?: Catalog,
	billing: TierBilling = {},
): ModelRef | undefined {
	if (!parent) return undefined;
	const own = available.find((model) => model.provider === parent.provider && model.id === parent.id) ?? parent;
	const top = facts(own, catalog);
	if (top.price === undefined) return undefined;
	const needsImages = top.input?.includes("image") === true;
	// A family's newest release is judged among the models able to do the work (and the parent): an unusable newer
	// sibling (no tool calls, a small window) does not push the usable ones out.
	const capable = available
		.map((model) => facts(model, catalog))
		.filter((model) => !(model.ref.provider === own.provider && model.ref.id === own.id))
		.filter((model) => canRunTask(model.ref, catalog))
		.filter((model) => !needsImages || model.input === undefined || model.input.includes("image"))
		.filter((model) => !billing.background || billing.unattended?.(model.ref.provider) !== false);
	const onPlan = (model: Facts) => billing.plan?.(model.ref.provider) === true;
	const cheaper = (model: Facts) => model.price !== undefined && model.price < top.price!;
	const eligible = currentGeneration(
		capable.filter((model) => model.price !== undefined && (cheaper(model) || onPlan(model))),
		[...capable, top],
	);
	const parentReleased = time(top.released);
	const recent = Number.isNaN(parentReleased)
		? eligible
		: eligible.filter(
				(model) => Number.isNaN(time(model.released)) || time(model.released) >= parentReleased - STALE_AFTER_MS,
			);
	const fresh = recent.length > 0 ? recent : eligible;
	const choose = (candidates: Facts[]): ModelRef | undefined => {
		const sameLab = top.lab ? candidates.filter((model) => model.lab === top.lab) : [];
		const sameProvider = candidates.filter((model) => model.ref.provider === own.provider);
		const ownLab = sameProvider.filter((model) => sameLab.includes(model));
		const pool = firstNonEmpty(ownLab, sameProvider, sameLab, candidates).sort((a, b) => a.price! - b.price!);
		if (tier === "small") return pool[0]?.ref;
		const band = pool.filter(
			(model) => model.price! <= top.price! * MEDIUM_MAX_SHARE && model.price! >= top.price! * MEDIUM_MIN_SHARE,
		);
		return band.at(-1)?.ref;
	};
	const planned = fresh.filter(onPlan);
	return (planned.length > 0 ? choose(planned) : undefined) ?? choose(fresh.filter(cheaper));
}

/** What routing knows of each provider's billing (`ModelRegistry.getProviderBilling`, `allowsUnattendedUse`). */
export interface TierBilling {
	/** The user's plan pays for this provider's requests. */
	plan?: (provider: string) => boolean;
	/** False for a provider whose plan forbids unattended use; asked only for a background child. */
	unattended?: (provider: string) => boolean;
	background?: boolean;
}
