import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/index.ts";
import { type Subcommands, say } from "../shared/commands.ts";
import { formatTokens } from "../shared/format.ts";
import { sanitizeTerminalText } from "../shared/sanitize.ts";
import { clipText, textResult } from "../shared/util.ts";
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
import { isModelTier, MODEL_TIERS, type ModelRef, resolveTier, routeModel } from "./model.ts";
import type { AgentProfile } from "./profiles.ts";

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

/** One line per available model, the parent's marked, cheapest first. */
export function describeModels(
	available: readonly ModelRef[],
	parent: ModelRef | undefined,
	profiles: Map<string, AgentProfile>,
	catalog: Catalog | undefined,
): string {
	if (available.length === 0) return "No models are configured.";
	const rows = available.map((model) => {
		const known = lookup(catalog, model.provider, model.id);
		const cost =
			model.cost && model.cost.input + model.cost.output > 0
				? model.cost
				: listedCost(catalog, model.provider, model.id);
		const caps = [
			known?.toolCall === false ? "no tools" : "tools",
			(model.input ?? known?.input)?.includes("image") ? "images" : undefined,
			known?.reasoning ? "reasoning" : undefined,
		]
			.filter(Boolean)
			.join(", ");
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
		const chosen = resolveTier(tier, available, parent, catalog);
		return `  ${tier}: ${chosen ? name(chosen) : parent ? `${name(parent)}, this session's${why(tier)}` : "this session's model"}`;
	});
	// Each profile as it would route now: the model it runs on, and what it asked for.
	const routed = [...profiles.values()].map((profile) => {
		const route = routeModel({ preferred: profile.model, available, parent, catalog });
		const runs = "error" in route ? route.error : (route.model ?? "this session's model");
		const asked = !profile.model
			? ""
			: "fallback" in route && route.fallback
				? ` (${profile.model} unavailable)`
				: ` (${profile.model}${isModelTier(profile.model.split(":")[0]) ? ", a purpose" : ""})`;
		return `  ${profile.name}: ${runs}${asked}`;
	});
	return [
		"Models this session can use (● this session; price per million tokens in/out; context window):",
		...rows.flatMap((row, index) =>
			index === 0 || rows[index - 1].provider !== row.provider ? ["", `${row.provider}:`, row.line] : [row.line],
		),
		"",
		"Subagent purposes:",
		...tiers,
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
	const enabled = modelsDevEnabled();
	if (enabled && !readCatalog(catalogFile())) fetching?.();
	const catalog = enabled ? await loadCatalog({ file: catalogFile() }) : undefined;
	const source = !enabled
		? `models.dev is off (${MODELS_DEV_ENV}=0); Octocode's metadata only.`
		: catalog
			? `Capabilities and missing prices from models.dev (fetched ${new Date(catalog.fetchedAt).toISOString().slice(0, 10)}).`
			: "models.dev could not be reached now or within the last hour; Octocode's metadata only.";
	return `${describeModels(available, parent, profiles, catalog)}\n\n${source}`;
}

/**
 * The `agent` tool's `models` mode: the models this session can start a task on, as `/modelsettings` shows them to the
 * user. It is a call, not prompt text: the list changes with configuration and credentials, and the cached prompt must
 * not.
 */
function registerModelsMode(
	registerTool: ExtensionAPI["registerTool"],
	getProfiles: () => Map<string, AgentProfile>,
): void {
	registerTool({
		name: "agentModels",
		label: "Models",
		description:
			"Models a task can run on: provider/id for its model, price, context, abilities, small/medium and profile routes; query filters.",
		parameters: Type.Object({
			query: Type.Optional(Type.String()),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			const query = params.query?.trim().toLowerCase();
			const all = ctx.modelRegistry.getAvailable();
			const available = query
				? all.filter((model) => `${model.provider}/${model.id}`.toLowerCase().includes(query))
				: all;
			if (query && available.length === 0)
				return textResult(`No model matches "${params.query}". Call again without query to list all ${all.length}.`);
			const listing = await modelListing(available, ctx.model, getProfiles());
			return textResult(
				`${listing}\n\nPass one as \`model\` ("provider/id") when you start a task; append :low, :medium or :high to set its thinking.`,
			);
		},
	});
}

/** `/modelsettings` for the user and the `agent` tool's `models` mode for the model: the same listing. */
export function registerModels(
	commands: Subcommands,
	getProfiles: () => Map<string, AgentProfile>,
	registerTool: ExtensionAPI["registerTool"],
): void {
	commands.add("modelsettings", {
		description:
			"modelsettings — the models you can use, their price and abilities, and which one each subagent purpose runs on",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			const listing = await modelListing(ctx.modelRegistry.getAvailable(), ctx.model, getProfiles(), () =>
				say(ctx, "Fetching model data from models.dev…"),
			);
			say(ctx, listing);
		},
	});
	registerModelsMode(registerTool, getProfiles);
}
