import type { TelemetrySpan } from "@octocodeai/octocode-telemetry";
import type { CacheRetention, ThinkingLevel } from "./providers/model-schema.ts";
import type { Api, ClassifierApi, ImageApi } from "./types/ids.ts";
import type { DeferredHandle, TranscriptContext } from "./types/messages.ts";
import type { ClassifierModel, ImageModel, Model, SamplingParams } from "./types/model.ts";
import type { AssistantImages, ClassifierContext, ClassifierResult, ImagesContext } from "./types/results.ts";
import type { AssistantMessageEventStream } from "./utils/event-stream.ts";

export type {
	AnthropicAllowedFallbackModel,
	AnthropicMessagesCompat,
	BedrockCompat,
	ChatTemplateKwargValue,
	MistralConversationsCompat,
	OpenAICompletionsCompat,
	OpenAIResponsesCompat,
	OpenRouterRouting,
	SessionAffinityFormat,
	ThinkingTokenBudgetField,
	VercelGatewayRouting,
} from "./providers/compat-schema.ts";
export type {
	CacheRetention,
	ModelCost,
	ModelCostRates,
	ModelCostTier,
	ModelImageInputLimits,
	ModelImageResizeOptions,
	ModelInputLimits,
	ModelInputModality,
	ModelPromptCache,
	ModelThinkingLevel,
	ThinkingLevel,
	ThinkingLevelMap,
} from "./providers/model-schema.ts";
export type { AssistantMessageEventStream } from "./utils/event-stream.ts";
export type {
	Api,
	ClassifierApi,
	ImageApi,
	KnownApi,
	KnownClassifierApi,
	KnownImageApi,
	KnownProvider,
	ProviderId,
} from "./types/ids.ts";
export type { JsonObject, JsonRepresentation, JsonValue } from "./types/json.ts";
export type { ContentAnnotation, MediaContent, ResourceContent, UnsupportedContent } from "./types/content.ts";
export type {
	AssistantContent,
	AssistantMessage,
	AssistantMessageEvent,
	ConstrainedSamplingConfig,
	Context,
	DeferredHandle,
	GrammarFormat,
	GrammarVariants,
	ImageContent,
	Message,
	NestedToolCallRecord,
	NestedToolCalls,
	StopReason,
	SystemMessage,
	TextContent,
	TextSignatureV1,
	ThinkingBudgetReduction,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolReference,
	ToolResultMessage,
	TranscriptContext,
	Usage,
	UserMessage,
} from "./types/messages.ts";
export type {
	AnyModel,
	BaseModel,
	ClassifierModel,
	ImageModel,
	Model,
	ModelType,
	ModelTypeMap,
	SamplingParams,
	SamplingParamsByThinkingLevel,
} from "./types/model.ts";
export type {
	AssistantImages,
	ClassifierAnswer,
	ClassifierBoolAnswer,
	ClassifierBoolQuestion,
	ClassifierChoiceAnswer,
	ClassifierChoiceQuestion,
	ClassifierContext,
	ClassifierQuestion,
	ClassifierResult,
	ClassifierScoreAnswer,
	ClassifierScoreQuestion,
	ClassifierStopReason,
	ImagesContext,
	ImagesInputContent,
	ImagesOutputContent,
	ImagesStopReason,
} from "./types/results.ts";

export type ToolChoice = "auto" | "none";
/** Token budgets for each thinking level (token-based providers only) */
export interface ThinkingBudgets {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

// Base options all providers share
export type Transport = "sse" | "websocket" | "websocket-cached" | "auto";

/** Provider-scoped environment overrides. Values take precedence over process.env. */
export type ProviderEnv = Record<string, string>;
export type ProviderHeaders = Record<string, string | null>;
export type FetchFunction = typeof globalThis.fetch;

export interface ProviderResponse {
	status: number;
	headers: Record<string, string>;
}

/** Authentication, HTTP transport, and lifecycle callbacks shared by provider requests. */
export interface ProviderRequestOptions<TModel = Model<Api>> {
	signal?: AbortSignal;
	/** Explicit parent span for telemetry produced by this logical request. */
	telemetry?: TelemetrySpan;
	apiKey?: string;
	/**
	 * Optional fetch implementation for provider HTTP requests.
	 * Defaults to `globalThis.fetch`. Provider adapters that cannot inject a custom implementation may reject it.
	 * This does not affect WebSocket transports.
	 */
	fetch?: FetchFunction;
	/**
	 * Provider-scoped environment values. These take precedence over process.env for
	 * provider configuration such as regional settings, endpoint placeholders, and
	 * proxy variables.
	 */
	env?: ProviderEnv;
	/**
	 * Optional callback for inspecting or replacing provider payloads before sending.
	 * May be async. Return or resolve to undefined to keep the payload unchanged.
	 */
	onPayload?: (payload: unknown, model: TModel) => unknown;
	/**
	 * Optional callback invoked after an HTTP response is received.
	 */
	onResponse?: (response: ProviderResponse, model: TModel) => void | Promise<void>;
	/**
	 * Optional custom HTTP headers to include in API requests.
	 * Merged with provider defaults; caller values override default headers.
	 * On AWS Bedrock these are injected via a Smithy `build`-step middleware so
	 * they are covered by SigV4 signing; reserved headers (`x-amz-*`,
	 * `authorization`, `host`) are silently ignored to preserve SigV4 / bearer auth.
	 * A null value suppresses a provider/API default header with the same name.
	 */
	headers?: ProviderHeaders;
	/**
	 * HTTP request timeout in milliseconds for providers/SDKs that support it.
	 * For example, OpenAI and Anthropic SDK clients default to 10 minutes.
	 */
	timeoutMs?: number;
	/**
	 * Maximum retry attempts for providers/SDKs that support client-side retries.
	 * For example, OpenAI and Anthropic SDK clients default to 2.
	 */
	maxRetries?: number;
	/**
	 * Maximum delay in milliseconds to wait for a retry when the server requests a long wait.
	 * If the server's requested delay exceeds this value, the request fails immediately
	 * with an error containing the requested delay, allowing higher-level retry logic
	 * to handle it with user visibility.
	 * Default: 60000 (60 seconds). Set to 0 to disable the cap.
	 */
	maxRetryDelayMs?: number;
}

export interface StreamOptions extends ProviderRequestOptions {
	/**
	 * Optional callback invoked after an HTTP response is received and before
	 * its body stream is consumed.
	 */
	onResponse?: (response: ProviderResponse, model: Model<Api>) => void | Promise<void>;
	/**
	 * Optional observer for each parsed provider stream event before Octocode normalization.
	 * Event data is adapter-owned and must be treated as read-only.
	 * Adapter support is explicit; unsupported adapters do not invoke it.
	 */
	onProviderStreamEvent?: (data: unknown, model: Model<Api>) => void | Promise<void>;
	temperature?: number;
	/**
	 * Arbitrary sampling parameters merged into the request body as-is, after the named request
	 * fields, so keys here override them. Lets custom OpenAI-compatible servers (llama.cpp, vLLM,
	 * SGLang, ...) receive parameters Octocode does not model, e.g. `top_p`, `top_k`, `min_p`,
	 * `repetition_penalty`. Merged over `Model.samplingParams` per key. Only applied by
	 * OpenAI-compatible adapters (completions, responses, Azure responses); other APIs ignore it.
	 */
	samplingParams?: SamplingParams;
	maxTokens?: number;
	/**
	 * Preferred transport for providers that support multiple transports.
	 * Providers that do not support this option ignore it.
	 */
	transport?: Transport;
	/**
	 * Prompt cache retention preference. Providers map this to their supported values.
	 * Default: "short".
	 */
	cacheRetention?: CacheRetention;
	/** Separate retention for leading instructions and tools on APIs supporting explicit cache boundaries. */
	instructionCacheRetention?: CacheRetention;
	/**
	 * Name of the first section of the leading system message that belongs to a second instruction cache block.
	 * Adapters with a free breakpoint split the leading system prompt before this section and mark both blocks with the
	 * instruction retention. Absent, unknown section, forced (opaque) prompt, or no free slot: one block, as before.
	 */
	instructionCacheBoundary?: string;
	/**
	 * Optional session identifier for providers that support session-based caching.
	 * Providers can use this to enable prompt caching, request routing, or other
	 * session-aware features. Ignored by providers that don't support it.
	 */
	sessionId?: string;
	/**
	 * WebSocket connect timeout in milliseconds for providers that support
	 * WebSocket transports. This covers the connection/open handshake only;
	 * stream idleness after connection uses timeoutMs.
	 */
	websocketConnectTimeoutMs?: number;
	/**
	 * Optional metadata to include in API requests.
	 * Providers extract the fields they understand and ignore the rest.
	 * For example, Anthropic uses `user_id` for abuse tracking and rate limiting.
	 */
	metadata?: Record<string, unknown>;
}

export type ProviderStreamOptions = StreamOptions & Record<string, unknown>;

export interface DeferredFetchOptions extends ProviderRequestOptions {
	/**
	 * Maximum provider long-poll duration in milliseconds.
	 * Defaults to 0, which performs one status check.
	 */
	wait?: number;
}

/** Request options for best-effort deferred-response cancellation. */
export type DeferredCancelOptions = ProviderRequestOptions;

/**
 * The uniform stream contract of an API implementation module: every module
 * under `src/api/` exports `stream` and `streamSimple`; capable modules may also
 * export deferred-response methods. Lazy wrappers (`lazyApi()`) and provider
 * factories pass these around as values. This is the untyped dispatch shape;
 * per-API option typing lives on the implementation modules themselves and on
 * `Provider.stream()` via `ApiStreamOptions`.
 */
export interface ProviderStreams {
	stream(model: Model<Api>, context: TranscriptContext, options?: StreamOptions): AssistantMessageEventStream;
	streamSimple(
		model: Model<Api>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream;
	fetchDeferred?(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: DeferredFetchOptions,
	): AssistantMessageEventStream;
	cancelDeferred?(model: Model<Api>, handle: DeferredHandle, options?: DeferredCancelOptions): Promise<void>;
}

/**
 * The uniform contract of an image-generation API implementation module:
 * every image API module under `src/api/` exports exactly `generateImages`,
 * so the module itself satisfies this interface. Lazy wrappers and
 * `createProvider({ images })` pass these around as values.
 */
export interface ProviderImages {
	generateImages(
		model: ImageModel<ImageApi>,
		context: ImagesContext,
		options?: ImagesOptions,
	): Promise<AssistantImages>;
}

/** The uniform contract implemented by classifier API modules. */
export interface ProviderClassifier {
	classify(
		model: ClassifierModel<ClassifierApi>,
		context: ClassifierContext,
		options?: ClassifierOptions,
	): Promise<ClassifierResult>;
}

export interface ClassifierOptions extends ProviderRequestOptions<ClassifierModel<ClassifierApi>> {
	/**
	 * Divides the answer logits by this value before they are normalized into probabilities.
	 * Values above 1 soften the distribution; values below 1 sharpen it. Must be positive.
	 * APIs that cannot apply it ignore it.
	 */
	temperature?: number;
}

export interface ImagesOptions extends ProviderRequestOptions<ImageModel<ImageApi>> {
	/**
	 * Optional metadata to include in API requests.
	 * Providers extract the fields they understand and ignore the rest.
	 */
	metadata?: Record<string, unknown>;
}

export type ProviderImagesOptions = ImagesOptions & Record<string, unknown>;

// Unified options with reasoning passed to streamSimple() and completeSimple()
export interface SimpleStreamOptions extends StreamOptions {
	/** Provider-neutral tool selection for simple requests. When omitted, adapters use provider-specific behavior. */
	toolChoice?: ToolChoice;
	reasoning?: ThinkingLevel;
	/** Ask a capable provider to return a durable handle and continue the request asynchronously. */
	deferred?: boolean | { window?: "15m" | "1h" | "24h" };
	/** Custom token budgets for thinking levels (token-based providers only) */
	thinkingBudgets?: ThinkingBudgets;
}

// Generic StreamFunction with typed options.
//
// Contract:
// - Receives a normalized transcript: the system prompt and tools live in the
//   leading system message, never on the context itself.
// - Must return an AssistantMessageEventStream.
// - Direct streamSimple() calls may throw synchronously when request auth is
//   missing. Once a stream is returned, request/model/runtime failures should
//   be encoded in that stream.
// - Error termination must produce an AssistantMessage with stopReason
//   "error" or "aborted" and errorMessage, emitted via the stream protocol.
export type StreamFunction<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> = (
	model: Model<TApi>,
	context: TranscriptContext,
	options?: TOptions,
) => AssistantMessageEventStream;

export type ImagesFunction<TOptions extends ImagesOptions = ImagesOptions> = (
	model: ImageModel<ImageApi>,
	context: ImagesContext,
	options?: TOptions,
) => Promise<AssistantImages>;

export type ClassifierFunction<TOptions extends ClassifierOptions = ClassifierOptions> = (
	model: ClassifierModel<ClassifierApi>,
	context: ClassifierContext,
	options?: TOptions,
) => Promise<ClassifierResult>;
