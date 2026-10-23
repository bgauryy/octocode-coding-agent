import type {
	ClassifierAnswer,
	ClassifierContext,
	ClassifierFunction,
	ClassifierQuestion,
	ClassifierResult,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { answerFromProbabilities, labelProbabilities, renderQuestion } from "./llama-cpp-classify/prompt.ts";
import {
	LABEL,
	labelTokens,
	nextTokenLogprobs,
	type RequestContext,
	renderPrompt,
} from "./llama-cpp-classify/server.ts";

export {
	answerFromProbabilities,
	labelProbabilities,
	peakConfidence,
	renderQuestion,
} from "./llama-cpp-classify/prompt.ts";

/**
 * Classification with a chat model served by llama.cpp's `llama-server`.
 *
 * The model never generates an answer. Each question becomes one chat prompt
 * that lists the possible answers under single-token labels (letters for a
 * choice, `Yes`/`No` for a bool, digits for a score). The server evaluates the
 * prompt and returns the log-probabilities of its most likely next tokens; the
 * answer is the softmax over the label tokens among them.
 *
 * Server endpoints used: `/tokenize` (label token IDs), `/apply-template` (the
 * model's own chat template, thinking disabled) and `/completion` with
 * `n_predict: 1` and pre-sampling `n_probs`. Pre-sampling log-probabilities are
 * a softmax over the full vocabulary, unaffected by sampler settings, so the
 * softmax over the label log-probabilities equals the softmax over the label
 * logits. The server returns only the top `n_probs` tokens, so a label missing
 * from the list is retried with a deeper list and then reported as an error.
 *
 * In router mode every request carries the model ID in its `model` field;
 * single-model servers ignore it.
 */

/** First `n_probs` depth is `max(MIN_READOUT_DEPTH, READOUT_DEPTH_PER_LABEL * labels)`. */
const MIN_READOUT_DEPTH = 256;
const READOUT_DEPTH_PER_LABEL = 16;
/** Deeper readouts tried when a label is missing. Only the response size grows. */
const READOUT_ESCALATION = [4096, 32768];

/** llama-server reports an underflowed probability as the lowest float instead of -Infinity. */
const UNDERFLOW_LOGPROB = -1e30;

/** The server root: pi's llama.cpp models use the OpenAI-compatible `/v1` URL as their base URL. */
export function llamaServerRoot(baseUrl: string): string {
	return baseUrl.replace(/\/+$/u, "").replace(/\/v1$/u, "");
}

async function classifyQuestion(
	request: RequestContext,
	context: ClassifierContext,
	id: string,
	question: ClassifierQuestion,
	temperature: number,
): Promise<ClassifierAnswer> {
	const rendered = renderQuestion(context, id);
	const [tokens, prompt] = await Promise.all([
		labelTokens(request, rendered.labels),
		renderPrompt(request, rendered.content),
	]);
	const depths = [Math.max(MIN_READOUT_DEPTH, READOUT_DEPTH_PER_LABEL * tokens.length), ...READOUT_ESCALATION];
	let logprobs: Array<number | undefined> = [];
	for (const depth of depths) {
		logprobs = await nextTokenLogprobs(request, prompt, tokens, depth);
		if (logprobs.every((logprob) => logprob !== undefined)) break;
	}
	const missing = rendered.labels.filter((_label, index) => logprobs[index] === undefined);
	if (missing.length > 0) {
		throw new Error(
			`${LABEL} did not rank labels ${missing.join(", ")} for ${id} within the top ${depths.at(-1)} tokens`,
		);
	}
	const values = logprobs as number[];
	if (values.every((logprob) => logprob <= UNDERFLOW_LOGPROB)) {
		throw new Error(`${request.model.id} gave no probability to any answer label for ${id}`);
	}
	return answerFromProbabilities(question, rendered.keys, labelProbabilities(values, temperature));
}

/** Classifies with a chat model on llama-server by reading next-token probabilities of answer labels. */
export const classify: ClassifierFunction = async (model, context, options) => {
	const output: ClassifierResult = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		answers: {},
		stopReason: "stop",
		timestamp: Date.now(),
	};

	try {
		if (model.api !== "llama-cpp-classify") throw new Error(`Unsupported classifier API: ${model.api}`);
		if (context.images?.length) throw new Error(`${LABEL} classification does not support image input`);
		const temperature = options?.temperature ?? 1;
		if (!(temperature > 0) || !Number.isFinite(temperature)) {
			throw new Error(`Temperature must be a positive number, got ${temperature}`);
		}
		// Validate every question before the first request.
		for (const id of Object.keys(context.questions)) renderQuestion(context, id);
		const request: RequestContext = { model, root: llamaServerRoot(model.baseUrl), options };
		const answers: Array<[string, ClassifierAnswer]> = [];
		// One question at a time: each prompt starts with the same text up to its final
		// question, which the server's prompt cache then evaluates only once.
		for (const [id, question] of Object.entries(context.questions)) {
			answers.push([id, await classifyQuestion(request, context, id, question, temperature)]);
		}
		output.answers = Object.fromEntries(answers);
		return output;
	} catch (error) {
		output.answers = {};
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = formatProviderError(normalizeProviderError(error), `${LABEL} error`);
		return output;
	}
};
