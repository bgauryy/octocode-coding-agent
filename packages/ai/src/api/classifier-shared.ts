import { createStatusCodeErrorResponseHandler, postToApi } from "@ai-sdk/provider-utils";
import { calculateCost } from "../models/model-helpers.ts";
import type { ClassifierApi, ClassifierModel, ClassifierOptions, ProviderHeaders, Usage } from "../types.ts";
import { createUsage } from "../utils/assistant-message.ts";
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { raceWithAbortSignal } from "../utils/abort.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";

function timeoutError(timeoutMs: number): Error {
	return Object.assign(new Error(`Request timed out after ${timeoutMs}ms`), {
		name: "TimeoutError",
		status: undefined,
		headers: undefined,
	});
}

export function requiredNumber(label: string, value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${label} returned an invalid ${field}`);
	}
	return value;
}

function requestHeaders(
	model: ClassifierModel<ClassifierApi>,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
): Record<string, string> {
	return (
		providerHeadersToRecord(
			{ authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
			model.headers,
			optionsHeaders,
		) ?? {}
	);
}

/**
 * Posts one JSON classifier request with bearer auth, `onPayload`/`onResponse` hooks, a fresh
 * timeout per attempt, and provider retries. Returns the parsed response body; throws on failure.
 * `noRetryStatuses` lists HTTP statuses that fail at once although they are normally retried.
 */
export async function postClassifierRequest(
	label: string,
	url: URL,
	model: ClassifierModel<ClassifierApi>,
	body: unknown,
	options: ClassifierOptions | undefined,
	noRetryStatuses?: readonly number[],
): Promise<unknown> {
	if (!options?.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
	const apiKey = options.apiKey;
	let payload = body;
	const transformed = await options.onPayload?.(payload, model);
	if (transformed !== undefined) payload = transformed;
	const requestFetch = options.fetch ?? globalThis.fetch;
	const headers = requestHeaders(model, apiKey, options.headers);
	const failedResponse = createStatusCodeErrorResponseHandler();
	const { response, json } = await retryProviderRequest(
		async () => {
			const timeoutSignal = options.timeoutMs !== undefined ? AbortSignal.timeout(options.timeoutMs) : undefined;
			const signal =
				options.signal && timeoutSignal
					? AbortSignal.any([options.signal, timeoutSignal])
					: (options.signal ?? timeoutSignal);
			try {
				signal?.throwIfAborted();
				const request = postToApi({
					url: url.href,
					headers,
					body: { content: JSON.stringify(payload), values: payload },
					abortSignal: signal,
					fetch: async (input, init) => {
						const received = await requestFetch(input, { ...init, headers });
						if (signal?.aborted) {
							void received.body?.cancel().catch(() => {});
							signal.throwIfAborted();
						}
						return signal && received.body
							? new Response(received.body.pipeThrough(new TransformStream(), { signal }), received)
							: received;
					},
					failedResponseHandler: async (args) => {
						const result = await failedResponse(args);
						result.value.message = `${label} returned ${args.response.status}`;
						return result;
					},
					successfulResponseHandler: async ({ response }) => ({
						// Answer dictionaries may legitimately contain __proto__ as a question name.
						// Native parsers preserve own keys and validate the provider-specific answer shapes.
						value: { response, json: (await response.json()) as unknown },
					}),
				});
				return (await raceWithAbortSignal(request, signal)).value;
			} catch (error) {
				if (timeoutSignal?.aborted && !options.signal?.aborted) throw timeoutError(options.timeoutMs!);
				throw error;
			}
		},
		{
			maxRetries: options.maxRetries ?? 2,
			maxRetryDelayMs: options.maxRetryDelayMs,
			signal: options.signal,
			noRetryStatuses,
		},
	);
	await options.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
	return json;
}

function tokenCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Usage from a `{ input_tokens, output_tokens }` object, priced from the model catalog like chat
 * usage. A missing or malformed usage object leaves the result without usage instead of failing it.
 */
export function parseClassifierUsage(value: unknown, model: ClassifierModel<ClassifierApi>): Usage | undefined {
	if (!isRecord(value) || (value.input_tokens === undefined && value.output_tokens === undefined)) return undefined;
	const input = tokenCount(value.input_tokens);
	const output = tokenCount(value.output_tokens);
	const usage = createUsage({ input, output });
	calculateCost(model, usage);
	return usage;
}
