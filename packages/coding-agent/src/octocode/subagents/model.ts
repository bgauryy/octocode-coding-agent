import { activeRates } from "@octocodeai/octocode-ai";
import { clampThinkingLevel } from "@octocodeai/octocode-ai/compat";
import { DAY_MS } from "../shared/util.ts";
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
type ModelTier = (typeof MODEL_TIERS)[number];
export const isModelTier = (value: string): value is ModelTier => (MODEL_TIERS as readonly string[]).includes(value);

/**
 * The purpose of a child whose call names no model and no profile. Not the parent's: the coordinator's model is usually
 * the dearest, and a worker needs only the tier its task needs (user request, 2026-11-03: an Opus coordinator sends work
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
		context: ref.contextWindow || known?.context,
		input: ref.input ?? known?.input,
		toolCall: known?.toolCall,
		family: known?.family,
		released: known?.released,
		deprecated: known?.status === "deprecated",
		lab: known?.lab ?? (slash > 0 ? ref.id.slice(0, slash) : undefined),
	};
}

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
 * between `MEDIUM_MIN_SHARE` and `MEDIUM_MAX_SHARE` of the parent's price.
 */
export function resolveTier(
	tier: ModelTier,
	available: readonly ModelRef[],
	parent: ModelRef | undefined,
	catalog?: Catalog,
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
		.filter(
			(model) =>
				!model.deprecated &&
				model.toolCall !== false &&
				(model.context === undefined || model.context >= MIN_SUBAGENT_CONTEXT),
		)
		.filter((model) => !needsImages || model.input === undefined || model.input.includes("image"));
	const eligible = currentGeneration(
		capable.filter((model) => model.price !== undefined && model.price < top.price!),
		[...capable, top],
	);
	const parentReleased = time(top.released);
	const recent = Number.isNaN(parentReleased)
		? eligible
		: eligible.filter(
				(model) => Number.isNaN(time(model.released)) || time(model.released) >= parentReleased - STALE_AFTER_MS,
			);
	const fresh = recent.length > 0 ? recent : eligible;
	const sameLab = top.lab ? fresh.filter((model) => model.lab === top.lab) : [];
	const sameProvider = fresh.filter((model) => model.ref.provider === own.provider);
	const ownLab = sameProvider.filter((model) => sameLab.includes(model));
	const pool = firstNonEmpty(ownLab, sameProvider, sameLab, fresh).sort((a, b) => a.price! - b.price!);
	if (tier === "small") return pool[0]?.ref;
	const band = pool.filter(
		(model) => model.price! <= top.price! * MEDIUM_MAX_SHARE && model.price! >= top.price! * MEDIUM_MIN_SHARE,
	);
	return band.at(-1)?.ref;
}

/** The `:<level>` suffixes Octocode's `--model <pattern>` accepts. */
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** The `:<level>` suffix a model value or purpose ends with (`:low`), or "" without one. */
function thinkingSuffix(value: string | undefined): string {
	const colon = value ? value.lastIndexOf(":") : -1;
	return value && colon > 0 && THINKING_LEVELS.has(value.slice(colon + 1)) ? value.slice(colon) : "";
}

/** Thinking level of a child whose call and profile name none. */
export const SUBAGENT_THINKING_ENV = "OCTOCODE_SUBAGENT_THINKING";

/**
 * A child's level when neither its call nor its profile names one. Never the parent's: the coordinator thinks hard and
 * a worker spends only what its task needs, so the user's `defaultThinkingLevel` (the coordinator's) does not reach it.
 */
export const SUBAGENT_DEFAULT_THINKING = "medium";

/** The level `OCTOCODE_SUBAGENT_THINKING` names, else `SUBAGENT_DEFAULT_THINKING` (a value that is not a level is ignored). */
export function subagentThinking(env: NodeJS.ProcessEnv = process.env): string {
	const value = env[SUBAGENT_THINKING_ENV]?.trim().toLowerCase();
	return value && THINKING_LEVELS.has(value) ? value : SUBAGENT_DEFAULT_THINKING;
}

/** A route's `:thinking` level (`low` in `p/m:low`), or undefined without one. */
const routeThinking = (model: string | undefined): string | undefined => thinkingSuffix(model).slice(1) || undefined;

/** The route with its level replaced by `level`. */
const withThinking = (model: string, level: string): string =>
	`${model.slice(0, model.length - thinkingSuffix(model).length)}:${level}`;

/**
 * The route at the level the child will run at: a registry model without that level (no reasoning, no `xhigh`) clamps it
 * as the child's session does, so what the coordinator is told is what runs.
 */
export function supportedThinking(model: string, available: readonly ModelRef[]): string {
	const level = routeThinking(model);
	const target = routedModel(model, available) as Parameters<typeof clampThinkingLevel>[0] | undefined;
	if (!level || !target) return model;
	const clamped = clampThinkingLevel(target, level as Parameters<typeof clampThinkingLevel>[1]);
	return clamped === level ? model : withThinking(model, clamped);
}

/** A route as the coordinator reads it: `provider/id, low thinking`. */
function routeText(model: string | undefined): string {
	if (!model) return "this session's model";
	const level = routeThinking(model);
	return level ? `${model.slice(0, model.length - level.length - 1)}, ${level} thinking` : model;
}

/** A run's route and what chose it: `p/m, low thinking (profile researcher: small:low)`. */
export function routeSummary(route: { model?: string; via?: string; fallback?: string; refusedBy?: string }): string {
	const why = route.via ?? (route.fallback ? fallbackNote(route.fallback, route.refusedBy) : "this session's model");
	return `${routeText(route.model)} (${why})`;
}

/**
 * Which model a subagent runs on. `model` goes to `--model`; `fallback` names the profile's preferred model when it is
 * unavailable (the child then runs on the parent's model), and `refusedBy` its provider when that provider is configured
 * but refused its credential recently; `error` refuses an explicit request. `thinking` is the level of a route with no
 * model to suffix (this session has none): the child starts with `--thinking`.
 */
export type ModelRoute =
	| { model?: string; thinking?: string; fallback?: string; refusedBy?: string }
	| { error: string };

/** Why a profile's preferred model was not used: `p/m unavailable`, or `p/m: p refused its credential`. */
export const fallbackNote = (fallback: string, refusedBy?: string): string =>
	refusedBy ? `${fallback}: ${refusedBy} refused its credential` : `${fallback} unavailable`;

/** A route without its provider: `claude-haiku-5-5:low` for `anthropic/claude-haiku-5-5:low`. */
export const withoutProvider = (model: string | undefined): string | undefined =>
	model?.slice(model.lastIndexOf("/") + 1);

/** The model a run is on without its provider (`claude-haiku-5-5:low`), with why it is the parent's when the profile's preference was not used. */
export function modelLabel(details: { model?: string; fallback?: string; refusedBy?: string }): string {
	const model = withoutProvider(details.model);
	return details.fallback
		? `${model ?? "parent model"} (${fallbackNote(details.fallback, details.refusedBy)})`
		: (model ?? "");
}

/** The models a purpose or a preferred model may route to: those of a provider that refused its credential are skipped, except the parent's own. */
export const usableModels = <T extends ModelRef>(
	available: readonly T[],
	parent: ModelRef | undefined,
	refused: ((provider: string) => boolean) | undefined,
): readonly T[] =>
	refused ? available.filter((model) => model.provider === parent?.provider || !refused(model.provider)) : available;

/** `provider/id` (plus any `:thinking` suffix) for a requested `provider/id` or bare id, or undefined when no available model matches. */
export function resolveModel(
	requested: string,
	available: readonly ModelRef[],
	parentProvider?: string,
): string | undefined {
	const colon = requested.lastIndexOf(":");
	const suffix = colon > 0 && THINKING_LEVELS.has(requested.slice(colon + 1)) ? requested.slice(colon) : "";
	// The whole text first: a model id may itself contain a colon.
	for (const [base, thinking] of [[requested, ""], ...(suffix ? [[requested.slice(0, colon), suffix]] : [])] as Array<
		[string, string]
	>) {
		const qualified = available.find((model) => `${model.provider}/${model.id}` === base);
		const bare = available.filter((model) => model.id === base);
		const found = qualified ?? bare.find((model) => model.provider === parentProvider) ?? bare[0];
		if (found) return `${found.provider}/${found.id}${thinking}`;
	}
	return undefined;
}

/** Available `provider/id` values that share name parts with the request, best first. */
export function closeModels(requested: string, available: readonly ModelRef[], limit = 8): string[] {
	const parts = (text: string) =>
		text
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter(Boolean);
	const wanted = new Set(parts(requested));
	const ranked = available
		.map((model, index) => ({
			name: `${model.provider}/${model.id}`,
			index,
			score: parts(`${model.provider}/${model.id}`).filter((part) => wanted.has(part)).length,
		}))
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score || a.index - b.index);
	return [...new Set(ranked.map((entry) => entry.name))].slice(0, limit);
}

interface RouteInput {
	explicit?: string | undefined;
	preferred?: string | undefined;
	available: readonly ModelRef[];
	parent?: ModelRef | undefined;
	catalog?: Catalog | undefined;
	/**
	 * Providers whose credential was just refused (`ProviderHealth.refused`): a purpose or a profile's preferred model
	 * skips them; an explicit model and the parent's own provider (its session proves the credential) are kept.
	 */
	refused?: ((provider: string) => boolean) | undefined;
	/** Level for a route whose call and profile carry no `:thinking` suffix (`subagentThinking()`). */
	thinking?: string | undefined;
}

/** The listed model a route's `provider/id[:thinking]` names, or undefined without a route or a listed match. */
export function routedModel<T extends ModelRef>(route: string | undefined, models: readonly T[]): T | undefined {
	if (!route) return undefined;
	const colon = route.lastIndexOf(":");
	const bases = colon > 0 && THINKING_LEVELS.has(route.slice(colon + 1)) ? [route, route.slice(0, colon)] : [route];
	for (const base of bases) {
		const found = models.find((model) => `${model.provider}/${model.id}` === base);
		if (found) return found;
	}
	return undefined;
}

/** A purpose with an optional `:<thinking>` suffix (`small:high`), or undefined for a model id. */
function tierOf(value: string): { tier: ModelTier; thinking: string } | undefined {
	const at = value.lastIndexOf(":");
	const name = at > 0 && THINKING_LEVELS.has(value.slice(at + 1)) ? value.slice(0, at) : value;
	return isModelTier(name) ? { tier: name, thinking: value.slice(name.length) } : undefined;
}

/** A purpose's route: its model with the suffix kept, else the parent's (with no cheaper candidate it is the right one). */
function tierRoute(
	{ tier, thinking }: { tier: ModelTier; thinking: string },
	input: RouteInput,
	parentModel: { model?: string },
): ModelRoute {
	const chosen = resolveTier(tier, input.available, input.parent, input.catalog);
	if (chosen) return { model: `${chosen.provider}/${chosen.id}${thinking}` };
	return parentModel.model ? { model: `${parentModel.model}${thinking}` } : {};
}

/**
 * The route of a child, with its thinking level: the call's `:thinking` suffix, else the profile's (a role's effort holds
 * on whichever model the call picks), else `input.thinking` (`subagentThinking()`), never the parent's current level.
 * A route with no model (the session has none) carries the level as `thinking`, from a purpose's suffix, the profile's, or the default.
 */
export function routeModel(input: RouteInput): ModelRoute {
	const route = routeWithoutThinking(input);
	if ("error" in route) return route;
	if (route.model && thinkingSuffix(route.model)) return route;
	const thinking =
		(route.model ? "" : thinkingSuffix(input.explicit)) ||
		thinkingSuffix(input.preferred) ||
		(input.thinking ? `:${input.thinking}` : "");
	if (!thinking) return route;
	return route.model ? { ...route, model: `${route.model}${thinking}` } : { ...route, thinking: thinking.slice(1) };
}

function routeWithoutThinking(input: RouteInput): ModelRoute {
	const { explicit, preferred, parent, refused } = input;
	const usable = usableModels(input.available, parent, refused);
	const all = input.available;
	// Only an explicit model id is strict: it may name a refused provider on purpose.
	const available = explicit && !tierOf(explicit) ? input.available : usable;
	input = { ...input, available };
	const parentProvider = parent?.provider;
	// Pinned explicitly: without --model the child would start on Octocode's default, not the model the parent runs on now.
	const parentModel = parent ? { model: `${parent.provider}/${parent.id}` } : {};
	if (explicit) {
		const tier = tierOf(explicit);
		if (tier) return tierRoute(tier, input, parentModel);
		const model = resolveModel(explicit, available, parentProvider);
		if (model) return { model };
		const close = closeModels(explicit, available);
		const names = [...new Set(available.map((candidate) => `${candidate.provider}/${candidate.id}`))];
		const hint =
			close.length > 0
				? `Close matches: ${close.join(", ")}`
				: names.length > 0
					? `Available: ${names.slice(0, 8).join(", ")}${names.length > 8 ? ", …" : ""}`
					: "No models are configured";
		return { error: `Model "${explicit}" is not available. ${hint}` };
	}
	if (!preferred) return parentModel;
	// A purpose resolves among the user's models; with no cheaper candidate the parent's model is the right one.
	const tier = tierOf(preferred);
	if (tier) return tierRoute(tier, input, parentModel);
	const model = resolveModel(preferred, available, parentProvider);
	if (model) return { model };
	const skipped = refused ? resolveModel(preferred, all, parentProvider) : undefined;
	return {
		...parentModel,
		fallback: preferred,
		...(skipped ? { refusedBy: skipped.slice(0, skipped.indexOf("/")) } : {}),
	};
}
