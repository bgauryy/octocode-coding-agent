import type { ExtensionCommandContext } from "../../core/features/index.ts";
import { type Subcommands, say } from "../shared/commands.ts";
import { formatTokens } from "../shared/format.ts";
import { sanitizeTerminalText } from "../../../../common/src/sanitize.ts";
import { clipText } from "../shared/util.ts";
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
	currentPrice,
	fallbackNote,
	isModelTier,
	MODEL_TIERS,
	type ModelRef,
	resolveTier,
	routeModel,
	SUBAGENT_DEFAULT_THINKING,
	SUBAGENT_DEFAULT_TIER,
	SUBAGENT_THINKING_ENV,
	subagentThinking,
	supportedThinking,
	usableModels,
} from "./model.ts";
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
/** A remote description, made safe for the terminal and kept to one short line. */
const describe = (text: string) => {
	const clean = sanitizeTerminalText(text).replace(/\s+/g, " ").trim();
	return clipText(clean, 120);
};
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
	refused: (provider: string) => boolean = (provider) => providerHealth.refused(provider),
): string {
	if (available.length === 0) return "No models are configured.";
	const rows = available.filter(shown).map((model) => {
		const known = lookup(catalog, model.provider, model.id);
		const own = currentPrice(model.cost);
		const cost = own && own.input + own.output > 0 ? own : listedCost(catalog, model.provider, model.id);
		const abilities = modelAbilities(model, catalog);
		const caps = [abilities.includes("tools") ? "" : "no tools", ...abilities].filter(Boolean).join(", ");
		const price = cost ? `${perMillion(cost.input)}/${perMillion(cost.output)}` : "price ?";
		const mark = parent && name(model) === name(parent) ? "● " : "  ";
		const description = known?.description ? ` — ${describe(known.description)}` : "";
		return {
			provider: model.provider,
			parent: mark !== "  ",
			sort: cost ? 3 * cost.input + cost.output : Infinity,
			line: `${mark}${name(model)} · ${price} per M in/out · ${contextSize(model.contextWindow || known?.context)} · ${caps}${description}`,
		};
	});
	rows.sort((a, b) => a.provider.localeCompare(b.provider) || a.sort - b.sort);
	const parentPriced =
		rows.some((row) => row.parent && row.sort !== Infinity) ||
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
		const chosen = resolveTier(tier, usableModels(available, parent, refused), parent, catalog);
		const fallback = parent ? `${name(parent)}, this session's${why(tier)}` : "this session's model";
		const usedBy = tier === SUBAGENT_DEFAULT_TIER ? "; also a task with no profile or model" : "";
		return `  ${tier}: ${chosen ? name(chosen) : fallback}${usedBy}`;
	});
	const thinking = subagentThinking();
	const set = thinking !== SUBAGENT_DEFAULT_THINKING || process.env[SUBAGENT_THINKING_ENV] !== undefined;
	const unsuffixed = `  thinking when the call and profile name none: ${thinking} (${set ? SUBAGENT_THINKING_ENV : `built in; ${SUBAGENT_THINKING_ENV} sets another`}), never this session's level`;
	// Each profile as it would route now: the model it runs on, and what it asked for.
	const routed = [...profiles.values()].map((profile) => {
		const route = routeModel({ preferred: profile.model, available, parent, catalog, refused, thinking });
		const runs =
			"error" in route ? route.error : route.model ? supportedThinking(route.model, available) : "this session's model";
		const asked = !profile.model
			? ""
			: "fallback" in route && route.fallback
				? ` (${fallbackNote(route.fallback, route.refusedBy)})`
				: ` (${profile.model}${isModelTier(profile.model.split(":")[0]) ? ", a purpose" : ""})`;
		return `  ${profile.name}: ${runs}${asked}`;
	});
	return [
		"Models this session can use (● this session; price per million tokens in/out; context window):",
		...rows.flatMap((row, index) =>
			index === 0 || rows[index - 1].provider !== row.provider
				? ["", `${row.provider}:${describeHealth(health(row.provider))}`, row.line]
				: [row.line],
		),
		"",
		"Subagent purposes:",
		...tiers,
		unsuffixed,
		...(routed.length > 0 ? ["", "Profiles:", ...routed] : []),
	].join("\n");
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

export const CREDENTIAL_MARKS =
	"Credential marks come from this process's subagent runs and checks; no mark means not yet tried.";

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
		description: "Models, prices and subagent routing",
		argumentHint: "[check]",
		handler: async (args, ctx: ExtensionCommandContext) => {
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
