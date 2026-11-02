import { StringEnum } from "@octocodeai/octocode-contracts/schema";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import { formatTokens } from "../shared/format.ts";
import { textResult } from "../shared/util.ts";
import type { ModelRef } from "./model.ts";
import { CREDENTIAL_MARKS, describeModels, MODEL_ABILITIES, modelAbilities, modelCatalog } from "./models-command.ts";
import type { AgentProfile } from "./profiles.ts";
import { checkCandidates, checkProviders, describeHealth, providerHealth } from "./provider-health.ts";

type ModelsContext = Pick<ExtensionContext, "model" | "thinkingLevel" | "modelRegistry">;

/**
 * The `models` tool: this session's model and thinking level, the configured providers with their credential status,
 * and the models a task can run on, as `/modelsettings` shows them to the user. It is a call, not prompt text: the list
 * changes with configuration and credentials, and the cached prompt must not.
 */
export function registerModelsTool(api: ExtensionAPI, getProfiles: () => Map<string, AgentProfile>): void {
	api.registerTool({
		name: "models",
		label: "Models",
		promptSnippet: "This session's model, the configured providers and the models a task can run on",
		description:
			"This session's model and thinking level; configured providers with credential status; models with price, context and abilities; the small/medium and profile routes. Filters combine.",
		parameters: Type.Object({
			provider: Type.Optional(Type.String({ description: "Keep this provider's models" })),
			ability: Type.Optional(StringEnum(MODEL_ABILITIES, { description: "Keep models with this ability" })),
			query: Type.Optional(Type.String({ description: "Keep models whose provider/id contains this text" })),
			check: Type.Optional(
				Type.Boolean({
					description: "true: send one small request per provider to test the listed models' credentials first",
				}),
			),
			scope: Type.Optional(
				StringEnum(["connected", "catalog"] as const, {
					description: "connected (default); catalog also lists unconnected models",
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
			// Unconnected catalog models have no abilities to test: only the name filters apply to them.
			const unconnected = params.scope === "catalog" ? catalogOnly(ctx.modelRegistry, all).filter(named) : [];
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
			// Credential status is on the provider rows; the model headings carry none so it is said once.
			const listing = describeModels(all, ctx.model, getProfiles(), catalog, undefined, matches);
			return textResult(
				[
					sessionHeader(ctx),
					providerRows(ctx.modelRegistry, all),
					listing,
					`${source}\n${CREDENTIAL_MARKS}`,
					...catalogRows(unconnected),
					'Pass one as `model` ("provider/id") when you start a task; append :low, :medium or :high to set its thinking.',
				].join("\n\n"),
			);
		},
	});
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

/**
 * Each configured provider (one with a usable model): where its credential comes from and what this process last
 * learned about it. A provider authenticated only by this session's --api-key is listed, but a task cannot run on it.
 */
function providerRows(registry: ModelsContext["modelRegistry"], available: readonly ModelRef[]): string {
	const providers = [...new Set(available.map((model) => model.provider))].sort();
	if (providers.length === 0) return "Providers: none configured; the user connects one with /login.";
	return [
		"Providers (credential source; last result):",
		...providers.map((provider) => {
			const auth = registry.getProviderAuthStatus?.(provider);
			const from =
				auth?.source === "runtime"
					? "--api-key, this session only (tasks cannot use it)"
					: (auth?.label ?? auth?.source);
			return `  ${provider}${from ? ` · ${from}` : ""}${describeHealth(providerHealth.get(provider))}`;
		}),
	].join("\n");
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
