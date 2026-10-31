import type { ClassifierApi, ClassifierModel, ClassifierOptions } from "../../types.ts";
import { headersToRecord, providerHeadersToRecord } from "../../utils/headers.ts";
import { retryProviderRequest } from "../../utils/provider-retry.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";

export const LABEL = "llama.cpp";

interface HttpError extends Error {
	status: number | undefined;
	headers: Headers | undefined;
	body: string;
}

function httpError(response: Response, body: string): HttpError {
	const error = new Error(`${LABEL} returned ${response.status}`) as HttpError;
	error.status = response.status;
	error.headers = response.headers;
	error.body = body;
	return error;
}

function timeoutError(timeoutMs: number): HttpError {
	const error = new Error(`Request timed out after ${timeoutMs}ms`) as HttpError;
	error.name = "TimeoutError";
	error.status = undefined;
	error.headers = undefined;
	error.body = "";
	return error;
}


export interface RequestContext {
	model: ClassifierModel<ClassifierApi>;
	root: string;
	options: ClassifierOptions | undefined;
}

async function post(request: RequestContext, path: string, body: unknown, observe: boolean): Promise<unknown> {
	const { model, root, options } = request;
	let payload = body;
	if (observe) {
		const transformed = await options?.onPayload?.(payload, model);
		if (transformed !== undefined) payload = transformed;
	}
	const requestFetch = options?.fetch ?? globalThis.fetch;
	const headers =
		providerHeadersToRecord(
			{
				"content-type": "application/json",
				...(options?.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
			},
			model.headers,
			options?.headers,
		) ?? {};
	const { response, json } = await retryProviderRequest(
		async () => {
			const timeoutSignal = options?.timeoutMs !== undefined ? AbortSignal.timeout(options.timeoutMs) : undefined;
			const signal =
				options?.signal && timeoutSignal
					? AbortSignal.any([options.signal, timeoutSignal])
					: (options?.signal ?? timeoutSignal);
			try {
				const next = await requestFetch(`${root}${path}`, {
					method: "POST",
					headers,
					body: JSON.stringify(payload),
					signal,
				});
				if (!next.ok) throw httpError(next, await next.text());
				return { response: next, json: (await next.json()) as unknown };
			} catch (error) {
				if (timeoutSignal?.aborted && !options?.signal?.aborted) throw timeoutError(options!.timeoutMs!);
				throw error;
			}
		},
		{ maxRetries: options?.maxRetries ?? 2, maxRetryDelayMs: options?.maxRetryDelayMs, signal: options?.signal },
	);
	if (observe) {
		await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
	}
	return json;
}

function tokenIds(body: unknown): number[] {
	if (!isRecord(body) || !Array.isArray(body.tokens)) throw new Error(`${LABEL} returned an unexpected tokenization`);
	return body.tokens.map((token) => {
		const id = isRecord(token) ? token.id : token;
		if (typeof id !== "number") throw new Error(`${LABEL} returned an unexpected tokenization`);
		return id;
	});
}

async function tokenize(request: RequestContext, content: string): Promise<number[]> {
	return tokenIds(
		await post(
			request,
			"/tokenize",
			{ model: request.model.id, content, add_special: false, parse_special: false },
			false,
		),
	);
}

/**
 * Label token IDs per server, model and label. A label is `undefined` when the
 * model's vocabulary splits it into several tokens. Only completed lookups are
 * cached: in-flight requests belong to their caller's cancellation signal.
 */
const labelTokenCache = new Map<string, number | undefined>();

/**
 * The token the model emits for `label` at the start of its reply. The reply
 * follows a newline in the rendered template, so the label is tokenized after
 * one: tokenizers that add a leading-space marker at the start of a text would
 * otherwise return a different token than the model emits there.
 */
async function resolveLabelToken(request: RequestContext, label: string): Promise<number | undefined> {
	const [newline, withLabel] = await Promise.all([tokenize(request, "\n"), tokenize(request, `\n${label}`)]);
	if (withLabel.length === newline.length + 1 && newline.every((id, index) => withLabel[index] === id)) {
		return withLabel[newline.length];
	}
	const alone = await tokenize(request, label);
	return alone.length === 1 ? alone[0] : undefined;
}

export async function labelTokens(request: RequestContext, labels: readonly string[]): Promise<number[]> {
	const ids = await Promise.all(
		labels.map(async (label) => {
			const key = `${request.root}\u0000${request.model.id}\u0000${label}`;
			if (labelTokenCache.has(key)) return labelTokenCache.get(key);
			const token = await resolveLabelToken(request, label);
			labelTokenCache.set(key, token);
			return token;
		}),
	);
	const tokens: number[] = [];
	for (const [index, id] of ids.entries()) {
		if (id === undefined) throw new Error(`Label "${labels[index]}" is not a single token for ${request.model.id}`);
		if (tokens.includes(id)) throw new Error(`Labels share a token for ${request.model.id}: ${labels.join(", ")}`);
		tokens.push(id);
	}
	return tokens;
}

export async function renderPrompt(request: RequestContext, content: string): Promise<string> {
	const body = await post(
		request,
		"/apply-template",
		{
			model: request.model.id,
			messages: [
				{ role: "system", content: SYSTEM_PROMPT },
				{ role: "user", content },
			],
			chat_template_kwargs: { enable_thinking: false },
		},
		false,
	);
	if (!isRecord(body) || typeof body.prompt !== "string") throw new Error(`${LABEL} did not return a prompt`);
	// Some templates always open a reasoning block for the reply. Closing it at once
	// leaves an empty block, as templates with thinking disabled produce, so the next
	// token is the answer.
	return body.prompt.endsWith("<think>") ? `${body.prompt}</think>` : body.prompt;
}

/** Log-probabilities of `tokens` at the next position, or `undefined` for tokens outside the top `depth`. */
export async function nextTokenLogprobs(
	request: RequestContext,
	prompt: string,
	tokens: readonly number[],
	depth: number,
): Promise<Array<number | undefined>> {
	const body = await post(
		request,
		"/completion",
		{
			model: request.model.id,
			prompt,
			n_predict: 1,
			n_probs: depth,
			post_sampling_probs: false,
			cache_prompt: true,
			temperature: 0,
		},
		true,
	);
	const first =
		isRecord(body) && Array.isArray(body.completion_probabilities) ? body.completion_probabilities[0] : undefined;
	if (!isRecord(first) || !Array.isArray(first.top_logprobs)) {
		throw new Error(`${LABEL} did not return token probabilities`);
	}
	const byToken = new Map<number, number>();
	for (const entry of first.top_logprobs) {
		if (isRecord(entry) && typeof entry.id === "number" && typeof entry.logprob === "number") {
			byToken.set(entry.id, entry.logprob);
		}
	}
	return tokens.map((token) => byToken.get(token));
}
