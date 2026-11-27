/**
 * Model resolution, scoping, and initial selection
 */

import type { ThinkingLevel } from "@octocodeai/octocode-agent-core";
import { type Api, type AuthOperationOptions, type Model, modelsAreEqual } from "@octocodeai/octocode-ai";
import { cliStyle } from "../utils/cli-style.ts";
import { minimatch } from "minimatch";
import { hasGlob, splitThinkingSuffix } from "./model-reference.ts";
import { buildFallbackModel, resolveModelReference } from "./model-resolver/reference.ts";
import type { ScopedModel } from "./model-resolver/scoped-model.ts";
import { didYouMean, nearestModelIds } from "./model-resolver/suggestions.ts";
import type { ModelRuntime } from "./model-runtime.ts";

export { defaultModelPerProvider } from "./model-resolver/default-models.ts";
export { findInitialModel } from "./model-resolver/initial-model.ts";
export type { ScopedModel } from "./model-resolver/scoped-model.ts";
export {
	findExactModelReferenceMatch,
	type ModelReferenceRequest,
	resolveModelReference,
} from "./model-resolver/reference.ts";

interface ModelScopeDiagnostic {
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
		if (hasGlob(pattern)) {
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
		process.stderr.write(`${cliStyle.warn(`Warning: ${diagnostic.message}`)}\n`);
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

const withTrustHint = (message: string, hint: string | undefined): string => (hint ? `${message} ${hint}` : message);

/** The trust hint for `--model` text, which may be `provider/model`, when only an untrusted workspace file defines it. */
function untrustedModelHint(runtime: ModelRuntime, cliProvider: string | undefined, text: string): string | undefined {
	const slash = text.indexOf("/");
	return (
		runtime.getModelsDiagnostics().untrustedHint(cliProvider, text) ??
		(slash > 0 && !cliProvider
			? runtime.getModelsDiagnostics().untrustedHint(text.slice(0, slash), text.slice(slash + 1))
			: undefined)
	);
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
			error: withTrustHint(
				`Unknown provider "${cliProvider}". Use --list-models to see available providers/models.`,
				modelRuntime.getModelsDiagnostics().untrustedHint(cliProvider),
			),
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
			error: withTrustHint(
				`Model "${cliModel}" not found. Use --list-models to see available models.`,
				untrustedModelHint(modelRuntime, cliProvider, cliModel),
			),
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
		warning: `Model "${modelId}" not found for provider "${target.provider}". Using custom model id.${didYouMean(nearestModelIds(modelId, target.providerModels))}`,
		error: undefined,
	};
}

/** What a vendor whose plan forbids unattended use allows. */
const INTERACTIVE_ONLY = "the vendor's plan allows interactive use only";

/**
 * The one-line notice for an unattended run on `model` when its provider's plan allows interactive use only. It is a
 * notice, not a refusal: the model the user named (or the only one available) still runs.
 */
export function unattendedUseNotice(
	model: Pick<Model<Api>, "provider" | "id">,
	modelRuntime: Pick<ModelRuntime, "allowsUnattendedUse">,
): string | undefined {
	if (modelRuntime.allowsUnattendedUse(model.provider)) return undefined;
	return `${model.provider}/${model.id}: ${INTERACTIVE_ONLY}, not unattended runs like this one.`;
}
