import { modelAvailableToChild, modelEnabled, sessionOnlyProvider } from "../../../subagents/task-model-visibility.ts";
import { modelSizeClass } from "../../../subagents/size-class.ts";
import type { ExternalModelFilters } from "../../../shared/model-filters.ts";
import { renderPrompt } from "../../../../core/prompt-template.ts";
import { StringEnum } from "@octocodeai/octocode-contracts/schema";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { Type } from "typebox";
import type { FeatureSetup, FeatureContext } from "../../../../core/features/index.ts";
import { formatTokens } from "../../../shared/format.ts";
import { textResult } from "../../../shared/util.ts";
import { budgetedTool } from "../../../jobs/tool.ts";
import type { ModelRef } from "../../../subagents/model.ts";
import { VALID_THINKING_LEVELS } from "../../../../core/thinking-level.ts";
import { canRunTask, registryBilling } from "../../../subagents/model.ts";
import {
	describeModels,
	describeRoutes,
	describeUnrunnable,
	MODEL_ABILITIES,
	modelAbilities,
	modelLine,
	modelCatalog,
	SOURCE_NOTE,
} from "../../../subagents/models-command.ts";
import { compactModels, providerKinds, providerRows, providerSummary } from "../../../subagents/models-summary.ts";
import type { AgentProfile } from "../../../subagents/profiles.ts";
import { checkCandidates, checkProviders, providerHealth } from "../../../subagents/provider-health.ts";

type ModelsContext = Pick<FeatureContext, "model" | "thinkingLevel" | "modelRegistry">;

/**
 * The blocks about agents outside Octocode's model loop (connected runners, external agents), from `octocode/index.ts`:
 * subagents reach no transport themselves. Empty when there are none or they are off.
 */
export type ExternalListing = (
	ctx: FeatureContext,
	signal?: AbortSignal,
	filters?: ExternalModelFilters,
) => Promise<string[]>;

/**
 * The `models` tool: this session's model and thinking level, the configured providers with their credential status,
 * and the models a task can run on, as `/modelsettings` shows them to the user. The full list is a call, not prompt
 * text: it changes with configuration and credentials, and the cached prompt must not. The prompt states only the short
 * routing facts, frozen per session (`routing-watch.ts`).
 */
export function registerModelsTool(
	api: FeatureSetup,
	getProfiles: () => Map<string, AgentProfile>,
	listExternal: ExternalListing = async () => [],
): void {
	api.tools.register(
		budgetedTool(
			{
				name: "models",
				roleVariant: true,
				label: "Models",
				promptSnippet: renderPrompt("tools/models/snippet.md"),
				description:
					"List enabled models, estimated size, context/output limits, cost and abilities. Use routes for task choices.",
				parameters: Type.Object({
					routes: Type.Optional(Type.Boolean({ description: "Add routes" })),
					offset: Type.Optional(Type.Integer({ description: "Continue a large inventory at this zero-based row" })),
					provider: Type.Optional(Type.String({ description: "Provider, or external vendor/runner ID" })),
					size: Type.Optional(
						StringEnum(["small", "medium", "large"] as const, { description: "Estimated model size" }),
					),
					ability: Type.Optional(StringEnum(MODEL_ABILITIES, { description: "Ability" })),
					query: Type.Optional(Type.String({ description: "Text in provider/id or route" })),
					check: Type.Optional(
						Type.Boolean({
							description: "true: test credentials (may cost)",
						}),
					),
					scope: Type.Optional(
						StringEnum(["connected", "catalog"] as const, {
							description: "connected (default); catalog: also unconnected",
						}),
					),
				}),
				async execute(_id, params, signal, _onUpdate, ctx) {
					signal?.throwIfAborted();
					if (params.offset !== undefined && (!Number.isSafeInteger(params.offset) || params.offset < 0))
						throw new Error("offset must be a nonnegative safe integer.");
					const { catalog, source } = await modelCatalog();
					const query = params.query?.trim().toLowerCase();
					const provider = params.provider?.trim().toLowerCase();
					const named = (model: ModelRef) =>
						(!query || `${model.provider}/${model.id}`.toLowerCase().includes(query)) &&
						(!provider || model.provider.toLowerCase() === provider);
					const matches = (model: ModelRef) =>
						named(model) &&
						(!params.size || modelSizeClass(model) === params.size) &&
						(!params.ability || modelAbilities(model, catalog).includes(params.ability));
					const all = ctx.modelRegistry
						.getAvailable()
						.map((model) => ({ ...model, origin: ctx.modelRegistry.getModelOrigin(model) }));
					const shown = all.filter(matches);
					const childCanUse = (model: ModelRef) => modelAvailableToChild(ctx.modelRegistry, model);
					const taskModels = all.filter(childCanUse);
					const taskParent =
						ctx.model && modelEnabled(ctx.modelRegistry, ctx.model) && childCanUse(ctx.model) ? ctx.model : undefined;
					const childBlocker = (model: ModelRef) =>
						sessionOnlyProvider(ctx.modelRegistry, model.provider)
							? "session only (tasks cannot inherit --api-key)"
							: "unavailable to the child account";
					const parentOnlyRows = shown.filter((model) => !childCanUse(model));
					const parentOnlyNote = parentOnlyRows.length
						? [
								`Parent session only:\n${parentOnlyRows.map((model) => `${modelLine(model, ctx.model, catalog)} · ${childBlocker(model)}`).join("\n")}`,
							]
						: [];
					const kinds = providerKinds(ctx.modelRegistry, all);
					const unconnected = params.scope === "catalog" ? catalogOnly(ctx.modelRegistry, all).filter(matches) : [];
					const filtered = query || provider || params.ability || params.size;
					const outside = params.size
						? []
						: await externalSection(listExternal, ctx, signal, {
								query,
								provider,
								ability: params.ability,
							});
					if (filtered && shown.length === 0 && unconnected.length === 0 && outside.length === 0)
						return textResult(
							[
								sessionHeader(ctx),
								providerRows(ctx.modelRegistry, all, kinds),
								`No model matches the filters; ${all.length} without them.`,
							].join("\n\n"),
						);
					if (params.check)
						await checkProviders(ctx.modelRegistry, checkCandidates(shown, ctx.model), providerHealth, signal);
					const footer = `${SOURCE_NOTE}\nPass one as \`model\` ("provider/id") when you start a task; append ${thinkingLevels()} to set its thinking.`;

					const count = shown.length + unconnected.length;
					if (params.offset !== undefined || (count > 100 && (!filtered || provider || unconnected.length > 0))) {
						const offset = params.offset ?? 0;
						const ordered = [...shown, ...unconnected].sort(
							(a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id),
						);
						const disconnected = new Set(unconnected);
						const page = ordered.slice(offset, offset + 64);
						const rows = page.map((model) => {
							const use = disconnected.has(model)
								? "not connected"
								: !childCanUse(model)
									? childBlocker(model)
									: canRunTask(model, catalog) ||
										  (model.provider === taskParent?.provider && model.id === taskParent.id)
										? "task model"
										: "available by exact provider/id";
							return `${modelLine(model, ctx.model, catalog)} · ${use}`;
						});
						return textResult(
							[
								sessionHeader(ctx),
								...rows,
								`${count} matching models. ${offset + page.length < count ? `Continue with offset ${offset + page.length} and the same filters.` : "End of list."}`,
								...(params.routes
									? [
											describeRoutes(
												taskModels,
												taskParent,
												getProfiles(),
												catalog,
												undefined,
												undefined,
												registryBilling(ctx.modelRegistry),
											),
										]
									: []),
								...(offset === 0 ? outside : []),
								footer,
							].join("\n"),
						);
					}

					if (!filtered)
						return textResult(
							[
								sessionHeader(ctx),
								`${compactModels(taskModels, catalog)}\n${SOURCE_NOTE}`,
								...(params.routes
									? [
											describeRoutes(
												taskModels,
												taskParent,
												getProfiles(),
												catalog,
												undefined,
												undefined,
												registryBilling(ctx.modelRegistry),
											),
										]
									: []),
								...parentOnlyNote,
								...outside,
								...catalogRows(unconnected),
								source,
							].join("\n\n"),
						);
					const credentials = source;
					// Broad query and ability filters get a provider summary; a provider or short filter lists models.
					if (!provider && shown.length > LISTING_ROWS) {
						const kept = filtered ? shown : undefined;
						return textResult(
							[
								sessionHeader(ctx),
								providerSummary(ctx.modelRegistry, all, catalog, kept, kinds),
								...(kept
									? [`${kept.length} models match; too many to list. Set \`provider\` to list one provider's models.`]
									: []),
								describeRoutes(
									taskModels,
									taskParent,
									getProfiles(),
									catalog,
									undefined,
									undefined,
									registryBilling(ctx.modelRegistry),
								),
								...parentOnlyNote,
								...outside,
								...(kept ? [] : ["Set `provider` to list one provider's models."]),
								credentials,
								...catalogRows(unconnected),
								footer,
							].join("\n\n"),
						);
					}
					// Credential status is on the provider rows; the model headings carry none so it is said once.
					const listing = describeModels(
						taskModels,
						taskParent,
						getProfiles(),
						catalog,
						undefined,
						(model) => matches(model) && canRunTask(model, catalog),
						undefined,
						undefined,
						registryBilling(ctx.modelRegistry),
					);
					const unrunnable = describeUnrunnable(taskModels.filter(matches), taskParent, catalog);
					return textResult(
						[
							sessionHeader(ctx),
							providerRows(ctx.modelRegistry, all, kinds),
							listing,
							...parentOnlyNote,
							...outside,
							...(unrunnable ? [unrunnable] : []),
							credentials,
							...catalogRows(unconnected),
							footer,
						].join("\n\n"),
					);
				},
			},
			(params) =>
				[params.provider, params.query, params.ability, params.check ? "check" : ""].filter(Boolean).join(" ") ||
				"list",
		),
	);
}

/** Connected runners and external agents, when the setting enables them; a listing that fails says so in one line. */
async function externalSection(
	list: ExternalListing,
	ctx: FeatureContext,
	signal?: AbortSignal,
	filters?: ExternalModelFilters,
): Promise<string[]> {
	try {
		return (await list(ctx, signal, filters)).filter((block) => block.trim());
	} catch (error) {
		if (signal?.aborted) throw error;
		return [`Runners and external agents: listing failed (${errorMessage(error)}).`];
	}
}

/** A filtered call lists models up to this many rows; beyond it the per-provider summary comes first. */
const LISTING_ROWS = 40;

/** `:low, :medium … or :max`: the levels `agent` accepts, in its order. */
function thinkingLevels(): string {
	const levels = VALID_THINKING_LEVELS.map((level) => `:${level}`);
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
	return (registry.getAll?.() ?? []).filter(
		(model) =>
			!providers.has(model.provider) && modelEnabled(registry, model) && !registry.isModelAccessRejected?.(model),
	);
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
