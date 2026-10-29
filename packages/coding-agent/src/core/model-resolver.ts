/**
 * Model resolution, scoping, and initial selection
 */

import type { ThinkingLevel } from "@octocodeai/octocode-agent-core";
import {
	type Api,
	type AuthOperationOptions,
	type KnownProvider,
	type Model,
	modelsAreEqual,
} from "@octocodeai/octocode-ai";
import chalk from "chalk";
import { minimatch } from "minimatch";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import { defaultModelPerProvider } from "./model-resolver/default-models.ts";
import { buildFallbackModel, resolveModelReference, splitThinkingSuffix } from "./model-resolver/reference.ts";
import type { ModelRuntime } from "./model-runtime.ts";

export { defaultModelPerProvider } from "./model-resolver/default-models.ts";
export {
	findExactModelReferenceMatch,
	type ModelReferenceRequest,
	resolveModelReference,
} from "./model-resolver/reference.ts";

export interface ScopedModel {
	model: Model<Api>;
	/** Thinking level if explicitly specified in pattern (e.g., "model:high"), undefined otherwise */
	thinkingLevel?: ThinkingLevel;
}

export interface ModelScopeDiagnostic {
	type: "warning";
	code: "no-match" | "invalid-thinking-level" | "ambiguous";
	message: string;
	pattern: string;
}

export interface ResolveModelScopeResult {
	scopedModels: ScopedModel[];
	diagnostics: ModelScopeDiagnostic[];
}

/**
 * Resolve scope patterns (`--models`, `enabledModels`) to models with optional thinking levels.
 *
 * Every model in `models` is usable, so credentials cannot choose between providers offering the same
 * id. All of them are added, with a warning so the user can pick one with `provider/id`.
 */
export function resolveModelScopeFromModels(
	patterns: string[],
	models: readonly Model<Api>[],
): ResolveModelScopeResult {
	const scopedModels: ScopedModel[] = [];
	const diagnostics: ModelScopeDiagnostic[] = [];
	const add = (model: Model<Api>, thinkingLevel: ThinkingLevel | undefined) => {
		if (!scopedModels.some((scoped) => modelsAreEqual(scoped.model, model))) {
			scopedModels.push({ model, thinkingLevel });
		}
	};
	const noMatch = (pattern: string) =>
		diagnostics.push({ type: "warning", code: "no-match", message: `No models match pattern "${pattern}"`, pattern });
	const ambiguous = (pattern: string, candidates: readonly Model<Api>[]) => {
		const providers = [...new Set(candidates.map((m) => m.provider))].sort((a, b) => a.localeCompare(b));
		diagnostics.push({
			type: "warning",
			code: "ambiguous",
			message: `Pattern "${pattern}" matches several providers: ${providers.join(", ")}. Use provider/id to choose one.`,
			pattern,
		});
	};

	for (const pattern of patterns) {
		// Check if pattern contains glob characters
		if (pattern.includes("*") || pattern.includes("?") || pattern.includes("[")) {
			// Extract optional thinking level suffix (e.g., "provider/*:high")
			const thinking = splitThinkingSuffix(pattern);
			const globPattern = thinking?.base ?? pattern;
			const thinkingLevel = thinking?.thinkingLevel;

			// Ids such as `bracketed-model[1m]` are not globs
			const exact = resolveModelReference(
				{ text: globPattern, thinkingSuffix: "none", fuzzy: false },
				models,
				() => true,
			);
			let matches: readonly Model<Api>[] = [];
			if (exact.status === "resolved") matches = [exact.model];
			else if (exact.status === "ambiguous") {
				matches = exact.candidates;
				ambiguous(pattern, matches);
			} else {
				// Match against "provider/modelId" format OR just model ID
				// This allows "*sonnet*" to match without requiring "anthropic/*sonnet*"
				matches = models.filter(
					(m) =>
						minimatch(`${m.provider}/${m.id}`, globPattern, { nocase: true }) ||
						minimatch(m.id, globPattern, { nocase: true }),
				);
			}
			if (matches.length === 0) noMatch(pattern);
			for (const model of matches) add(model, thinkingLevel);
			continue;
		}

		const result = resolveModelReference({ text: pattern, thinkingSuffix: "lenient", fuzzy: true }, models, () => true);
		if (result.status === "not-found") {
			noMatch(pattern);
			continue;
		}
		if (result.warning) {
			diagnostics.push({ type: "warning", code: "invalid-thinking-level", message: result.warning, pattern });
		}
		if (result.status === "ambiguous") ambiguous(pattern, result.candidates);
		const matches = result.status === "resolved" ? [result.model] : result.candidates;
		for (const model of matches) add(model, result.thinkingLevel);
	}

	return { scopedModels, diagnostics };
}

export async function resolveModelScopeWithDiagnostics(
	patterns: string[],
	modelRuntime: ModelRuntime,
	options?: AuthOperationOptions,
): Promise<ResolveModelScopeResult> {
	return resolveModelScopeFromModels(patterns, await modelRuntime.getAvailable(undefined, options));
}

export async function resolveModelScope(
	patterns: string[],
	modelRuntime: ModelRuntime,
	options?: AuthOperationOptions,
): Promise<ScopedModel[]> {
	const { scopedModels, diagnostics } = await resolveModelScopeWithDiagnostics(patterns, modelRuntime, options);
	for (const diagnostic of diagnostics) {
		console.warn(chalk.yellow(`Warning: ${diagnostic.message}`));
	}
	return scopedModels;
}

export interface ResolveCliModelResult {
	model: Model<Api> | undefined;
	thinkingLevel?: ThinkingLevel;
	warning: string | undefined;
	/**
	 * Error message suitable for CLI display.
	 * When set, model will be undefined.
	 */
	error: string | undefined;
}

/**
 * Resolve a single model from CLI flags.
 *
 * Supports:
 * - --provider <provider> --model <pattern>
 * - --model <provider>/<pattern>
 * - Fuzzy matching (same rules as model scoping: exact id, then partial id/name)
 *
 * Note: This does not apply the thinking level by itself, but it may *parse* and
 * return a thinking level from "<pattern>:<thinking>" so the caller can apply it.
 */
export function resolveCliModel(options: {
	cliProvider?: string;
	cliModel?: string;
	cliThinking?: ThinkingLevel;
	/** `--api-key` was supplied for the selected provider. */
	inlineApiKey?: boolean;
	modelRuntime: ModelRuntime;
}): ResolveCliModelResult {
	const { cliProvider, cliModel, cliThinking, inlineApiKey, modelRuntime } = options;

	if (!cliModel) {
		return { model: undefined, warning: undefined, error: undefined };
	}

	// Important: use *all* models here, not just models with pre-configured auth.
	// This allows "--api-key" to be used for first-time setup.
	const models = [...modelRuntime.getModels()];
	if (models.length === 0) {
		return {
			model: undefined,
			warning: undefined,
			error: "No models available. Check your installation or add models to models.json.",
		};
	}

	const provider = cliProvider
		? models.find((m) => m.provider.toLowerCase() === cliProvider.toLowerCase())?.provider
		: undefined;
	if (cliProvider && !provider) {
		return {
			model: undefined,
			warning: undefined,
			error: `Unknown provider "${cliProvider}". Use --list-models to see available providers/models.`,
		};
	}

	const result = resolveModelReference(
		{ text: cliModel, provider, thinkingSuffix: "strict", fuzzy: true },
		models,
		// An inline key goes to whichever provider is selected, so stored credentials must not choose it
		inlineApiKey ? () => false : (providerId) => modelRuntime.hasConfiguredAuth(providerId),
	);
	if (result.status === "resolved") {
		return { model: result.model, thinkingLevel: result.thinkingLevel, warning: result.warning, error: undefined };
	}
	if (result.status === "ambiguous") {
		const matches = result.candidates
			.map((m) => `${m.provider}/${m.id}`)
			.sort((a, b) => a.localeCompare(b))
			.join(", ");
		const authHint = inlineApiKey
			? "--api-key does not choose a provider."
			: result.usableCount === 0
				? "No matching provider is authenticated."
				: "More than one matching provider is authenticated.";
		return {
			model: undefined,
			warning: undefined,
			error: `Model "${cliModel}" is ambiguous across providers: ${matches}. ${authHint} Use --provider or provider/model.`,
		};
	}

	const { target } = result;
	if (!target) {
		return {
			model: undefined,
			warning: undefined,
			error: `Model "${cliModel}" not found. Use --list-models to see available models.`,
		};
	}

	// Use the thinking level suffix only when --thinking is not explicitly provided; otherwise it
	// stays part of the custom model id.
	// e.g. "zai-org/GLM-5.1-FP8:high" → modelId="zai-org/GLM-5.1-FP8", fallbackThinking="high"
	const modelId = cliThinking ? target.modelText : target.modelId;
	const fallbackThinking = cliThinking ? undefined : target.thinkingLevel;
	const fallbackModel = buildFallbackModel(target.providerModels, modelId);
	const requestedThinking = cliThinking ?? fallbackThinking;
	return {
		model: requestedThinking && requestedThinking !== "off" ? { ...fallbackModel, reasoning: true } : fallbackModel,
		thinkingLevel: fallbackThinking,
		warning: `Model "${modelId}" not found for provider "${target.provider}". Using custom model id.`,
		error: undefined,
	};
}

export interface InitialModelResult {
	model: Model<Api> | undefined;
	thinkingLevel: ThinkingLevel;
	fallbackMessage: string | undefined;
}

/**
 * Find the initial model to use based on priority:
 * 1. First model from scoped models (if not continuing/resuming)
 * 2. Saved default from settings
 * 3. The default provider's model: the user's `providerModels` entry, then the built-in default
 * 4. The first connected provider's model, in the same order, then the first available model
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
		modelRuntime,
	} = options;

	let model: Model<Api> | undefined;
	let thinkingLevel: ThinkingLevel = DEFAULT_THINKING_LEVEL;

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

	// 2. Try saved default from settings if auth is configured.
	if (defaultProvider && defaultModelId) {
		const found = modelRuntime.getModel(defaultProvider, defaultModelId);
		if (found && modelRuntime.hasConfiguredAuth(found.provider)) {
			model = found;
			const perModel = modelThinkingLevels?.[`${defaultProvider}/${defaultModelId}`];
			if (perModel) {
				thinkingLevel = perModel;
			} else if (defaultThinkingLevel) {
				thinkingLevel = defaultThinkingLevel;
			}
			return { model, thinkingLevel, fallbackMessage: undefined };
		}
	}

	const availableModels = [...modelRuntime.getAvailableSnapshot()];
	const withLevel = (match: Model<Api>): InitialModelResult => ({
		model: match,
		thinkingLevel: DEFAULT_THINKING_LEVEL,
		fallbackMessage: undefined,
	});
	const providerDefault = (provider: string) =>
		[providerModels[provider], defaultModelPerProvider[provider as KnownProvider]]
			.filter((id): id is string => Boolean(id))
			.map((id) => availableModels.find((m) => m.provider === provider && m.id === id))
			.find((match) => match !== undefined);

	// 3. The default provider's model when no default model applies.
	const defaultProviderMatch = defaultProvider ? providerDefault(defaultProvider) : undefined;
	if (defaultProviderMatch) return withLevel(defaultProviderMatch);

	// 4. Try first available model with valid API key
	if (availableModels.length > 0) {
		// The user's per-provider defaults first, then the built-in ones
		for (const provider of [...Object.keys(providerModels), ...Object.keys(defaultModelPerProvider)]) {
			const match = providerDefault(provider);
			if (match) return withLevel(match);
		}

		// If no default found, use first available
		return { model: availableModels[0], thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
	}

	// 5. No model found
	return { model: undefined, thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
}
