import type { ProviderPlan } from "@octocodeai/octocode-ai";
import { clampThinkingLevel } from "@octocodeai/octocode-ai/compat";
import type { Catalog } from "./catalog.ts";
import { closeModels } from "./close-models.ts";
import { type ConfiguredModels, settingKey } from "./configured-models.ts";
import { routeThinking, THINKING_LEVELS, thinkingSuffix, withThinking } from "../render/route-thinking.ts";
import { SUBAGENT_DEFAULT_THINKING, SUBAGENT_THINKING_ENV, subagentThinking } from "./thinking.ts";
import {
	isModelTier,
	type ModelRef,
	type ModelTier,
	resolveTier,
	resolveTierChoice,
	type TierBilling,
} from "./tier.ts";

export {
	currentPrice,
	hasPrice,
	isModelTier,
	MODEL_TIERS,
	type ModelRef,
	resolveTier,
	resolveTierChoice,
	SUBAGENT_DEFAULT_TIER,
	canRunTask,
	taskBlocker,
	type TierBilling,
} from "./tier.ts";
export { SUBAGENT_DEFAULT_THINKING, SUBAGENT_THINKING_ENV, subagentThinking };

/** A registry's billing facts as routing reads them; no registry bills nothing by plan. */
export const registryBilling = (
	registry:
		| {
				getProviderBilling(provider: string, scope?: "child"): ProviderPlan["billing"];
				allowsUnattendedUse(provider: string): boolean;
		  }
		| undefined,
	background = false,
): TierBilling => ({
	plan: (provider) => registry?.getProviderBilling(provider, "child") === "plan",
	unattended: (provider) => registry?.allowsUnattendedUse(provider) !== false,
	background,
});

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

/**
 * Why a route runs at another level than asked, from the route before and after `supportedThinking`'s clamp: `asked off;
 * this model does not support off`. Empty when the levels agree or either has none.
 */
export function clampNote(requested: string | undefined, applied: string | undefined): string {
	const asked = routeThinking(requested);
	return asked && routeThinking(applied) !== asked ? `asked ${asked}; this model does not support ${asked}` : "";
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
	| {
			model?: string;
			thinking?: string;
			fallback?: string;
			refusedBy?: string;
			setting?: string;
			skipped?: string;
			/** The purpose's model rests on a size-class guess (the parent has no price), not on prices. */
			guessed?: boolean;
			/** `provider/id[:thinking]` of the next routed models on other providers: the child's `retry.fallbackModels`. */
			fallbackModels?: string[];
	  }
	| { error: string };

/** Why a profile's preferred model was not used: `p/m unavailable`, or `p/m: p refused its credential`. */
export const fallbackNote = (fallback: string, refusedBy?: string): string =>
	refusedBy ? `${fallback}: ${refusedBy} refused its credential` : `${fallback} unavailable`;

/** What chose a purpose's model, for a route line: a setting, a skipped setting or a size-class guess; empty otherwise. */
export const routeSource = (route: { setting?: string; skipped?: string; guessed?: boolean }): string =>
	route.setting
		? `setting ${route.setting}`
		: route.skipped
			? `automatic; ${route.skipped}`
			: route.guessed
				? "automatic; size guess, price unknown"
				: "";

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

/** `ProviderHealth.refused`: the model, or unless `proven` its provider's credential (funds: only if `cost` is not free). */
export type Refused = (provider: string, id?: string, proven?: boolean, cost?: ModelRef["cost"]) => boolean;
/** The models a purpose or a preferred model may route to: refused ones are skipped, the parent's own never (it runs). */
export const usableModels = <T extends ModelRef>(
	available: readonly T[],
	parent: ModelRef | undefined,
	refused: Refused | undefined,
): readonly T[] =>
	refused
		? available.filter(
				(model) =>
					(model.provider === parent?.provider && model.id === parent.id) ||
					!refused(model.provider, model.id, model.provider === parent?.provider, model.cost),
			)
		: available;

/** `provider/id` (plus any `:thinking` suffix) for a requested `provider/id` or bare id, or undefined when no available model matches. */
export function resolveModel(
	requested: string,
	available: readonly ModelRef[],
	parentProvider?: string,
): string | undefined {
	return modelChoice(requested, available, parentProvider)?.model;
}

/** Preserve preference routing while exposing ambiguity to strict, explicit task requests. */
function modelChoice(
	requested: string,
	available: readonly ModelRef[],
	parentProvider?: string,
): { model: string; alternatives?: string[] } | undefined {
	const colon = requested.lastIndexOf(":");
	const suffix = colon > 0 && THINKING_LEVELS.has(requested.slice(colon + 1)) ? requested.slice(colon) : "";
	// The whole text first: a model id may itself contain a colon.
	for (const [base, thinking] of [[requested, ""], ...(suffix ? [[requested.slice(0, colon), suffix]] : [])] as Array<
		[string, string]
	>) {
		const qualified = available.find((model) => `${model.provider}/${model.id}` === base);
		const bare = available.filter((model) => model.id === base);
		const parent = bare.find((model) => model.provider === parentProvider);
		const found = qualified ?? parent ?? bare[0];
		if (found)
			return {
				model: `${found.provider}/${found.id}${thinking}`,
				...(!qualified && !parent && bare.length > 1
					? { alternatives: bare.map((model) => `${model.provider}/${model.id}${thinking}`) }
					: {}),
			};
	}
	return undefined;
}

export { closeModels };

interface RouteInput {
	explicit?: string | undefined;
	preferred?: string | undefined;
	available: readonly ModelRef[];
	parent?: ModelRef | undefined;
	catalog?: Catalog | undefined;
	/** Just refused (`usableModels`): a purpose or preferred model skips it; an explicit model is kept. */
	refused?: Refused | undefined;
	/** The `subagents.models` setting (`configured-models.ts`): a purpose uses its model before the automatic choice. */
	configured?: ConfiguredModels | undefined;
	/** Level for a route whose call and profile carry no `:thinking` suffix (`subagentThinking()`). */
	thinking?: string | undefined;
	/** Plan-billed providers a purpose prefers, and the unattended facts a background child's purpose respects. */
	billing?: TierBilling | undefined;
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

/**
 * The model the user set for a purpose (`subagents.models`), with its own `:level`, or why it is not used: not available,
 * its provider refused its credential (`usable` leaves it out), or it cannot run a task.
 */
function configuredRoute(
	tier: ModelTier,
	input: RouteInput,
	usable: readonly ModelRef[],
): { model: string } | { skipped: string } | undefined {
	const value = input.configured?.[tier];
	if (!value) return undefined;
	const provider = input.parent?.provider;
	const found = resolveModel(value, usable, provider);
	if (found) return { model: found };
	const named = resolveModel(value, input.available, provider);
	const listed = routedModel(named, input.available);
	const base = listed ? `${listed.provider}/${listed.id}` : value;
	const why = listed ? `: ${listed.provider} refused its credential` : " unavailable";
	return { skipped: `${settingKey(tier)} ${base}${why}` };
}

/**
 * A purpose's route: the user's setting when usable, else the automatic choice, else the parent's (with no cheaper
 * candidate it is the right one). The purpose's own suffix (`small:high`) outranks the setting's level.
 */
function tierRoute(
	{ tier, thinking }: { tier: ModelTier; thinking: string },
	input: RouteInput,
	usable: readonly ModelRef[],
	parentModel: { model?: string },
): ModelRoute {
	const set = configuredRoute(tier, input, usable);
	if (set && "model" in set) {
		const level = thinking || thinkingSuffix(set.model);
		return {
			model: `${set.model.slice(0, set.model.length - thinkingSuffix(set.model).length)}${level}`,
			setting: settingKey(tier),
		};
	}
	const note = set ? { skipped: set.skipped } : {};
	const { model: chosen, guessed } = resolveTierChoice(tier, usable, input.parent, input.catalog, input.billing);
	if (chosen) return { model: `${chosen.provider}/${chosen.id}${thinking}`, ...(guessed ? { guessed } : {}), ...note };
	const { billing, parent } = input;
	// The parent's model is an automatic route too: a background child is not sent to a plan the vendor keeps attended.
	if (parent && billing?.background && billing.unattended?.(parent.provider) === false)
		return {
			error: `${parent.provider}'s plan does not allow unattended use, so a background task is not routed to it automatically. Name a model with \`model\`, or run the task in the foreground.`,
		};
	return parentModel.model ? { model: `${parentModel.model}${thinking}`, ...note } : note;
}

/**
 * The route of a child, with its thinking level: the call's `:thinking` suffix, else the profile's (a role's effort holds
 * on whichever model the call picks), else `input.thinking` (`subagentThinking()`), never the parent's current level.
 * A route with no model (the session has none) carries the level as `thinking`, from a purpose's suffix, the profile's, or the default.
 */
export function routeModel(input: RouteInput): ModelRoute {
	return withFallbackModels(input, withThinkingLevel(input, routeWithoutThinking(input)));
}

/** The route with the child's thinking level (`routeModel`). */
function withThinkingLevel(input: RouteInput, route: ModelRoute): ModelRoute {
	if ("error" in route) return route;
	if (route.model && thinkingSuffix(route.model)) return route;
	const thinking =
		(route.model ? "" : thinkingSuffix(input.explicit)) ||
		thinkingSuffix(input.preferred) ||
		(input.thinking ? `:${input.thinking}` : "");
	if (!thinking) return route;
	return route.model ? { ...route, model: `${route.model}${thinking}` } : { ...route, thinking: thinking.slice(1) };
}

/** Models a child may continue on after a refused credential or a limit: at most this many, each on its own provider. */
const MAX_FALLBACK_MODELS = 2;

/**
 * The route plus the child's `retry.fallbackModels`: when a purpose (not a named model) chose the model, the next
 * models the same purpose resolves to among other providers' usable models, so a provider that refuses the child's
 * credential does not end its turn. A named model, the parent's own and a profile's own model get none.
 */
function withFallbackModels(input: RouteInput, route: ModelRoute): ModelRoute {
	const asked = input.explicit ?? input.preferred;
	const tier = asked ? tierOf(asked) : undefined;
	if ("error" in route || !route.model || !tier) return route;
	const level = thinkingSuffix(route.model);
	const skip = new Set([route.model.slice(0, route.model.indexOf("/"))]);
	const usable = usableModels(input.available, input.parent, input.refused);
	const next: string[] = [];
	while (next.length < MAX_FALLBACK_MODELS) {
		const pool = usable.filter((model) => !skip.has(model.provider));
		const found = resolveTier(tier.tier, pool, input.parent, input.catalog, input.billing);
		if (!found) break;
		skip.add(found.provider);
		next.push(supportedThinking(`${found.provider}/${found.id}${level}`, input.available));
	}
	return next.length > 0 ? { ...route, fallbackModels: next } : route;
}

function routeWithoutThinking(request: RouteInput): ModelRoute {
	const { explicit, preferred, parent, refused } = request;
	const usable = usableModels(request.available, parent, refused);
	const all = request.available;
	// Only an explicit model id is strict: it may name a refused provider on purpose.
	const available = explicit && !tierOf(explicit) ? request.available : usable;
	const parentProvider = parent?.provider;
	// Pinned explicitly: without --model the child would start on Octocode's default, not the model the parent runs on now.
	const parentModel = parent ? { model: `${parent.provider}/${parent.id}` } : {};
	if (explicit) {
		const tier = tierOf(explicit);
		if (tier) return tierRoute(tier, request, usable, parentModel);
		const choice = modelChoice(explicit, available, parentProvider);
		if (choice?.alternatives)
			return {
				error: `Model "${explicit}" matches several providers. Use provider/id: ${choice.alternatives.join(", ")}`,
			};
		const model = choice?.model;
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
	if (tier) return tierRoute(tier, request, usable, parentModel);
	const model = resolveModel(preferred, available, parentProvider);
	if (model) return { model };
	const skipped = refused ? resolveModel(preferred, all, parentProvider) : undefined;
	return {
		...parentModel,
		fallback: preferred,
		...(skipped ? { refusedBy: skipped.slice(0, skipped.indexOf("/")) } : {}),
	};
}
