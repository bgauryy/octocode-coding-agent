import type {
	AssistantMessage,
	AssistantMessageEventStream,
	DeferredCancelOptions,
	DeferredFetchOptions,
	DeferredHandle,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	TranscriptContext,
} from "../../types.ts";
import { createAssistantMessageEventStream } from "../../utils/event-stream.ts";
import {
	cloneMessage,
	createDeferredMessage,
	createErrorMessage,
	DEFAULT_API,
	DEFAULT_BASE_URL,
	DEFAULT_MAX_TOKEN_SIZE,
	DEFAULT_MIN_TOKEN_SIZE,
	DEFAULT_MODEL_ID,
	DEFAULT_MODEL_NAME,
	DEFAULT_PROVIDER,
	randomId,
} from "./messages.ts";
import { streamWithDeltas } from "./stream.ts";
import type { FauxProviderState, FauxResponseStep, RegisterFauxProviderOptions } from "./types.ts";
import { withUsageEstimate } from "./usage.ts";

export function createFauxCore(options: RegisterFauxProviderOptions) {
	const api = options.api ?? randomId(DEFAULT_API);
	const provider = options.provider ?? DEFAULT_PROVIDER;
	const minTokenSize = Math.max(
		1,
		Math.min(options.tokenSize?.min ?? DEFAULT_MIN_TOKEN_SIZE, options.tokenSize?.max ?? DEFAULT_MAX_TOKEN_SIZE),
	);
	const maxTokenSize = Math.max(minTokenSize, options.tokenSize?.max ?? DEFAULT_MAX_TOKEN_SIZE);
	let pendingResponses: FauxResponseStep[] = [];
	const tokensPerSecond = options.tokensPerSecond;
	const state: FauxProviderState = { callCount: 0, deferredFetchCount: 0, cancelledDeferred: [] };
	const promptCache = new Map<string, readonly string[]>();
	const deferredResponses = new Map<
		string,
		{
			handle: DeferredHandle;
			step: FauxResponseStep;
			context: TranscriptContext;
			options: SimpleStreamOptions | undefined;
			model: Model<string>;
			pendingFetches: number;
			cancelled: boolean;
			final?: AssistantMessage;
		}
	>();

	const modelDefinitions = options.models?.length
		? options.models
		: [
				{
					id: DEFAULT_MODEL_ID,
					name: DEFAULT_MODEL_NAME,
					reasoning: false,
					input: ["text", "image"] as ("text" | "image")[],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 16384,
				},
			];
	const models = modelDefinitions.map((definition) => ({
		id: definition.id,
		name: definition.name ?? definition.id,
		api,
		provider,
		baseUrl: DEFAULT_BASE_URL,
		reasoning: definition.reasoning ?? false,
		input: definition.input ?? ["text", "image"],
		inputLimits: definition.inputLimits,
		cost: definition.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: definition.contextWindow ?? 128000,
		maxTokens: definition.maxTokens ?? 16384,
	})) as [Model<string>, ...Model<string>[]];

	const resolveResponse = async (
		step: FauxResponseStep,
		context: TranscriptContext,
		streamOptions: SimpleStreamOptions | undefined,
		requestModel: Model<string>,
	): Promise<AssistantMessage> => {
		const resolved = typeof step === "function" ? await step(context, streamOptions, state, requestModel) : step;
		return withUsageEstimate(
			cloneMessage(resolved, api, provider, requestModel.id),
			context,
			streamOptions,
			promptCache,
		);
	};

	const stream: StreamFunction<string, SimpleStreamOptions> = (requestModel, context, streamOptions) => {
		const outer = createAssistantMessageEventStream();
		const step = pendingResponses.shift();
		state.callCount++;

		void Promise.resolve().then(async () => {
			try {
				await streamOptions?.onResponse?.({ status: 200, headers: {} }, requestModel);
				if (!step) {
					let message = createErrorMessage(new Error("No more faux responses queued"), api, provider, requestModel.id);
					message = withUsageEstimate(message, context, streamOptions, promptCache);
					outer.push({ type: "error", reason: "error", error: message });
					outer.end(message);
					return;
				}

				if (streamOptions?.deferred) {
					const handle: DeferredHandle = {
						provider: requestModel.provider,
						modelId: requestModel.id,
						api: requestModel.api,
						id: randomId("deferred"),
						...(options.deferred?.pollAfterMs !== undefined ? { pollAfterMs: options.deferred.pollAfterMs } : {}),
					};
					deferredResponses.set(handle.id, {
						handle,
						step,
						context,
						options: streamOptions,
						model: requestModel,
						pendingFetches: Math.max(0, Math.floor(options.deferred?.pendingFetches ?? 0)),
						cancelled: false,
					});
					await streamWithDeltas(
						outer,
						createDeferredMessage(requestModel, handle),
						minTokenSize,
						maxTokenSize,
						tokensPerSecond,
						streamOptions.signal,
					);
					return;
				}

				const message = await resolveResponse(step, context, streamOptions, requestModel);
				await streamWithDeltas(outer, message, minTokenSize, maxTokenSize, tokensPerSecond, streamOptions?.signal);
			} catch (error) {
				const message = createErrorMessage(error, api, provider, requestModel.id);
				outer.push({ type: "error", reason: "error", error: message });
				outer.end(message);
			}
		});

		return outer;
	};

	const streamSimple: StreamFunction<string, SimpleStreamOptions> = (streamModel, context, streamOptions) =>
		stream(streamModel, context, streamOptions);

	const fetchDeferred = (
		requestModel: Model<string>,
		handle: DeferredHandle,
		fetchOptions?: DeferredFetchOptions,
	): AssistantMessageEventStream => {
		const outer = createAssistantMessageEventStream();
		state.deferredFetchCount++;

		void Promise.resolve().then(async () => {
			try {
				await fetchOptions?.onResponse?.({ status: 200, headers: {} }, requestModel);
				const entry = deferredResponses.get(handle.id);
				if (
					!entry ||
					entry.handle.provider !== handle.provider ||
					entry.handle.modelId !== handle.modelId ||
					entry.handle.api !== handle.api
				) {
					throw new Error(`Unknown faux deferred response: ${handle.id}`);
				}
				if (entry.cancelled) throw new Error(`Faux deferred response was cancelled: ${handle.id}`);

				if (entry.pendingFetches > 0) {
					entry.pendingFetches--;
					await streamWithDeltas(
						outer,
						createDeferredMessage(requestModel, entry.handle),
						minTokenSize,
						maxTokenSize,
						tokensPerSecond,
						fetchOptions?.signal,
					);
					return;
				}

				if (!entry.final) {
					const {
						deferred: _deferred,
						signal: _submissionSignal,
						onResponse: _submissionOnResponse,
						...submissionOptions
					} = entry.options ?? {};
					try {
						entry.final = await resolveResponse(entry.step, entry.context, submissionOptions, entry.model);
					} catch (error) {
						entry.final = createErrorMessage(error, api, provider, entry.model.id);
					}
				}
				await streamWithDeltas(outer, entry.final, minTokenSize, maxTokenSize, tokensPerSecond, fetchOptions?.signal);
			} catch (error) {
				const message = createErrorMessage(error, api, provider, requestModel.id);
				outer.push({ type: "error", reason: "error", error: message });
				outer.end(message);
			}
		});

		return outer;
	};

	const cancelDeferred = async (
		requestModel: Model<string>,
		handle: DeferredHandle,
		cancelOptions?: DeferredCancelOptions,
	): Promise<void> => {
		state.cancelledDeferred.push(structuredClone(handle));
		const entry = deferredResponses.get(handle.id);
		if (entry) entry.cancelled = true;
		await cancelOptions?.onResponse?.({ status: 200, headers: {} }, requestModel);
	};

	function getModel(): Model<string>;
	function getModel(requestedModelId: string): Model<string> | undefined;
	function getModel(requestedModelId?: string): Model<string> | undefined {
		if (!requestedModelId) {
			return models[0];
		}
		return models.find((candidate) => candidate.id === requestedModelId);
	}

	return {
		api,
		provider,
		models,
		stream,
		streamSimple,
		fetchDeferred,
		cancelDeferred,
		getModel,
		state,
		setResponses(responses: FauxResponseStep[]) {
			pendingResponses = [...responses];
		},
		appendResponses(responses: FauxResponseStep[]) {
			pendingResponses.push(...responses);
		},
		getPendingResponseCount() {
			return pendingResponses.length;
		},
	};
}
