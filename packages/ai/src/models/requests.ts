import { assertImageRequestContext } from "../utils/image-input.ts";
import { lazyStream } from "../api/lazy.ts";
import { type AuthResolutionOverrides, ModelsError } from "../auth/resolve.ts";
import type { AuthResult } from "../auth/types.ts";
import { observeModelRequest } from "../telemetry.ts";
import type {
	AnyModel,
	Api,
	ApiStreamOptions,
	AssistantImages,
	AssistantMessageEventStream,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierResult,
	Context,
	DeferredHandle,
	ImageApi,
	ImageModel,
	ImagesContext,
	Model,
	ProviderRequestOptions,
} from "../types.ts";
import {
	assertChatModel,
	assertClassifierInputSupported,
	assertClassifierModel,
	assertImageModel,
	classifierErrorResult,
	imageErrorResult,
} from "../utils/model-operations.ts";
import { mergeHeaders } from "../utils/headers.ts";
import { normalizeContext } from "../utils/transcript.ts";
import type {
	ModelsApiStreamOptions,
	ModelsClassifierOptions,
	ModelsDeferredCancelOptions,
	ModelsDeferredFetchOptions,
	ModelsImagesOptions,
	ModelsRequestTransforms,
	ModelsSimpleStreamOptions,
	Provider,
} from "./contracts.ts";

/** What request dispatch reads from the `Models` collection that owns it. */
interface ModelRequestHost {
	getProvider(id: string): Provider | undefined;
	getAuth(model: AnyModel, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
}

/** Resolves auth for each request and delegates it to the provider that owns the model. */
export class ModelRequests {
	private readonly host: ModelRequestHost;

	constructor(host: ModelRequestHost) {
		this.host = host;
	}

	private requireProvider(model: AnyModel): Provider {
		const provider = this.host.getProvider(model.provider);
		if (!provider) {
			throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
		}
		return provider;
	}

	private requireChatProvider(model: Model<Api>): Provider {
		assertChatModel(model);
		return this.requireProvider(model);
	}

	private async applyAuth<
		TModel extends AnyModel,
		TOptions extends ProviderRequestOptions<TModel> & ModelsRequestTransforms,
	>(
		model: TModel,
		options: TOptions | undefined,
	): Promise<{
		requestModel: TModel;
		requestOptions: Omit<TOptions, "transformHeaders"> & ProviderRequestOptions<TModel>;
	}> {
		this.requireProvider(model);
		const resolution = await this.host.getAuth(model, {
			apiKey: options?.apiKey,
			env: options?.env,
			signal: options?.signal,
		});
		if (!resolution) {
			throw new ModelsError("auth", `Provider is not configured: ${model.provider}`);
		}
		const auth = resolution.auth;

		// Explicit request options win per-field; the Models-only transform runs last.
		const apiKey = options?.apiKey ?? auth.apiKey;
		let headers = mergeHeaders(auth.headers, options?.headers);
		if (options?.transformHeaders) headers = await options.transformHeaders(headers ?? {});
		const env = resolution.env || options?.env ? { ...resolution.env, ...options?.env } : undefined;
		const requestModel: TModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
		const { transformHeaders: _transformHeaders, ...providerOptions } = options ?? {};
		const requestOptions = { ...providerOptions, apiKey, headers, env } as Omit<TOptions, "transformHeaders"> &
			ProviderRequestOptions<TModel>;

		return { requestModel, requestOptions };
	}

	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream {
		const transcript = normalizeContext(context);
		return lazyStream(
			model,
			async () => {
				const provider = this.requireChatProvider(model);
				assertImageRequestContext(model, transcript.messages);
				const { requestModel, requestOptions } = await this.applyAuth(model, options);
				return provider.stream(requestModel, transcript, requestOptions as ApiStreamOptions<TApi>);
			},
			observeModelRequest(model, options, false),
			options?.signal,
		);
	}

	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		const transcript = normalizeContext(context);
		return lazyStream(
			model,
			async () => {
				const provider = this.requireChatProvider(model);
				assertImageRequestContext(model, transcript.messages);
				const { requestModel, requestOptions } = await this.applyAuth(model, options);
				return provider.streamSimple(requestModel, transcript, requestOptions);
			},
			observeModelRequest(model, options, false),
			options?.signal,
		);
	}

	streamDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): AssistantMessageEventStream {
		return lazyStream(
			model,
			async () => {
				const provider = this.requireChatProvider(model);
				if (!provider.fetchDeferred) {
					throw new ModelsError("provider", `Provider ${model.provider} does not support deferred responses`);
				}
				const { requestModel, requestOptions } = await this.applyAuth(model, options);
				return provider.fetchDeferred(requestModel, handle, requestOptions);
			},
			observeModelRequest(model, options, true),
			options?.signal,
		);
	}

	async cancelDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredCancelOptions,
	): Promise<void> {
		const provider = this.requireChatProvider(model);
		if (!provider.cancelDeferred) {
			throw new ModelsError("provider", `Provider ${model.provider} does not support deferred responses`);
		}
		const { requestModel, requestOptions } = await this.applyAuth(model, options);
		await provider.cancelDeferred(requestModel, handle, requestOptions);
	}

	async generateImages(
		model: ImageModel<ImageApi>,
		context: ImagesContext,
		options?: ModelsImagesOptions,
	): Promise<AssistantImages> {
		try {
			assertImageModel(model);
			const provider = this.requireProvider(model);
			if (!provider.generateImages) {
				throw new ModelsError("provider", `Provider ${model.provider} does not support image generation`);
			}
			const { requestModel, requestOptions } = await this.applyAuth(model, options);
			return await provider.generateImages(requestModel, context, requestOptions);
		} catch (error) {
			return imageErrorResult(model, error, options?.signal?.aborted);
		}
	}

	async classify(
		model: ClassifierModel<ClassifierApi>,
		context: ClassifierContext,
		options?: ModelsClassifierOptions,
	): Promise<ClassifierResult> {
		try {
			assertClassifierModel(model);
			assertClassifierInputSupported(model, context);
			const provider = this.requireProvider(model);
			if (!provider.classify) {
				throw new ModelsError("provider", `Provider ${model.provider} does not support classification`);
			}
			const { requestModel, requestOptions } = await this.applyAuth(model, options);
			return await provider.classify(requestModel, context, requestOptions);
		} catch (error) {
			return classifierErrorResult(model, error, options?.signal?.aborted);
		}
	}
}
