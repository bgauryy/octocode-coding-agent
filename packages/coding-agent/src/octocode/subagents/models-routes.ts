import type { Catalog } from "../../core/model-catalog/index-shape.ts";
import { type ConfiguredModels, configuredSubagentModels } from "./configured-models.ts";
import {
	fallbackNote,
	hasPrice,
	isModelTier,
	MODEL_TIERS,
	type ModelRef,
	type Refused,
	resolveTier,
	routeModel,
	SUBAGENT_DEFAULT_THINKING,
	SUBAGENT_DEFAULT_TIER,
	SUBAGENT_THINKING_ENV,
	subagentThinking,
	supportedThinking,
	type TierBilling,
	usableModels,
} from "./model.ts";
import type { AgentProfile } from "./profiles.ts";
import { providerHealth } from "./provider-health.ts";

/** What the subagent purposes (`small`, `medium`) and profiles run on now, for the model listing and the routing facts. */

const name = (model: ModelRef) => `${model.provider}/${model.id}`;

/** The subagent purposes and profiles with the model each runs on now. */
export function describeRoutes(
	available: readonly ModelRef[],
	parent: ModelRef | undefined,
	profiles: Map<string, AgentProfile>,
	catalog: Catalog | undefined,
	refused: Refused = (provider, id, proven, cost) => providerHealth.refused(provider, id, proven, cost),
	configured: ConfiguredModels = configuredSubagentModels(),
	billing?: TierBilling,
): string {
	const own = parent && (available.find((model) => name(model) === name(parent)) ?? parent);
	const parentPriced = own !== undefined && hasPrice(own, catalog);
	const why = (tier: string) =>
		!parent || tier === "large"
			? ""
			: !parentPriced
				? " (its price is unknown and no model is smaller by size guess)"
				: tier === "medium"
					? " (no capable model at 15–80% of its price)"
					: " (no cheaper capable model)";
	const tiers = MODEL_TIERS.map((tier) => {
		const choice = tierChoice(tier, available, parent, catalog, refused, configured, billing);
		const fallback = parent ? `${name(parent)}, this session's${why(tier)}` : "this session's model";
		const usedBy = tier === SUBAGENT_DEFAULT_TIER ? "; also a task with no profile or model" : "";
		return `  ${tier}: ${choice.model ?? fallback}${choice.note ? ` (${choice.note})` : ""}${usedBy}`;
	});
	const thinking = subagentThinking();
	const set = thinking !== SUBAGENT_DEFAULT_THINKING || process.env[SUBAGENT_THINKING_ENV] !== undefined;
	const unsuffixed = `  thinking when the call and profile name none: ${thinking} (${set ? SUBAGENT_THINKING_ENV : `built in; ${SUBAGENT_THINKING_ENV} sets another`}), never this session's level`;
	// Each profile as it would route now: the model it runs on, and what it asked for.
	const routed = [...profiles.values()].map((profile) => {
		const route = routeModel({
			preferred: profile.model,
			available,
			parent,
			catalog,
			refused,
			thinking,
			configured,
			billing,
		});
		const runs = profileRuns(route, available);
		const source = "setting" in route && route.setting ? `; setting ${route.setting}` : "";
		const asked = !profile.model
			? ""
			: "fallback" in route && route.fallback
				? ` (${fallbackNote(route.fallback, route.refusedBy)})`
				: ` (${profile.model}${isModelTier(profile.model.split(":")[0]) ? `, a purpose${source}` : ""})`;
		return `  ${profile.name}: ${runs}${asked}`;
	});
	return ["Subagent purposes:", ...tiers, unsuffixed, ...(routed.length > 0 ? ["", "Profiles:", ...routed] : [])].join(
		"\n",
	);
}

/** The model a purpose resolves to now, skipping providers that refused their credential; undefined: the parent's. */
const tierModel = (
	tier: (typeof MODEL_TIERS)[number],
	available: readonly ModelRef[],
	parent: ModelRef | undefined,
	catalog: Catalog | undefined,
	refused: Refused,
	billing?: TierBilling,
) => resolveTier(tier, usableModels(available, parent, refused), parent, catalog, billing);

/**
 * What a purpose runs on now and where that came from: the user's `subagents.models` setting (`note` names it), else the
 * automatic choice, which says why a set model was skipped. No `model`: the automatic choice found none, so the parent's runs.
 */
export function tierChoice(
	tier: (typeof MODEL_TIERS)[number],
	available: readonly ModelRef[],
	parent: ModelRef | undefined,
	catalog: Catalog | undefined,
	refused: Refused,
	configured: ConfiguredModels,
	billing?: TierBilling,
): { model?: string; note?: string } {
	const route = routeModel({ preferred: tier, available, parent, catalog, refused, configured, billing });
	if ("error" in route) return {};
	if (route.setting && route.model)
		return { model: supportedThinking(route.model, available), note: `setting ${route.setting}` };
	const chosen = tierModel(tier, available, parent, catalog, refused, billing);
	const note = route.skipped ? `automatic; ${route.skipped}` : route.guessed ? "size guess, price unknown" : undefined;
	return { ...(chosen ? { model: name(chosen) } : {}), ...(note ? { note } : {}) };
}

/** What a profile's route runs on: `provider/id:level`, the routing error, or the parent's model. */
export const profileRuns = (route: ReturnType<typeof routeModel>, available: readonly ModelRef[]) =>
	"error" in route ? route.error : route.model ? supportedThinking(route.model, available) : "this session's model";
