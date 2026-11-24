import type { CallOptions, OperationClientConfig } from "./config.ts";
import { OperationError } from "./errors.ts";
import { asArray, asNumber, asRecord, optNumber, perform, requireNonEmpty } from "./http.ts";

export const MAX_EMBEDDING_INPUTS = 2048;

export interface EmbeddingsRequest {
	model: string;
	/** One string or a batch (1..2048 non-empty strings). */
	input: string | string[];
	dimensions?: number;
	user?: string;
}

export interface EmbeddingsResult {
	model: string;
	/** One vector per input, in input order. */
	embeddings: number[][];
	usage?: { promptTokens?: number; totalTokens?: number };
}

function decodeBase64Floats(b64: string, operation: string): number[] {
	const bytes = Buffer.from(b64, "base64");
	if (bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) {
		throw new OperationError("malformed_response", operation, "base64 embedding length is not a multiple of 4 bytes");
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const out: number[] = [];
	for (let i = 0; i < bytes.byteLength; i += 4) out.push(view.getFloat32(i, true));
	return out;
}

/** OpenAI-compatible `POST {baseUrl}/embeddings` (float vectors; base64 responses are also decoded). */
export async function createEmbeddings(
	config: OperationClientConfig,
	request: EmbeddingsRequest,
	options?: CallOptions,
): Promise<EmbeddingsResult> {
	const op = "embeddings";
	requireNonEmpty(request.model, op, "model");
	const inputs = Array.isArray(request.input) ? request.input : [request.input];
	if (inputs.length === 0 || inputs.length > MAX_EMBEDDING_INPUTS) {
		throw new OperationError("invalid_input", op, `input must contain 1..${MAX_EMBEDDING_INPUTS} items`);
	}
	for (const item of inputs) {
		if (typeof item !== "string" || item === "")
			throw new OperationError("invalid_input", op, "inputs must be non-empty strings");
	}
	if (request.dimensions !== undefined && (!Number.isInteger(request.dimensions) || request.dimensions < 1)) {
		throw new OperationError("invalid_input", op, "dimensions must be a positive integer");
	}
	const { body } = await perform(
		config,
		{
			operation: op,
			method: "POST",
			path: "embeddings",
			json: {
				model: request.model,
				input: request.input,
				encoding_format: "float",
				...(request.dimensions === undefined ? {} : { dimensions: request.dimensions }),
				...(request.user === undefined ? {} : { user: request.user }),
			},
		},
		"json",
		options,
	);
	const root = asRecord(body, op, "response");
	const data = asArray(root.data, op, "data");
	if (data.length !== inputs.length) {
		throw new OperationError("malformed_response", op, `expected ${inputs.length} embeddings, got ${data.length}`);
	}
	const embeddings: (number[] | undefined)[] = Array.from({ length: inputs.length }, () => undefined);
	for (const raw of data) {
		const entry = asRecord(raw, op, "data item");
		const index = asNumber(entry.index, op, "index");
		if (!Number.isInteger(index) || index < 0 || index >= inputs.length || embeddings[index]) {
			throw new OperationError("malformed_response", op, "embedding index out of range or duplicated");
		}
		const vector =
			typeof entry.embedding === "string"
				? decodeBase64Floats(entry.embedding, op)
				: asArray(entry.embedding, op, "embedding").map((n) => asNumber(n, op, "embedding value"));
		if (vector.length === 0) throw new OperationError("malformed_response", op, "empty embedding");
		embeddings[index] = vector;
	}
	const width = embeddings[0]?.length;
	if (embeddings.some((v) => v?.length !== width)) {
		throw new OperationError("malformed_response", op, "embeddings have inconsistent dimensions");
	}
	const usage = root.usage === undefined ? undefined : asRecord(root.usage, op, "usage");
	return {
		model: typeof root.model === "string" ? root.model : request.model,
		embeddings: embeddings as number[][],
		usage: usage
			? { promptTokens: optNumber(usage.prompt_tokens), totalTokens: optNumber(usage.total_tokens) }
			: undefined,
	};
}
