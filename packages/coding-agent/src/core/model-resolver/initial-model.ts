/**
 * The model a session starts on when the command line names none: the scope's first, the saved default, the default
 * provider's, then the first connected provider's.
 */

import type { ThinkingLevel } from "@octocodeai/octocode-agent-core";
import type { Api, KnownProvider, Model } from "@octocodeai/octocode-ai";
import { DEFAULT_THINKING_LEVEL } from "../defaults.ts";
import type { ModelRuntime } from "../model-runtime.ts";
import { defaultModelPerProvider, ownProviderDefault } from "./default-models.ts";
import { savedDefaultNotice } from "./fallback-notice.ts";
import type { ScopedModel } from "./scoped-model.ts";
import { isVirtualModel } from "../virtual-models.ts";

export interface InitialModelResult {
	model: Model<Api> | undefined;
	thinkingLevel: ThinkingLevel;
	/** Set when a saved default was not used: why, and the model used instead (`savedDefaultNotice`). */
	fallbackMessage: string | undefined;
}

/**
 * Find the initial model to use based on priority:
 * 1. First model from scoped models (if not continuing/resuming)
 * 2. Saved default from settings
 * 3. The default provider's model: the user's `providerModels` entry, then the built-in default
 * 4. The first connected provider's model, in the same order, a plan-billed provider (`getProviderBilling`) before a
 *    metered one, then the first available model
 *
 * An `unattended` run (print mode, an ACP server's session) skips, in step 4, providers whose plan allows interactive use
 * only (`ModelRuntime.allowsUnattendedUse`), and takes one of them only when no other model is available. Steps 1 to 3
 * are models the user named, so they still apply; `unattendedUseNotice` is the line that says so.
 *
 * Steps 3 and 4 never choose a model models.dev lists as deprecated (`ModelRuntime.isModelDeprecated`): it may stop
 * answering. A model the user named by exact id (the scope, the saved default, a `providerModels` entry) still applies,
 * and a deprecated model is taken only when nothing else is available.
 */
export async function findInitialModel(options: {
	scopedModels: ScopedModel[];
	isContinuing: boolean;
	defaultProvider?: string;
	defaultModelId?: string;
	defaultThinkingLevel?: ThinkingLevel;
	modelThinkingLevels?: Record<string, ThinkingLevel>;
	/** The user's default model id per provider (`providerModels`). */
	providerModels?: Record<string, string>;
	/** No one watches the run (print mode, an ACP server): automatic choice skips interactive-only plans. */
	unattended?: boolean;
	modelRuntime: ModelRuntime;
}): Promise<InitialModelResult> {
	const {
		scopedModels,
		isContinuing,
		defaultProvider,
		defaultModelId,
		defaultThinkingLevel,
		modelThinkingLevels,
		providerModels = {},
		unattended = false,
		modelRuntime,
	} = options;

	// 1. Use first model from scoped models (skip if continuing/resuming)
	if (scopedModels.length > 0 && !isContinuing) {
		const scopedModel = scopedModels[0];
		const perModel = modelThinkingLevels?.[`${scopedModel.model.provider}/${scopedModel.model.id}`];
		return {
			model: scopedModel.model,
			thinkingLevel: scopedModel.thinkingLevel ?? perModel ?? defaultThinkingLevel ?? DEFAULT_THINKING_LEVEL,
			fallbackMessage: undefined,
		};
	}

	const availableModels = [...modelRuntime.getAvailableSnapshot()];
	// 2. A saved default must still be available; stored credentials do not re-enable a disabled or paused provider.
	if (defaultProvider && defaultModelId) {
		const found = availableModels.find(
			(candidate) => candidate.provider === defaultProvider && candidate.id === defaultModelId,
		);
		if (found && modelRuntime.hasConfiguredAuth(found.provider)) {
			const perModel = modelThinkingLevels?.[`${defaultProvider}/${defaultModelId}`];
			return {
				model: found,
				thinkingLevel: perModel ?? defaultThinkingLevel ?? DEFAULT_THINKING_LEVEL,
				fallbackMessage: undefined,
			};
		}
	}

	// A saved default that step 2 did not return is never replaced silently: the notice says why and what runs instead.
	const saved = defaultProvider && defaultModelId ? { provider: defaultProvider, modelId: defaultModelId } : undefined;
	const withLevel = (match: Model<Api> | undefined): InitialModelResult => ({
		model: match,
		thinkingLevel: DEFAULT_THINKING_LEVEL,
		fallbackMessage: saved && savedDefaultNotice(modelRuntime, saved, match),
	});
	// Only when every available model is deprecated does one of them start the session.
	const current = availableModels.filter((model) => !modelRuntime.isModelDeprecated(model));
	const choosable = current.length > 0 ? current : availableModels;
	const providerDefault = (provider: string) => {
		const own = providerModels[provider];
		const named = own && availableModels.find((m) => m.provider === provider && m.id === own);
		if (named) return named;
		const builtin = defaultModelPerProvider[provider as KnownProvider];
		return builtin ? choosable.find((m) => m.provider === provider && m.id === builtin) : undefined;
	};

	// 3. The default provider's model when no default model applies. A provider with no built-in default (a gateway in
	// models.json) uses its model that is some vendor's default, else its first: never another provider's model.
	const defaultProviderMatch = defaultProvider
		? (providerDefault(defaultProvider) ?? ownProviderDefault(choosable, defaultProvider))
		: undefined;
	if (defaultProviderMatch) return withLevel(defaultProviderMatch);

	// 4. Try the first available physical model with valid auth. Virtual routers are explicit choices: without a
	// physical model, registering one must not turn it into the implicit default. Unattended runs try allowed plans first.
	const automatic = choosable.filter((model) => !isVirtualModel(model));
	const allowed = (provider: string) => !unattended || modelRuntime.allowsUnattendedUse(provider);
	for (const pass of unattended ? [true, false] : [true]) {
		const candidates = automatic.filter((m) => allowed(m.provider) === pass);
		if (candidates.length === 0) continue;
		// The user's per-provider defaults first, then the built-in ones; a provider a subscription pays for comes before a
		// metered one, so a first message does not spend per-token credit while a plan is signed in.
		const providers = [...Object.keys(providerModels), ...Object.keys(defaultModelPerProvider)];
		for (const billing of ["plan", "metered"] as const) {
			for (const provider of providers) {
				if (allowed(provider) !== pass || modelRuntime.getProviderBilling(provider) !== billing) continue;
				const match = providerDefault(provider);
				if (match) return withLevel(match);
			}
			// CLI and custom providers may have no named default; a connected plan still comes before metered credit.
			const fallback = candidates.find((candidate) => modelRuntime.getProviderBilling(candidate.provider) === billing);
			if (fallback) return withLevel(fallback);
		}
	}

	// 5. No model found
	return withLevel(undefined);
}
