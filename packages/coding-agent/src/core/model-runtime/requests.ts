/**
 * Request preparation and the provider operations built on it: chat streams (including virtual-model routing),
 * deferred responses, image generation and classification.
 */

import {
	type AnyModel,
	type Api,
	type ApiStreamOptions,
	type AssistantImages,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type AuthResult,
	type ClassifierApi,
	type ClassifierContext,
	type ClassifierModel,
	type ClassifierResult,
	type Context,
	type DeferredHandle,
	type ImageApi,
	type ImageModel,
	type ImagesContext,
	isModelType,
	lazyStream,
	type Message,
	type Model,
	type ModelsApiStreamOptions,
	type ModelsClassifierOptions,
	type ModelsDeferredCancelOptions,
	type ModelsDeferredFetchOptions,
	ModelsError,
	type ModelsImagesOptions,
	type ModelsRequestTransforms,
	type ModelsSimpleStreamOptions,
	type ModelThinkingLevel,
	type LazyStreamObserver,
	type MutableModels,
	normalizeContext,
	type Provider,
	type ProviderRequestOptions,
	type RequestPriority,
	type StreamOptions,
} from "@octocodeai/octocode-ai";
import { withCacheEndpoint } from "@octocodeai/octocode-ai/utils/cache-capabilities";
import { mergeHeaders } from "@octocodeai/octocode-ai/utils/headers";
import { assertImageRequestContext } from "@octocodeai/octocode-ai/utils/image-input";
import {
	assertChatModel,
	assertClassifierInputSupported,
	assertClassifierModel,
	assertImageModel,
	classifierErrorResult,
	imageErrorResult,
} from "@octocodeai/octocode-ai/utils/model-operations";
import { formatAuthRefreshFailedMessage } from "../auth-guidance.ts";
import type { resolveConfiguredCache } from "../cache-configuration.ts";
import { resolveConfiguredModelHeaders } from "../provider-composer.ts";
import { isVirtualModel, type ModelRoute, type ModelRouteReason } from "../virtual-models.ts";
import { type CooldownRequestOptions, cooldownStep } from "./cooldown-request.ts";
import { instructionCacheBoundaryOption } from "./instruction-boundary.ts";
import type { ProviderLayers } from "./provider-layers.ts";
import { quotaStep } from "./quota-request.ts";
import { throughputStep } from "./throughput-request.ts";
import type { ModelRuntimeAuthOverrides } from "./types.ts";

type CacheOptions = ReturnType<typeof resolveConfiguredCache>["options"];

/**
 * Chat request options of the runtime. `resolveCache` resolves the cache options for the physical model that sends
 * the request, after any virtual routing, in place of the runtime's own resolution; options the caller set must win
 * inside it.
 */
export type RuntimeSimpleStreamOptions = ModelsSimpleStreamOptions & {
	resolveCache?: (model: Model<Api>) => CacheOptions;
	/** Names of the declared tools whose definition is `roleVariant`: the tool cache breakpoint sits before the first. */
	roleVariantTools?: ReadonlySet<string>;
	/** Hears when the request waits out its provider's rate-limit cool-down or throughput window. */
	onCooldownWait?: CooldownRequestOptions["onCooldownWait"];
	/** Admission priority; defaults to subagent in a child process and foreground elsewhere. */
	requestPriority?: RequestPriority;
};

/**
 * The cache options of one chat request, shared by every chat entry point so the same session settings send the same
 * markers on each: the resolved cache policy (or `resolveCache`'s, for the physical model), then the instruction and
 * tool cache boundaries of the transcript. Options the caller set win inside both.
 */
function chatCacheOptions(
	host: ModelRequestHost,
	model: Model<Api>,
	messages: readonly { role: string }[],
	options: StreamOptions | undefined,
	resolveCache: RuntimeSimpleStreamOptions["resolveCache"],
	roleVariantTools: ReadonlySet<string> | undefined,
): CacheOptions & ReturnType<typeof instructionCacheBoundaryOption> {
	return {
		...(resolveCache?.(model) ?? host.getCachePolicy(model, options).options),
		...instructionCacheBoundaryOption(messages, { ...options, roleVariantTools }),
	};
}

/** Resolve a model's auth and merge the headers configured for it in models.json or by its feature. */
export async function resolveModelAuth(
	models: MutableModels,
	layers: ProviderLayers,
	model: AnyModel,
	overrides: ModelRuntimeAuthOverrides,
): Promise<AuthResult | undefined> {
	const resolution = await models.getAuth(model, overrides);
	if (!resolution) return undefined;
	const configuredHeaders = resolveConfiguredModelHeaders(
		model,
		layers.config.getProvider(model.provider),
		layers.featureProviders.get(model.provider),
		{ ...resolution.env, ...overrides.env },
	);
	return {
		...resolution,
		auth: {
			...resolution.auth,
			headers: mergeHeaders(resolution.auth.headers, configuredHeaders),
		},
	};
}

/** What request preparation and routing need of the runtime. */
export interface ModelRequestHost {
	getProvider(providerId: string): Provider | undefined;
	getAuth(model: AnyModel, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
	getCachePolicy(model: Model<Api>, options?: StreamOptions): ReturnType<typeof resolveConfiguredCache>;
	resolveModel(
		model: Model<Api>,
		messages: readonly Message[],
		options: {
			reason: ModelRouteReason;
			thinkingLevel: ModelThinkingLevel;
			signal?: AbortSignal;
			failed?: AssistantMessage;
			state?: unknown;
		},
	): Promise<ModelRoute>;
	streamSimple(model: Model<Api>, context: Context, options?: RuntimeSimpleStreamOptions): AssistantMessageEventStream;
}

async function prepareModelRequest<
	TModel extends AnyModel,
	TOptions extends ProviderRequestOptions<TModel> & ModelsRequestTransforms,
>(
	host: ModelRequestHost,
	model: TModel,
	options: TOptions | undefined,
): Promise<{
	provider: Provider;
	model: TModel;
	options: Omit<TOptions, "transformHeaders"> & ProviderRequestOptions<TModel>;
}> {
	const provider = host.getProvider(model.provider);
	if (!provider) throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
	const resolution = await host
		.getAuth(model, { apiKey: options?.apiKey, env: options?.env, signal: options?.signal })
		.catch((error: unknown) => {
			// A failed renewal needs a new sign-in, not a retry: say which command does it.
			if (error instanceof ModelsError && error.code === "oauth")
				throw new ModelsError("oauth", formatAuthRefreshFailedMessage(model.provider, error.message), {
					cause: error,
				});
			throw error;
		});
	if (!resolution) throw new ModelsError("auth", `Provider is not configured: ${model.provider}`);

	const { transformHeaders, ...rawProviderOptions } = options ?? {};
	const providerOptions = rawProviderOptions as Omit<TOptions, "transformHeaders"> & ProviderRequestOptions<TModel>;
	let headers = mergeHeaders(resolution.auth.headers, providerOptions.headers);
	if (transformHeaders) headers = await transformHeaders(headers ?? {});
	const env = resolution.env || providerOptions.env ? { ...resolution.env, ...providerOptions.env } : undefined;
	const requestModel: TModel = resolution.auth.baseUrl
		? isModelType(model, "chat")
			? withCacheEndpoint(model, resolution.auth.baseUrl)
			: { ...model, baseUrl: resolution.auth.baseUrl }
		: model;
	return {
		provider,
		model: requestModel,
		options: {
			...providerOptions,
			apiKey: providerOptions.apiKey ?? resolution.auth.apiKey,
			headers,
			env,
		},
	};
}

function requestObserver(...observers: LazyStreamObserver[]): LazyStreamObserver {
	return {
		onEvent: (event) => {
			for (const observer of observers) observer.onEvent?.(event);
		},
		onResult: (result) => {
			for (const observer of observers) observer.onResult?.(result);
		},
	};
}

export function streamChatModel<TApi extends Api>(
	host: ModelRequestHost,
	model: Model<TApi>,
	context: Context,
	options?: ModelsApiStreamOptions<TApi>,
	hints?: Pick<RuntimeSimpleStreamOptions, "resolveCache" | "roleVariantTools" | "requestPriority">,
): AssistantMessageEventStream {
	const transcript = normalizeContext(context);
	const cooldown = cooldownStep(model, options);
	const throughput = throughputStep(model, transcript, { ...options, requestPriority: hints?.requestPriority });
	const onResponse = quotaStep(model, options);
	return lazyStream(
		model,
		async () => {
			assertChatModel(model);
			assertImageRequestContext(model, transcript.messages);
			const prepared = await prepareModelRequest(host, model, {
				...options,
				...cooldown.hooks,
				...chatCacheOptions(host, model, transcript.messages, options, hints?.resolveCache, hints?.roleVariantTools),
				onResponse,
			});
			const refused = await cooldown.ready(prepared.model);
			if (refused) return refused;
			const hooks = throughput.hooks(prepared.options, prepared.model, prepared.options.env ?? process.env);
			return prepared.provider.stream(prepared.model, transcript, {
				...prepared.options,
				...hooks,
			} as ApiStreamOptions<TApi>);
		},
		requestObserver(cooldown.observer, throughput.observer),
	);
}

export function streamSimpleChatModel(
	host: ModelRequestHost,
	model: Model<Api>,
	context: Context,
	options?: RuntimeSimpleStreamOptions,
): AssistantMessageEventStream {
	const transcript = normalizeContext(context);
	if (isVirtualModel(model)) {
		// Requests outside the agent loop are routed here. Callers sized them before routing, so
		// cap the output budget to the routed model.
		return lazyStream(model, async () => {
			const route = await host.resolveModel(model, transcript.messages, {
				reason: "direct",
				thinkingLevel: options?.reasoning ?? "off",
				signal: options?.signal,
			});
			const { maxTokens: limit } = route.model;
			const maxTokens = options?.maxTokens && limit > 0 ? Math.min(options.maxTokens, limit) : options?.maxTokens;
			const reasoning = route.thinkingLevel === "off" ? undefined : route.thinkingLevel;
			// Caller credentials were resolved for the virtual model's provider. Another provider
			// resolves its own, so they are not sent to the wrong vendor. The cache policy, and any
			// `resolveCache`, is resolved for the routed model.
			const { apiKey, headers, env, ...rest } = options ?? {};
			const auth = route.model.provider === model.provider ? { apiKey, headers, env } : {};
			return host.streamSimple(route.model, context, { ...rest, ...auth, maxTokens, reasoning });
		});
	}
	// A physical request waits out its provider's cool-down once its auth resolved, so a missing credential still fails at
	// once; a virtual one waits in the request it routes to.
	const {
		resolveCache,
		roleVariantTools,
		onCooldownWait: _onCooldownWait,
		requestPriority: _requestPriority,
		...requestOptions
	} = options ?? {};
	const cooldown = cooldownStep(model, options);
	const throughput = throughputStep(model, transcript, options);
	const onResponse = quotaStep(model, requestOptions);
	return lazyStream(
		model,
		async () => {
			assertChatModel(model);
			assertImageRequestContext(model, transcript.messages);
			const prepared = await prepareModelRequest(host, model, {
				...requestOptions,
				...cooldown.hooks,
				...chatCacheOptions(host, model, transcript.messages, requestOptions, resolveCache, roleVariantTools),
				onResponse,
			});
			const refused = await cooldown.ready(prepared.model);
			if (refused) return refused;
			const hooks = throughput.hooks(prepared.options, prepared.model, prepared.options.env ?? process.env);
			return prepared.provider.streamSimple(prepared.model, transcript, { ...prepared.options, ...hooks });
		},
		requestObserver(cooldown.observer, throughput.observer),
	);
}

export function streamDeferredResponse(
	host: ModelRequestHost,
	model: Model<Api>,
	handle: DeferredHandle,
	options?: ModelsDeferredFetchOptions,
): AssistantMessageEventStream {
	return lazyStream(model, async () => {
		assertChatModel(model);
		const prepared = await prepareModelRequest(host, model, options);
		if (!prepared.provider.fetchDeferred) {
			throw new ModelsError("provider", `Provider ${model.provider} does not support deferred responses`);
		}
		return prepared.provider.fetchDeferred(prepared.model, handle, prepared.options);
	});
}

export async function cancelDeferredResponse(
	host: ModelRequestHost,
	model: Model<Api>,
	handle: DeferredHandle,
	options?: ModelsDeferredCancelOptions,
): Promise<void> {
	assertChatModel(model);
	const prepared = await prepareModelRequest(host, model, options);
	if (!prepared.provider.cancelDeferred) {
		throw new ModelsError("provider", `Provider ${model.provider} does not support deferred responses`);
	}
	await prepared.provider.cancelDeferred(prepared.model, handle, prepared.options);
}

export async function generateModelImages(
	host: ModelRequestHost,
	model: ImageModel<ImageApi>,
	context: ImagesContext,
	options?: ModelsImagesOptions,
): Promise<AssistantImages> {
	try {
		assertImageModel(model);
		const prepared = await prepareModelRequest(host, model, options);
		if (!prepared.provider.generateImages) {
			throw new ModelsError("provider", `Provider ${model.provider} does not support image generation`);
		}
		return await prepared.provider.generateImages(prepared.model, context, prepared.options);
	} catch (error) {
		return imageErrorResult(model, error, options?.signal?.aborted);
	}
}

export async function classifyWithModel(
	host: ModelRequestHost,
	model: ClassifierModel<ClassifierApi>,
	context: ClassifierContext,
	options?: ModelsClassifierOptions,
): Promise<ClassifierResult> {
	try {
		assertClassifierModel(model);
		assertClassifierInputSupported(model, context);
		const prepared = await prepareModelRequest(host, model, options);
		if (!prepared.provider.classify) {
			throw new ModelsError("provider", `Provider ${model.provider} does not support classification`);
		}
		return await prepared.provider.classify(prepared.model, context, prepared.options);
	} catch (error) {
		return classifierErrorResult(model, error, options?.signal?.aborted);
	}
}
