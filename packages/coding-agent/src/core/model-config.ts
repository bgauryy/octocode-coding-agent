/** Immutable, credential-blind models.json snapshot. */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ProviderCompatSchema } from "@octocodeai/octocode-ai/providers/compat-schema";
import {
	ModelCostSchema,
	ModelInputLimitsSchema,
	ModelInputModalitySchema,
	ModelPromptCacheSchema,
	ThinkingLevelMapSchema,
} from "@octocodeai/octocode-ai/providers/model-schema";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { formatValidationPath } from "@octocodeai/octocode-ai/utils/validation";
import { getModelsPath, providerFallbackDirs } from "../config.ts";
import { configDiscovery, discoveryInput } from "./discovery/service.ts";
import { providerSourceGate } from "./provider-sources/gate.ts";
import { jsonErrorLocation, stripJsonComments } from "@octocodeai/octocode-common/json";
import { normalizePath } from "@octocodeai/octocode-common/paths";
import { stripBom } from "@octocodeai/octocode-common/text";
import { urlCredentialProblem } from "@octocodeai/octocode-common/url-credentials";
import { CachePreferenceProperties } from "./cache-preferences-schema.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { modelsJsonWarnings, type ModelsJsonFieldNames } from "./model-config/warnings.ts";
import { isCommandConfigValue } from "@octocodeai/octocode-ai/utils/resolve-config-value";
import { officialEntryProblem } from "./model-config/builtin-guard.ts";
import { type ModelsProject, projectShadowWarning, untrustedProjectModelsWarning } from "./model-config/project.ts";

const SamplingParamsSchema = Type.Record(Type.String(), Type.Unknown());
const SamplingParamsByThinkingLevelSchema = Type.Object(
	{
		off: Type.Optional(SamplingParamsSchema),
		minimal: Type.Optional(SamplingParamsSchema),
		low: Type.Optional(SamplingParamsSchema),
		medium: Type.Optional(SamplingParamsSchema),
		high: Type.Optional(SamplingParamsSchema),
		xhigh: Type.Optional(SamplingParamsSchema),
		max: Type.Optional(SamplingParamsSchema),
	},
	{ description: "samplingParams per thinking level, merged over samplingParams." },
);

const SamplingParamsFieldSchema = Type.Record(Type.String(), Type.Unknown(), {
	description: "Fields merged into every request body. Applies only to OpenAI-compatible APIs.",
});
const HeadersSchema = Type.Record(Type.String(), Type.String(), {
	description: "Request headers. Values resolve like apiKey.",
});

/** Model fields shared by models entries and modelOverrides entries. Defaults apply only to models entries. */
const ModelFieldDescriptions = {
	name: "Display name, also matched by --model patterns.",
	reasoning: "Whether the model supports thinking.",
	contextWindow: "Context window in tokens.",
	maxTokens: "Maximum output tokens.",
	input: 'Accepted input modalities. Include "image" only when this model and endpoint accept image attachments.',
} as const;

const ModelDefinitionSchema = Type.Object({
	...CachePreferenceProperties,
	id: Type.String({ minLength: 1, description: "Model ID sent to the API." }),
	name: Type.Optional(Type.String({ minLength: 1, description: ModelFieldDescriptions.name })),
	api: Type.Optional(Type.String({ minLength: 1, description: "Overrides the provider api." })),
	baseUrl: Type.Optional(Type.String({ minLength: 1, description: "Overrides the provider baseUrl." })),
	reasoning: Type.Optional(Type.Boolean({ default: false, description: ModelFieldDescriptions.reasoning })),
	thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema),
	input: Type.Optional(
		Type.Array(ModelInputModalitySchema, { default: ["text"], description: ModelFieldDescriptions.input }),
	),
	inputLimits: Type.Optional(ModelInputLimitsSchema),
	cost: Type.Optional(ModelCostSchema),
	promptCache: Type.Optional(ModelPromptCacheSchema),
	contextWindow: Type.Optional(
		Type.Number({ exclusiveMinimum: 0, default: 128000, description: ModelFieldDescriptions.contextWindow }),
	),
	maxTokens: Type.Optional(
		Type.Number({ exclusiveMinimum: 0, default: 16384, description: ModelFieldDescriptions.maxTokens }),
	),
	samplingParams: Type.Optional(SamplingParamsFieldSchema),
	samplingParamsByThinkingLevel: Type.Optional(SamplingParamsByThinkingLevelSchema),
	headers: Type.Optional(HeadersSchema),
	compat: Type.Optional(ProviderCompatSchema),
});

const ModelOverrideSchema = Type.Object({
	...CachePreferenceProperties,
	name: Type.Optional(Type.String({ minLength: 1, description: ModelFieldDescriptions.name })),
	reasoning: Type.Optional(Type.Boolean({ description: ModelFieldDescriptions.reasoning })),
	thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema),
	input: Type.Optional(Type.Array(ModelInputModalitySchema, { description: ModelFieldDescriptions.input })),
	inputLimits: Type.Optional(ModelInputLimitsSchema),
	cost: Type.Optional(Type.Partial(ModelCostSchema)),
	promptCache: Type.Optional(ModelPromptCacheSchema),
	contextWindow: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: ModelFieldDescriptions.contextWindow })),
	maxTokens: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: ModelFieldDescriptions.maxTokens })),
	samplingParams: Type.Optional(SamplingParamsFieldSchema),
	samplingParamsByThinkingLevel: Type.Optional(SamplingParamsByThinkingLevelSchema),
	headers: Type.Optional(HeadersSchema),
	compat: Type.Optional(ProviderCompatSchema),
});

const ProviderConfigSchema = Type.Object({
	...CachePreferenceProperties,
	name: Type.Optional(Type.String({ minLength: 1, description: "Display name." })),
	baseUrl: Type.Optional(
		Type.String({ minLength: 1, description: "API base URL. Also applies to the provider's built-in models." }),
	),
	apiKey: Type.Optional(
		Type.String({
			minLength: 1,
			description:
				'Literal key, "$NAME" environment interpolation, or "!command" output (the command runs on first use, not at startup).',
		}),
	),
	api: Type.Optional(
		Type.String({
			minLength: 1,
			description:
				'API for the provider\'s models, such as "openai-completions", "openai-responses", "anthropic-messages", or "google-generative-ai".',
		}),
	),
	headers: Type.Optional(HeadersSchema),
	compat: Type.Optional(ProviderCompatSchema),
	authHeader: Type.Optional(
		Type.Boolean({ default: false, description: "Whether to send the resolved API key as Authorization: Bearer." }),
	),
	models: Type.Optional(Type.Array(ModelDefinitionSchema)),
	modelOverrides: Type.Optional(Type.Record(Type.String(), ModelOverrideSchema)),
});

const ModelsConfigProperties = {
	providers: Type.Record(Type.String(), ProviderConfigSchema),
};

export const ModelsConfigSchema = Type.Object({
	$schema: Type.Optional(Type.String()),
	...ModelsConfigProperties,
});

/** Entry schemas rendered into docs/models-configuration.md. */
export const ModelsJsonSchemas = {
	provider: ProviderConfigSchema,
	model: ModelDefinitionSchema,
	modelOverride: ModelOverrideSchema,
};

const validateModelsConfig = Compile(ModelsConfigSchema);

const FIELD_NAMES: ModelsJsonFieldNames = {
	root: Object.keys(ModelsConfigSchema.properties),
	provider: Object.keys(ProviderConfigSchema.properties),
	model: Object.keys(ModelDefinitionSchema.properties),
	modelOverride: Object.keys(ModelOverrideSchema.properties),
};

export type ModelsJsonModel = Static<typeof ModelDefinitionSchema>;
export type ModelsJsonModelOverride = Static<typeof ModelOverrideSchema>;
export type ModelsJsonProvider = Static<typeof ProviderConfigSchema>;

function usesSecretCommand(provider: ModelsJsonProvider): boolean {
	const commandHeader = (headers?: Record<string, string>) => Object.values(headers ?? {}).some(isCommandConfigValue);
	return (
		(!!provider.apiKey && isCommandConfigValue(provider.apiKey)) ||
		commandHeader(provider.headers) ||
		(provider.models ?? []).some((model) => commandHeader(model.headers)) ||
		Object.values(provider.modelOverrides ?? {}).some((model) => commandHeader(model.headers))
	);
}

/** Every baseUrl that carries a credential, as `providers.<id>.baseUrl` paths and what is wrong; never the URL itself. */
function baseUrlCredentialErrors(providers: Record<string, ModelsJsonProvider>): string[] {
	const errors: string[] = [];
	for (const [providerId, provider] of Object.entries(providers)) {
		const fields: [string, string | undefined][] = [
			[`providers.${providerId}.baseUrl`, provider.baseUrl],
			...(provider.models ?? []).map((model): [string, string | undefined] => [
				`providers.${providerId}.models[${model.id}].baseUrl`,
				model.baseUrl,
			]),
		];
		for (const [field, value] of fields) {
			const problem = value === undefined ? undefined : urlCredentialProblem(value);
			if (problem) {
				errors.push(`  - ${field}: ${problem}; put the key in apiKey or headers instead`);
			}
		}
	}
	return errors;
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

/** One immutable load of models.json. */
export class ModelConfig {
	private readonly providers: ReadonlyMap<string, ModelsJsonProvider>;
	private readonly error: string | undefined;
	private readonly warnings: readonly string[];
	private readonly files: ReadonlyMap<string, string>;
	private readonly refusals: readonly string[];

	private constructor(
		providers: ReadonlyMap<string, ModelsJsonProvider>,
		error?: string,
		warnings: readonly string[] = [],
		files: ReadonlyMap<string, string> = new Map(),
		refusals: readonly string[] = [],
	) {
		this.providers = providers;
		this.error = error;
		this.warnings = warnings;
		this.files = files;
		this.refusals = refusals;
	}

	/**
	 * Octocode's own models.json merged with the project's and Pi's. The first definition of a provider wins, in the
	 * order discovery ranks the files: Octocode's project file, Pi's project file, Octocode's global file, Pi's global
	 * files. So a trusted project overrides the global files for the same provider id (its `baseUrl` and `models`
	 * included) and Octocode's file outranks Pi's at each scope. A project file of a folder that is not trusted is not read;
	 * a warning says so.
	 */
	static async load(modelsJsonPath: string | undefined, project?: ModelsProject): Promise<ModelConfig> {
		if (!modelsJsonPath) return new ModelConfig(new Map());
		let paths = [modelsJsonPath];
		// Files read as Pi's (an official provider id in them is skipped with a warning, not refused).
		const fallbackFiles = new Set<string>();
		const projectFiles = new Set<string>();
		const notices: string[] = [];
		if (resolve(normalizePath(modelsJsonPath)) === resolve(getModelsPath())) {
			const input = discoveryInput({
				cwd: project?.cwd ?? process.cwd(),
				agentDir: dirname(getModelsPath()),
				projectTrusted: project?.isTrusted() ?? false,
				includeUntrusted: project !== undefined,
				piRoots: providerSourceGate.isEnabled("pi") ? providerFallbackDirs() : [],
			});
			const own = resolve(modelsJsonPath);
			const ranked: string[] = [];
			for (const { loaded, provenance } of configDiscovery.discover("model", input)) {
				if (!loaded) {
					if (provenance.notLoaded === "untrusted")
						notices.push(untrustedProjectModelsWarning(provenance.path, input.cwd));
					continue;
				}
				ranked.push(provenance.path);
				if (provenance.product === "pi") fallbackFiles.add(provenance.path);
				if (provenance.scope === "project") projectFiles.add(provenance.path);
			}
			// Octocode's global file is always read, even when it does not exist yet; it keeps its rank among the others.
			paths = ranked.some((file) => resolve(file) === own) ? ranked : [...ranked, modelsJsonPath];
		}
		const providers = new Map<string, ModelsJsonProvider>();
		const files = new Map<string, string>();
		const errors: string[] = [];
		const warnings: string[] = [...notices];
		const refusals: string[] = [];
		// Files load concurrently; merging walks them in precedence order, so the first definition still wins and
		// errors and warnings keep file order. Pi's files are never ours to fix: an official id there is a warning.
		const configs = await Promise.all(
			paths.map((file) => ModelConfig.loadFile(file, { fallback: fallbackFiles.has(file) })),
		);
		for (const [index, config] of configs.entries()) {
			const isProject = projectFiles.has(paths[index]!);
			// An unreadable project file is skipped, not fatal: the global providers keep loading.
			if (config.error) {
				if (isProject) warnings.push(`Project models.json skipped: ${config.error}`);
				else errors.push(config.error);
			}
			warnings.push(...config.warnings);
			refusals.push(...config.refusals);
			for (const [id, provider] of config.providers) {
				const file = config.files.get(id);
				const winner = providers.get(id);
				if (winner) {
					const winnerFile = files.get(id);
					if (!isProject && winnerFile && projectFiles.has(winnerFile))
						warnings.push(
							projectShadowWarning(id, winnerFile, file ?? paths[index]!, winner.baseUrl, provider.baseUrl),
						);
					continue;
				}
				providers.set(id, provider);
				if (file) files.set(id, file);
			}
		}
		return new ModelConfig(providers, errors.length ? errors.join("\n\n") : undefined, warnings, files, refusals);
	}

	/**
	 * One file alone: unlike `load`, Octocode's own file is not merged with Pi's, so its providers are its own.
	 * An entry with an official provider's id is refused (`getError` says why, the rest of the file loads); with
	 * `fallback` (a Pi file) it is skipped with a warning instead.
	 */
	static async loadFile(modelsJsonPath: string, options?: { fallback?: boolean }): Promise<ModelConfig> {
		const path = normalizePath(modelsJsonPath);
		let content: string;
		try {
			content = await readFile(path, "utf-8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return new ModelConfig(new Map());
			return new ModelConfig(new Map(), `Failed to load models.json: ${errorMessage(error)}\n\nFile: ${path}`);
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(stripJsonComments(stripBom(content)));
		} catch (error) {
			return new ModelConfig(new Map(), `Failed to parse models.json: ${jsonErrorLocation(error)}\n\nFile: ${path}`);
		}

		if (!validateModelsConfig.Check(parsed)) {
			const errors =
				validateModelsConfig
					.Errors(parsed)
					.map((error) => `  - ${formatValidationPath(error)}: ${error.message}`)
					.join("\n") || "Unknown schema error";
			return new ModelConfig(new Map(), `Invalid models.json schema:\n${errors}\n\nFile: ${path}`);
		}

		const credentialErrors = baseUrlCredentialErrors(parsed.providers);
		if (credentialErrors.length > 0) {
			return new ModelConfig(
				new Map(),
				`Invalid models.json: a baseUrl must not carry credentials:\n${credentialErrors.join("\n")}\n\nFile: ${path}`,
			);
		}

		const providers = new Map<string, ModelsJsonProvider>();
		const refusals: string[] = [];
		for (const [providerId, provider] of Object.entries(parsed.providers)) {
			const problem =
				options?.fallback && usesSecretCommand(provider)
					? `Skipped provider "${providerId}" in ${path}: configure its secret command directly in Octocode.`
					: officialEntryProblem(providerId, provider, path);
			if (problem) {
				refusals.push(problem);
				continue;
			}
			providers.set(providerId, deepFreeze(structuredClone(provider)));
		}
		const warnings = modelsJsonWarnings(parsed, path, FIELD_NAMES);
		if (options?.fallback) warnings.push(...refusals.map((problem) => `${problem} Pi's file is left as it is.`));
		return new ModelConfig(
			providers,
			undefined,
			warnings,
			new Map([...providers.keys()].map((id) => [id, path])),
			options?.fallback ? [] : refusals,
		);
	}

	getProvider(providerId: string): ModelsJsonProvider | undefined {
		return this.providers.get(providerId);
	}

	/** The models.json file whose definition of the provider is the one in use. */
	getProviderFile(providerId: string): string | undefined {
		return this.files.get(providerId);
	}

	getProviderIds(): readonly string[] {
		return [...this.providers.keys()];
	}

	/** What the files could not load: unreadable or invalid files, then refused official-provider entries. */
	getError(): string | undefined {
		const messages = [...(this.error ? [this.error] : []), ...this.refusals];
		return messages.length > 0 ? messages.join("\n\n") : undefined;
	}

	/** Whether a file could not be read or parsed at all; refused entries leave the rest of their file loaded. */
	isUnreadable(): boolean {
		return this.error !== undefined;
	}

	/**
	 * What the files load despite: fields the schema does not know (a misspelled `apikey`) and `api` values no built-in
	 * API serves. Each names its file and provider. Unlike `getError`, nothing is dropped.
	 */
	getWarnings(): readonly string[] {
		return this.warnings;
	}
}
