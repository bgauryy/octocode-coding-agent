/** Immutable, credential-blind models.json snapshot. */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ProviderCompatSchema } from "@octocodeai/octocode-ai/providers/compat-schema";
import {
	ModelCostSchema,
	ModelInputLimitsSchema,
	ModelInputModalitySchema,
	ModelPromptCacheSchema,
	ProviderProfileSchema,
	ThinkingLevelMapSchema,
} from "@octocodeai/octocode-ai/providers/model-schema";
import { type Static, Type } from "typebox";
import { formatValidationPath } from "@octocodeai/octocode-ai/utils/validation";
import { compileLazily } from "../utils/compile-lazily.ts";
import { getModelsPath, providerFallbackDirs } from "../config.ts";
import { configDiscovery, discoveryInput } from "./discovery/service.ts";
import { providerSourceGate } from "./provider-sources/gate.ts";
import { jsonErrorLocation, stripJsonComments } from "@octocodeai/octocode-common/json";
import { normalizePath } from "@octocodeai/octocode-common/paths";
import { stripBom } from "@octocodeai/octocode-common/text";
import { CachePreferenceProperties } from "./cache-preferences-schema.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { modelsJsonWarnings, type ModelsJsonFieldNames } from "./model-config/warnings.ts";
import { ProviderCredentialProperties } from "./model-config/credentials.ts";
import { baseUrlCredentialErrors, deepFreeze, usesSecretCommand } from "./model-config/provider-checks.ts";
import { officialEntryProblem } from "./model-config/builtin-guard.ts";
import { ModelsDiagnostics, type ModelsProject, untrustedProjectModelsWarning } from "./model-config/project.ts";

import {
	HeadersSchema,
	ModelFieldDescriptions,
	RequestsPerMinuteSchema,
	SamplingParamsByThinkingLevelSchema,
	SamplingParamsFieldSchema,
	TokensPerMinuteSchema,
} from "./model-config/schema-parts.ts";
import { mergeProviderScopes, type ScopedDefinition } from "./model-config/scope-merge.ts";

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
	requestsPerMinute: Type.Optional(RequestsPerMinuteSchema),
	tokensPerMinute: Type.Optional(TokensPerMinuteSchema),
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
	requestsPerMinute: Type.Optional(RequestsPerMinuteSchema),
	tokensPerMinute: Type.Optional(TokensPerMinuteSchema),
});

/** Model fields a provider sets once for all its models; a model's own entry or override wins. */
const ProviderDefaultsSchema = Type.Object(
	{
		reasoning: Type.Optional(Type.Boolean({ description: ModelFieldDescriptions.reasoning })),
		thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema),
		input: Type.Optional(Type.Array(ModelInputModalitySchema, { description: ModelFieldDescriptions.input })),
		inputLimits: Type.Optional(ModelInputLimitsSchema),
		cost: Type.Optional(ModelCostSchema),
		promptCache: Type.Optional(ModelPromptCacheSchema),
		contextWindow: Type.Optional(
			Type.Number({ exclusiveMinimum: 0, description: ModelFieldDescriptions.contextWindow }),
		),
		maxTokens: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: ModelFieldDescriptions.maxTokens })),
		samplingParams: Type.Optional(SamplingParamsFieldSchema),
		samplingParamsByThinkingLevel: Type.Optional(SamplingParamsByThinkingLevelSchema),
		compat: Type.Optional(ProviderCompatSchema),
	},
	{
		description:
			"Fields applied to every model of this provider, built-in and custom. A model's own field wins, then its modelOverrides entry, then these defaults, then built-in model data.",
	},
);

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
				'Literal key, "$NAME" environment interpolation, "!command" output (the command runs on first use, not at startup), or "keychain:<name>" (the system keychain entry of service octocode, account <name>).',
		}),
	),
	...ProviderCredentialProperties,
	api: Type.Optional(
		Type.String({
			minLength: 1,
			description:
				'API for the provider\'s models, such as "openai-completions", "openai-responses", "anthropic-messages", or "google-generative-ai".',
		}),
	),
	headers: Type.Optional(HeadersSchema),
	compat: Type.Optional(ProviderCompatSchema),
	requestsPerMinute: Type.Optional(RequestsPerMinuteSchema),
	tokensPerMinute: Type.Optional(TokensPerMinuteSchema),
	profile: Type.Optional(ProviderProfileSchema),
	defaults: Type.Optional(ProviderDefaultsSchema),
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
	defaults: ProviderDefaultsSchema,
};

/** The models.json validator, shared with the `/providers` editor (`provider-templates/models-file.ts`). */
export const modelsConfigValidator = compileLazily(ModelsConfigSchema);

const FIELD_NAMES: ModelsJsonFieldNames = {
	root: Object.keys(ModelsConfigSchema.properties),
	provider: Object.keys(ProviderConfigSchema.properties),
	model: Object.keys(ModelDefinitionSchema.properties),
	modelOverride: Object.keys(ModelOverrideSchema.properties),
};

export type ModelsJsonModel = Static<typeof ModelDefinitionSchema>;
export type ModelsJsonModelOverride = Static<typeof ModelOverrideSchema>;
export type ModelsJsonProvider = Static<typeof ProviderConfigSchema>;
export type ModelsJsonProviderDefaults = Static<typeof ProviderDefaultsSchema>;

/** One immutable load of models.json. */
export class ModelConfig {
	private readonly providers: ReadonlyMap<string, ModelsJsonProvider>;
	private readonly error: string | undefined;
	private readonly warnings: readonly string[];
	private readonly files: ReadonlyMap<string, string>;
	private readonly refusals: readonly string[];
	/** Overrides, untrusted project files not read, and where each file sits. */
	readonly diagnostics: ModelsDiagnostics;

	private constructor(
		providers: ReadonlyMap<string, ModelsJsonProvider>,
		error?: string,
		warnings: readonly string[] = [],
		files: ReadonlyMap<string, string> = new Map(),
		refusals: readonly string[] = [],
		diagnostics = new ModelsDiagnostics(process.cwd()),
	) {
		this.diagnostics = diagnostics;
		this.providers = providers;
		this.error = error;
		this.warnings = warnings;
		this.files = files;
		this.refusals = refusals;
	}

	/**
	 * Octocode's own models.json merged with the project's and Pi's, field by field (`scope-merge.ts`): the narrower
	 * definition of a provider wins each field it names, in the order discovery ranks the files: Octocode's project
	 * file, Pi's project file, Octocode's global file, Pi's global files. A project file may add models and tune
	 * defaults but not change `baseUrl`, `api`, `headers` or `apiKey` of a provider a global file defines, and
	 * Octocode's file outranks Pi's at each scope. A project file of a folder that is not trusted is not read;
	 * a warning says so.
	 */
	static async load(modelsJsonPath: string | undefined, project?: ModelsProject): Promise<ModelConfig> {
		if (!modelsJsonPath) return new ModelConfig(new Map());
		let paths = [modelsJsonPath];
		// Files read as Pi's (an official provider id in them is skipped with a warning, not refused).
		const fallbackFiles = new Set<string>();
		const projectFiles = new Set<string>();
		const notices: string[] = [];
		const diagnostics = new ModelsDiagnostics(project?.cwd ?? process.cwd());
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
					if (provenance.notLoaded === "untrusted") {
						notices.push(untrustedProjectModelsWarning(provenance.path, input.cwd));
						diagnostics.noteUntrusted(provenance.path, input.cwd);
					}
					continue;
				}
				ranked.push(provenance.path);
				if (provenance.product === "pi") fallbackFiles.add(provenance.path);
				if (provenance.scope === "project") projectFiles.add(provenance.path);
			}
			// Octocode's global file is always read, even when it does not exist yet; it keeps its rank among the others.
			paths = ranked.some((file) => resolve(file) === own) ? ranked : [...ranked, modelsJsonPath];
		}
		const definitions = new Map<string, ScopedDefinition<ModelsJsonProvider>[]>();
		const errors: string[] = [];
		const warnings: string[] = [...notices];
		const refusals: string[] = [];
		// Files load concurrently; their definitions are collected in precedence order, so errors and warnings keep file
		// order. Pi's files are never ours to fix: an official id there is a warning.
		const configs = await Promise.all(
			paths.map((file) => ModelConfig.loadFile(file, { fallback: fallbackFiles.has(file) })),
		);
		for (const [index, config] of configs.entries()) {
			const isProject = projectFiles.has(paths[index]);
			// An unreadable project file is skipped, not fatal: the global providers keep loading.
			if (config.error) {
				if (isProject) warnings.push(`Project models.json skipped: ${config.error}`);
				else errors.push(config.error);
			}
			warnings.push(...config.warnings);
			refusals.push(...config.refusals);
			for (const [id, provider] of config.providers) {
				const file = config.files.get(id) ?? paths[index];
				definitions.set(id, [...(definitions.get(id) ?? []), { file, provider, project: isProject }]);
			}
		}
		const providers = new Map<string, ModelsJsonProvider>();
		const files = new Map<string, string>();
		for (const [id, scoped] of definitions) {
			const merged = mergeProviderScopes(id, scoped);
			warnings.push(...merged.warnings);
			providers.set(id, merged.provider);
			files.set(id, scoped[0].file);
			// Every override is told, once per load; the host named is the one requests now go to.
			for (const loser of scoped.slice(1)) {
				warnings.push(
					diagnostics.noteShadow(
						id,
						{ file: scoped[0].file, baseUrl: merged.provider.baseUrl, project: scoped[0].project },
						{ file: loser.file, baseUrl: loser.provider.baseUrl, project: loser.project },
					),
				);
			}
		}
		return new ModelConfig(
			providers,
			errors.length ? errors.join("\n\n") : undefined,
			warnings,
			files,
			refusals,
			diagnostics,
		);
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

		const validateModelsConfig = modelsConfigValidator();
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
