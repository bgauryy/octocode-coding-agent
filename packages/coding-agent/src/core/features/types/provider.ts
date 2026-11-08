/** Provider and virtual model registration. */

import type {
	AnyModel,
	Api,
	AssistantMessageEventStream,
	ClassifierApi,
	ImageApi,
	Model,
	OAuthCredentials,
	OAuthLoginCallbacks,
	ProviderClassifier,
	ProviderImages,
	RefreshModelsContext,
	SimpleStreamOptions,
	TranscriptContext,
} from "@octocodeai/octocode-ai";
import type { ModelRoute, ModelRouteRequest, VirtualModelDefinition } from "../../virtual-models.ts";
import type { ExtensionContext } from "./context.ts";

// ============================================================================
// Provider Registration Types
// ============================================================================

/** Virtual model registered via api.registerVirtualModel(). */
export interface ExtensionVirtualModel<TState = unknown> extends Omit<VirtualModelDefinition<TState>, "route"> {
	/** Like `VirtualModelDefinition.route`, with an extension context. */
	route(request: ModelRouteRequest<TState>, ctx: ExtensionContext): ModelRoute<TState> | Promise<ModelRoute<TState>>;
}

/** Configuration for registering a provider via api.registerProvider(). */
export interface ProviderConfig {
	/** Display name for the provider in UI. */
	name?: string;
	/** Base URL for the API endpoint. Required when defining models. */
	baseUrl?: string;
	/** API key literal, env interpolation ($ENV_VAR or ${ENV_VAR}), or leading !command. Required when defining models (unless oauth provided). */
	apiKey?: string;
	/** API type. Required at provider or model level when defining models. */
	api?: Api;
	/**
	 * Optional streamSimple handler for custom APIs.
	 * The context is a normalized transcript: read the prompt and tools from its system messages
	 * (`getCurrentSystemPrompt(context.messages)`, `getCurrentTools(context.messages)`).
	 * Implementations must invoke `options.onPayload` before sending the provider request and use any
	 * returned replacement payload. They must invoke `options.onResponse` after receiving the response
	 * and before consuming its body, matching built-in providers. Implementations may invoke
	 * `options.onProviderStreamEvent(data, model)` with parsed stream events before normalization.
	 * Event data is adapter-owned and must be treated as read-only.
	 */
	streamSimple?: (
		model: Model<Api>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	) => AssistantMessageEventStream;
	/** Image-generation implementations keyed by image API. */
	images?: Partial<Record<ImageApi, ProviderImages>>;
	/** Classifier implementations keyed by classifier API. */
	classifiers?: Partial<Record<ClassifierApi, ProviderClassifier>>;
	/** Custom headers to include in requests. */
	headers?: Record<string, string>;
	/** If true, adds Authorization: Bearer header with the resolved API key. */
	authHeader?: boolean;
	/** Models to register. If provided, replaces all existing models for this provider. */
	models?: ProviderModelConfig[];
	/**
	 * Refresh this provider's model list. The returned list replaces extension-provided models.
	 * Use context.publish({ persist: entry }) when the catalog should persist across sessions.
	 */
	refreshModels?(context: RefreshModelsContext): Promise<ProviderModelConfig[]>;
	/** OAuth provider for /providers support. The `id` is set automatically from the provider name. */
	oauth?: {
		/** Display name for the provider in login UI. */
		name: string;
		/** Whether access through this auth method is backed by a provider subscription. */
		isSubscription?: boolean;
		/** @deprecated Retained for source compatibility; canonical auth flows ignore it. */
		usesCallbackServer?: boolean;
		/** Run the login flow, return credentials to persist. */
		login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
		/** Refresh expired credentials, return updated credentials to persist. */
		refreshToken(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials>;
		/** Convert credentials to API key string for the provider. */
		getApiKey(credentials: OAuthCredentials): string;
		/** Legacy synchronous credential-dependent model projection. */
		modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
	};
}

interface ProviderModelConfigBase {
	/** Model ID. */
	id: string;
	/** Display name. */
	name: string;
	/** API type override for this model. */
	api?: string;
	/** API endpoint URL override for this model. */
	baseUrl?: string;
	/** Supported input types. */
	input: ("text" | "image")[];
	/** Provider input limits and cache-safe image preprocessing metadata. */
	inputLimits?: AnyModel["inputLimits"];
	/** Per-million-token cost rates and optional request-wide input pricing tiers. */
	cost: AnyModel["cost"];
	/** Custom headers for this model. */
	headers?: Record<string, string>;
}

/** Chat model configuration. Omitted `type` is normalized to `"chat"`. */
interface ProviderChatModelConfig extends ProviderModelConfigBase {
	type?: "chat";
	api?: Api;
	/** Whether the model supports extended thinking. */
	reasoning: boolean;
	/** Maps Octocode thinking levels to provider/model-specific values; null marks a level unsupported. */
	thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
	/** Best-effort prompt cache lifetime in seconds per retention tier. Unset disables cache warming. */
	promptCache?: Model<Api>["promptCache"];
	/** Maximum context window size in tokens. */
	contextWindow: number;
	/** Maximum output tokens. */
	maxTokens: number;
	samplingParams?: Record<string, unknown>;
	/** OpenAI compatibility settings. */
	compat?: Model<Api>["compat"];
}

/** Image-generation model configuration. */
interface ProviderImageModelConfig extends ProviderModelConfigBase {
	type: "image";
	api?: ImageApi;
	output: ("text" | "image")[];
}

/** Structured classifier model configuration. */
interface ProviderClassifierModelConfig extends ProviderModelConfigBase {
	type: "classifier";
	api?: ClassifierApi;
	contextWindow: number;
}

/** Configuration for a model within a provider. */
type ProviderModelConfig = ProviderChatModelConfig | ProviderImageModelConfig | ProviderClassifierModelConfig;
