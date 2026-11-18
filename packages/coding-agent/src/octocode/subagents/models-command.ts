import { getSupportedThinkingLevels } from "@octocodeai/octocode-ai/compat";
import { builtinDescription } from "../../core/slash-commands.ts";
import type { CommandContext } from "../../core/features/index.ts";
import { type Subcommands, say } from "../shared/commands.ts";
import { formatTokens } from "../shared/format.ts";
import {
	type Catalog,
	catalogFile,
	listedCost,
	loadCatalog,
	lookup,
	MODELS_DEV_ENV,
	modelsDevEnabled,
	readCatalog,
} from "./catalog.ts";
import {
	canRunTask,
	currentPrice,
	fallbackNote,
	isModelTier,
	MODEL_TIERS,
	type ModelRef,
	type Refused,
	resolveTier,
	routeModel,
	type TierBilling,
	SUBAGENT_DEFAULT_THINKING,
	SUBAGENT_DEFAULT_TIER,
	SUBAGENT_THINKING_ENV,
	subagentThinking,
	supportedThinking,
	taskBlocker,
	usableModels,
} from "./model.ts";
import { type ConfiguredModels, configuredSubagentModels } from "./configured-models.ts";
import type { AgentProfile } from "./profiles.ts";
import {
	checkCandidates,
	checkProviders,
	describeHealth,
	providerHealth,
	type ProviderStatus,
} from "./provider-health.ts";

/**
 * `/modelsettings`: the models this session can use, what each costs and can do, and which one each subagent
 * purpose (`small`, `medium`) and profile runs on. Refreshes the models.dev index first unless it is turned off.
 */

const perMillion = (value: number) => `$${value < 1 ? value.toFixed(2) : value.toFixed(value % 1 === 0 ? 0 : 2)}`;
const contextSize = (tokens: number | undefined) => (tokens ? formatTokens(tokens) : "?");
const name = (model: ModelRef) => `${model.provider}/${model.id}`;

/** The abilities a model row names and the `models` tool filters by. */
export const MODEL_ABILITIES = ["tools", "images", "reasoning"] as const;
type ModelAbility = (typeof MODEL_ABILITIES)[number];

/** What `model` can do, from its own metadata and the models.dev entry; tools unless the catalog says otherwise. */
export function modelAbilities(model: ModelRef, catalog: Catalog | undefined): ModelAbility[] {
	const known = lookup(catalog, model.provider, model.id);
	return [
		...(known?.toolCall === false ? [] : ["tools" as const]),
		...((model.input ?? known?.input)?.includes("image") ? ["images" as const] : []),
		...(known?.reasoning ? ["reasoning" as const] : []),
	];
}

/** The price a model is listed at: its own current rates, else models.dev's. */
export function modelCost(
	model: ModelRef,
	catalog: Catalog | undefined,
): { input: number; output: number } | undefined {
	const own = currentPrice(model.cost);
	return own && own.input + own.output > 0 ? own : listedCost(catalog, model.provider, model.id);
}

/** Input and output rates as `$in/$out`, or `price ?`. */
export const priceText = (cost: { input: number; output: number } | undefined): string =>
	cost ? `${perMillion(cost.input)}/${perMillion(cost.output)}` : "price ?";

/** Blended price for ordering: three input tokens to one output, as agent turns spend; Infinity when unknown. */
export const priceRank = (cost: { input: number; output: number } | undefined): number =>
	cost ? 3 * cost.input + cost.output : Infinity;

/** ` · thinking …` with the levels `clampThinkingLevel` would accept, or "" for a model without reasoning. */
function thinkingLevelsText(model: ModelRef): string {
	// The registry's model carries `reasoning` and `thinkingLevelMap`; `ModelRef` names only what routing reads.
	if (!(model as { reasoning?: boolean }).reasoning) return "";
	const levels = getSupportedThinkingLevels(model as Parameters<typeof getSupportedThinkingLevels>[0]).join("/");
	return ` · thinking ${levels}`;
}

/** One model's line: price, context window and abilities, the parent's marked. */
export function modelLine(model: ModelRef, parent: ModelRef | undefined, catalog: Catalog | undefined): string {
	const known = lookup(catalog, model.provider, model.id);
	const abilities = modelAbilities(model, catalog);
	const caps = [abilities.includes("tools") ? "" : "no tools", ...abilities].filter(Boolean).join(", ");
	const mark = parent && name(model) === name(parent) ? "● " : "  ";
	const levels = thinkingLevelsText(model);
	const cutoff =
		known?.knowledge && /^\d{4}-\d{2}(?:-\d{2})?$/.test(known.knowledge) ? ` · cutoff ${known.knowledge}` : "";
	const window = model.contextWindow !== undefined && model.contextWindow !== 0 ? model.contextWindow : known?.context;
	return `${mark}${name(model)} · ${priceText(modelCost(model, catalog))} per M in/out · ${contextSize(window)} · ${caps}${levels}${cutoff}`;
}

/**
 * Models that cannot run a task (`taskBlocker`), each with why, under their own heading: they are listed so the user
 * and the agent know them, never as candidates.
 */
export function describeUnrunnable(
	models: readonly ModelRef[],
	parent: ModelRef | undefined,
	catalog: Catalog | undefined,
): string {
	const rows = models
		.map((model) => ({ model, why: taskBlocker(model, catalog) }))
		.filter((row): row is { model: ModelRef; why: string } => row.why !== undefined)
		.sort((a, b) => name(a.model).localeCompare(name(b.model)));
	if (rows.length === 0) return "";
	return [
		"Cannot run a task (a task needs tool calls, a current model and 100k context):",
		...rows.map(({ model, why }) => `${modelLine(model, parent, catalog)} · ${why}`),
	].join("\n");
}

/**
 * One line per available model, the parent's marked, cheapest first; each provider's credential status when known.
 * `shown` limits the rows; the purposes and profile routes still resolve over every available model, skipping a
 * provider that `refused` its credential as a run's routing does (`planRun`).
 */
export function describeModels(
	available: readonly ModelRef[],
	parent: ModelRef | undefined,
	profiles: Map<string, AgentProfile>,
	catalog: Catalog | undefined,
	health: (provider: string) => ProviderStatus | undefined = () => undefined,
	shown: (model: ModelRef) => boolean = () => true,
	refused: Refused = (provider, id, proven, cost) => providerHealth.refused(provider, id, proven, cost),
	configured: ConfiguredModels = configuredSubagentModels(),
	billing?: TierBilling,
): string {
	if (available.length === 0) return "No models are configured.";
	const rows = available
		.filter(shown)
		.map((model) => ({
			provider: model.provider,
			sort: priceRank(modelCost(model, catalog)),
			line: modelLine(model, parent, catalog),
		}))
		.sort((a, b) => a.provider.localeCompare(b.provider) || a.sort - b.sort);
	return [
		"Models this session can use (● this session; price per million tokens in/out; context window):",
		...rows.flatMap((row, index) =>
			index === 0 || rows[index - 1].provider !== row.provider
				? ["", `${row.provider}:${describeHealth(health(row.provider))}`, row.line]
				: [row.line],
		),
		"",
		describeRoutes(available, parent, profiles, catalog, refused, configured, billing),
	].join("\n");
}

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
	const parentPriced =
		(own !== undefined && priceRank(modelCost(own, catalog)) !== Infinity) ||
		(parent !== undefined && resolveTier("small", [...available, parent], parent, catalog) !== undefined);
	const why = (tier: string) =>
		!parent
			? ""
			: !parentPriced
				? " (its price is unknown, so nothing ranks below it)"
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
function tierChoice(
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
	return {
		...(chosen ? { model: name(chosen) } : {}),
		...(route.skipped ? { note: `automatic; ${route.skipped}` } : {}),
	};
}

/** What a profile's route runs on: `provider/id:level`, the routing error, or the parent's model. */
const profileRuns = (route: ReturnType<typeof routeModel>, available: readonly ModelRef[]) =>
	"error" in route ? route.error : route.model ? supportedThinking(route.model, available) : "this session's model";

/** Routing facts the coordinator's prompt states (`policy/delegation.md`): what each purpose and profile runs on now. */
export interface RoutingFacts {
	sessionModel: string;
	/** Providers with a usable model, sorted, each with how many of its models can run a task. */
	providers: Array<{ id: string; count: number }>;
	small: string;
	medium: string;
	/** Profile name to the model it runs on. */
	profiles: Record<string, string>;
}

/**
 * The routes `describeModels` lists, reduced to what the coordinator needs. The prompt states them once per session
 * and a later change arrives as a notice (`routing-watch.ts`), so the cached prompt stays stable.
 */
export function routingFacts(
	available: readonly ModelRef[],
	parent: ModelRef | undefined,
	profiles: Iterable<AgentProfile>,
	catalog: Catalog | undefined,
	refused: Refused = (provider, id, proven, cost) => providerHealth.refused(provider, id, proven, cost),
	configured: ConfiguredModels = configuredSubagentModels(),
	billing?: TierBilling,
): RoutingFacts | undefined {
	if (!parent || available.length === 0) return undefined;
	const thinking = subagentThinking();
	const purpose = (tier: (typeof MODEL_TIERS)[number]) => {
		const choice = tierChoice(tier, available, parent, catalog, refused, configured, billing);
		return `${choice.model ?? name(parent)}${choice.note ? ` (${choice.note})` : ""}`;
	};
	return {
		sessionModel: name(parent),
		providers: [
			...new Set(
				available
					.filter((model) => !refused(model.provider, undefined, false, model.cost))
					.map((model) => model.provider),
			),
		]
			.sort()
			.map((id) => ({
				id,
				count: available.filter((model) => model.provider === id && canRunTask(model, catalog)).length,
			})),
		small: purpose("small"),
		medium: purpose("medium"),
		profiles: Object.fromEntries(
			[...profiles].map((profile) => [
				profile.name,
				profileRuns(
					routeModel({ preferred: profile.model, available, parent, catalog, refused, thinking, configured, billing }),
					available,
				),
			]),
		),
	};
}

/**
 * The model listing (`describeModels`) with where its capabilities and prices come from. Refreshes the models.dev index
 * first unless it is turned off; `fetching` runs before a refresh that has no index to fall back on.
 */
async function modelListing(
	available: readonly ModelRef[],
	parent: ModelRef | undefined,
	profiles: Map<string, AgentProfile>,
	fetching?: () => void,
): Promise<string> {
	const { catalog, source } = await modelCatalog(fetching);
	const listing = describeModels(available, parent, profiles, catalog, (provider) => providerHealth.get(provider));
	return `${listing}\n\n${source}\n${CREDENTIAL_MARKS}`;
}

const CREDENTIAL_MARKS =
	"Credential marks come from subagent runs and checks; a refused credential stays marked, across sessions, until it is replaced or a check passes. No mark means not yet tried.";

/** The models.dev index unless it is turned off, and a line saying where capabilities and prices come from. */
export async function modelCatalog(fetching?: () => void): Promise<{ catalog: Catalog | undefined; source: string }> {
	const enabled = modelsDevEnabled();
	if (enabled && !readCatalog(catalogFile())) fetching?.();
	const catalog = enabled ? await loadCatalog({ file: catalogFile() }) : undefined;
	const source = !enabled
		? `models.dev is off (${MODELS_DEV_ENV}=0); Octocode's metadata only.`
		: catalog
			? `Capabilities and missing prices from models.dev (fetched ${new Date(catalog.fetchedAt).toISOString().slice(0, 10)}).`
			: "models.dev could not be reached now or within the last hour; Octocode's metadata only.";
	return { catalog, source };
}

/** `/modelsettings`: the listing the `models` tool (`models-tool.ts`) gives the model, for the user. */
export function registerModels(commands: Subcommands, getProfiles: () => Map<string, AgentProfile>): void {
	commands.add("modelsettings", {
		description: builtinDescription("modelsettings"),
		argumentHint: "[check]",
		handler: async (args, ctx: CommandContext) => {
			if (args.trim() === "check") {
				const available = ctx.modelRegistry.getAvailable();
				const targets = checkCandidates(available, ctx.model);
				say(ctx, `Checking ${targets.length} provider credential${targets.length === 1 ? "" : "s"}…`);
				await checkProviders(ctx.modelRegistry, targets, providerHealth, ctx.signal);
			} else if (args.trim()) return say(ctx, "Usage: /modelsettings [check]", "warning");
			const listing = await modelListing(ctx.modelRegistry.getAvailable(), ctx.model, getProfiles(), () =>
				say(ctx, "Fetching model data from models.dev…"),
			);
			say(ctx, listing);
		},
	});
}
