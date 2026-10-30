import { StringEnum } from "@octocodeai/octocode-contacts/schema";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../core/extensions/index.ts";
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

/** One line per available model, the parent's marked, cheapest first; each provider's credential status when known. */
export function describeModels(
	available: readonly ModelRef[],
	parent: ModelRef | undefined,
	profiles: Map<string, AgentProfile>,
	catalog: Catalog | undefined,
	health: (provider: string) => ProviderStatus | undefined = () => undefined,
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
			index === 0 || rows[index - 1].provider !== row.provider
				? ["", `${row.provider}:${describeHealth(health(row.provider))}`, row.line]
				: [row.line],
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
	const listing = describeModels(available, parent, profiles, catalog, (provider) => providerHealth.get(provider));
	return `${listing}\n\n${source}\nCredential marks come from this process's subagent runs and checks; no mark means not yet tried.`;
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
			"Models a task can run on: provider/id, price, context, abilities, small/medium and profile routes, credential status; query filters; check tests credentials; scope catalog adds unconnected ones.",
		parameters: Type.Object({
			query: Type.Optional(Type.String()),
			check: Type.Optional(Type.Boolean()),
			scope: Type.Optional(StringEnum(["connected", "catalog"] as const)),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			const query = params.query?.trim().toLowerCase();
			const matches = (model: ModelRef) => !query || `${model.provider}/${model.id}`.toLowerCase().includes(query);
			const all = ctx.modelRegistry.getAvailable();
			const available = all.filter(matches);
			const unconnected = params.scope === "catalog" ? catalogOnly(ctx.modelRegistry, all).filter(matches) : [];
			if (query && available.length === 0 && unconnected.length === 0)
				return textResult(`No model matches "${params.query}". Call again without query to list all ${all.length}.`);
			if (params.check)
				await checkProviders(ctx.modelRegistry, checkCandidates(available, ctx.model), providerHealth, signal);
			const listing = await modelListing(available, ctx.model, getProfiles());
			return textResult(
				[
					sessionHeader(ctx),
					listing,
					...sessionOnlyNote(ctx.modelRegistry, available),
					...catalogRows(unconnected),
					'Pass one as `model` ("provider/id") when you start a task; append :low, :medium or :high to set its thinking.',
				].join("\n\n"),
			);
		},
	});
}

type ModelsContext = Pick<ExtensionContext, "model" | "thinkingLevel" | "modelRegistry">;

/** This session's model, thinking level and working context: the call is the agent's only view of them. */
function sessionHeader(ctx: ModelsContext): string {
	const model = ctx.model;
	if (!model) return "This session: no model selected.";
	const capacity = ctx.modelRegistry.find?.(model.provider, model.id)?.contextWindow ?? model.contextWindow;
	const budget =
		capacity > model.contextWindow
			? `context budget ${formatTokens(model.contextWindow)} of ${formatTokens(capacity)} capacity`
			: `context ${formatTokens(model.contextWindow)}`;
	return `This session: ${model.provider}/${model.id} · thinking ${ctx.thinkingLevel ?? "off"} · ${budget}.`;
}

/** Providers authenticated only by this session's --api-key: listed, but a task cannot run on them. */
function sessionOnlyNote(registry: ModelsContext["modelRegistry"], available: readonly ModelRef[]): string[] {
	const providers = [...new Set(available.map((model) => model.provider))].filter(
		(provider) => registry.getProviderAuthStatus?.(provider).source === "runtime",
	);
	return providers.length
		? [`Session only (--api-key; subagents do not receive it, so tasks cannot use them): ${providers.join(", ")}.`]
		: [];
}

/** Catalog models of providers that are not connected: what the user could connect, not what a task can run on. */
function catalogOnly(registry: ModelsContext["modelRegistry"], connected: readonly ModelRef[]): ModelRef[] {
	const providers = new Set(connected.map((model) => model.provider));
	return (registry.getAll?.() ?? []).filter((model) => !providers.has(model.provider));
}

function catalogRows(models: readonly ModelRef[]): string[] {
	if (models.length === 0) return [];
	return [
		[
			"Not connected (not runnable; the user connects a provider with /login):",
			...models.map(
				(model) =>
					`  ${model.provider}/${model.id}${model.contextWindow ? ` · ${formatTokens(model.contextWindow)} context` : ""}`,
			),
		].join("\n"),
	];
}

/** `/modelsettings` for the user and the `agent` tool's `models` mode for the model: the same listing. */
export function registerModels(
	commands: Subcommands,
	getProfiles: () => Map<string, AgentProfile>,
	registerTool: ExtensionAPI["registerTool"],
): void {
	commands.add("modelsettings", {
		description:
			"modelsettings [check] — the models you can use, their price and abilities, and which one each subagent purpose runs on; check tests each provider's credential first",
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
	registerModelsMode(registerTool, getProfiles);
}
