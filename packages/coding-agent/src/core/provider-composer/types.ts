import {
	type AnyModel,
	type Api,
	type AssistantMessageEventStream,
	type ClassifierApi,
	type ImageApi,
	type Model,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type ProviderClassifier,
	type ProviderImages,
	type RefreshModelsContext,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@octocodeai/octocode-ai";

export interface FeatureOAuthConfig {
	name: string;
	/** Whether access through this auth method is backed by a provider subscription. */
	isSubscription?: boolean;
	login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
	refreshToken(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials>;
	getApiKey(credentials: OAuthCredentials): string;
}

interface ProviderModelConfigBase {
	id: string;
	name: string;
	api?: string;
	baseUrl?: string;
	input: ("text" | "image")[];
	inputLimits?: AnyModel["inputLimits"];
	cost: AnyModel["cost"];
	headers?: Record<string, string>;
}

interface ProviderChatModelConfig extends ProviderModelConfigBase {
	type?: "chat";
	api?: Api;
	reasoning: boolean;
	thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
	promptCache?: Model<Api>["promptCache"];
	contextWindow: number;
	maxTokens: number;
	samplingParams?: Model<Api>["samplingParams"];
	samplingParamsByThinkingLevel?: Model<Api>["samplingParamsByThinkingLevel"];
	compat?: Model<Api>["compat"];
}

interface ProviderImageModelConfig extends ProviderModelConfigBase {
	type: "image";
	api?: ImageApi;
	output: ("text" | "image")[];
}

interface ProviderClassifierModelConfig extends ProviderModelConfigBase {
	type: "classifier";
	api?: ClassifierApi;
	contextWindow: number;
}

export type ProviderModelConfig = ProviderChatModelConfig | ProviderImageModelConfig | ProviderClassifierModelConfig;

/** Input type for the feature registerProvider API. */
export interface ProviderConfigInput {
	name?: string;
	baseUrl?: string;
	apiKey?: string;
	api?: Api;
	streamSimple?: (
		model: Model<Api>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	) => AssistantMessageEventStream;
	images?: Partial<Record<ImageApi, ProviderImages>>;
	classifiers?: Partial<Record<ClassifierApi, ProviderClassifier>>;
	headers?: Record<string, string>;
	authHeader?: boolean;
	oauth?: FeatureOAuthConfig;
	models?: ProviderModelConfig[];
	refreshModels?(context: RefreshModelsContext): Promise<ProviderModelConfig[]>;
}

export type AuthStatus = {
	configured: boolean;
	source?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
	label?: string;
};

const CREDENTIAL_SOURCE_LABELS = {
	stored: "saved credential",
	runtime: "session credential",
	environment: "environment",
	fallback: "extension configuration",
	models_json_key: "models.json",
	models_json_command: "secret command in models.json",
} as const satisfies Record<NonNullable<AuthStatus["source"]>, string>;

/** Where a credential comes from, for a row: its own label (a variable name) or the source's words, never a value. */
export function credentialSourceLabel(status: AuthStatus): string {
	return status.label ?? CREDENTIAL_SOURCE_LABELS[status.source ?? "environment"];
}
