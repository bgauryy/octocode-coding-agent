import { renderInstruction } from "../../core/prompt-template.ts";
import { StringEnum } from "@octocodeai/octocode-contracts/schema";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import { formatTokens } from "../shared/format.ts";
import { textResult } from "../shared/util.ts";
import type { ModelRef } from "./model.ts";
import { THINKING_LEVELS } from "./thinking.ts";
import { canRunTask } from "./model.ts";
import {
	CREDENTIAL_MARKS,
	describeModels,
	describeRoutes,
	describeUnrunnable,
	MODEL_ABILITIES,
	modelAbilities,
	modelCatalog,
} from "./models-command.ts";
import { providerRows, providerSummary } from "./models-summary.ts";
import type { AgentProfile } from "./profiles.ts";
import { checkCandidates, checkProviders, providerHealth } from "./provider-health.ts";

type ModelsContext = Pick<ExtensionContext, "model" | "thinkingLevel" | "modelRegistry">;

/**
 * The `models` tool: this session's model and thinking level, the configured providers with their credential status,
 * and the models a task can run on, as `/modelsettings` shows them to the user. The full list is a call, not prompt
 * text: it changes with configuration and credentials, and the cached prompt must not. The prompt states only the short
 * routing facts, frozen per session (`routing-watch.ts`).
 */
export function registerModelsTool(api: ExtensionAPI, getProfiles: () => Map<string, AgentProfile>): void {
	api.registerTool({
		name: "models",
		label: "Models",
		promptSnippet: renderInstruction("tools/models/snippet.md"),
		description:
			"This session's model and thinking level; providers and credential status; models with price, context and abilities; small/medium and profile routes. No filter: one row per provider; `provider` lists its models. Filters combine.",
		parameters: Type.Object({
			provider: Type.Optional(Type.String({ description: "List this provider's models" })),
			ability: Type.Optional(StringEnum(MODEL_ABILITIES, { description: "Keep models with this ability" })),
			query: Type.Optional(Type.String({ description: "Keep models whose provider/id contains this text" })),
			check: Type.Optional(
				Type.Boolean({
					description: "true: first test credentials with one small request per provider",
				}),
			),
			scope: Type.Optional(
				StringEnum(["connected", "catalog"] as const, {
					description: "connected (default); catalog adds unconnected models",
				}),
			),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			const { catalog, source } = await modelCatalog();
			const query = params.query?.trim().toLowerCase();
			const provider = params.provider?.trim().toLowerCase();
			const named = (model: ModelRef) =>
				(!query || `${model.provider}/${model.id}`.toLowerCase().includes(query)) &&
				(!provider || model.provider.toLowerCase() === provider);
			const matches = (model: ModelRef) =>
				named(model) && (!params.ability || modelAbilities(model, catalog).includes(params.ability));
			const all = ctx.modelRegistry.getAvailable();
			const shown = all.filter(matches);
			const unconnected = params.scope === "catalog" ? catalogOnly(ctx.modelRegistry, all).filter(matches) : [];
			const filtered = query || provider || params.ability;
			if (filtered && shown.length === 0 && unconnected.length === 0)
				return textResult(
					[
						sessionHeader(ctx),
						providerRows(ctx.modelRegistry, all),
						`No model matches the filters; ${all.length} without them.`,
					].join("\n\n"),
				);
			if (params.check)
				await checkProviders(ctx.modelRegistry, checkCandidates(shown, ctx.model), providerHealth, signal);
			const footer = `Pass one as \`model\` ("provider/id") when you start a task; append ${thinkingLevels()} to set its thinking.`;
			const credentials = `${source}\n${CREDENTIAL_MARKS}`;
			// An unfiltered call, or a query or ability that keeps too many rows, gets one row per provider; a provider
			// (or a short filter) gets the models themselves.
			if (!provider && (!filtered || shown.length > LISTING_ROWS)) {
				const kept = filtered ? shown : undefined;
				return textResult(
					[
						sessionHeader(ctx),
						providerSummary(ctx.modelRegistry, all, catalog, kept),
						...(kept
							? [`${kept.length} models match; too many to list. Set \`provider\` to list one provider's models.`]
							: []),
						describeRoutes(all, ctx.model, getProfiles(), catalog),
						...(kept ? [] : ["Set `provider` to list one provider's models."]),
						credentials,
						...catalogRows(unconnected),
						footer,
					].join("\n\n"),
				);
			}
			// Credential status is on the provider rows; the model headings carry none so it is said once.
			const listing = describeModels(
				all,
				ctx.model,
				getProfiles(),
				catalog,
				undefined,
				(model) => matches(model) && canRunTask(model, catalog),
			);
			const unrunnable = describeUnrunnable(shown, ctx.model, catalog);
			return textResult(
				[
					sessionHeader(ctx),
					providerRows(ctx.modelRegistry, all),
					listing,
					...(unrunnable ? [unrunnable] : []),
					credentials,
					...catalogRows(unconnected),
					footer,
				].join("\n\n"),
			);
		},
	});
}

/** A filtered call lists models up to this many rows; beyond it the per-provider summary comes first. */
const LISTING_ROWS = 40;

/** `:low, :medium … or :max`: the levels `agent` accepts, in its order. */
function thinkingLevels(): string {
	const levels = [...THINKING_LEVELS].map((level) => `:${level}`);
	return `${levels.slice(0, -1).join(", ")} or ${levels.at(-1)}`;
}

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

/** Catalog models of providers that are not connected: what the user could connect, not what a task can run on. */
function catalogOnly(registry: ModelsContext["modelRegistry"], connected: readonly ModelRef[]): ModelRef[] {
	const providers = new Set(connected.map((model) => model.provider));
	return (registry.getAll?.() ?? []).filter((model) => !providers.has(model.provider));
}

function catalogRows(models: readonly ModelRef[]): string[] {
	if (models.length === 0) return [];
	return [
		[
			"Not connected (not runnable; the user connects a provider with /providers):",
			...models.map(
				(model) =>
					`  ${model.provider}/${model.id}${model.contextWindow ? ` · ${formatTokens(model.contextWindow)} context` : ""}`,
			),
		].join("\n"),
	];
}
