import { downloadFile } from "./files.ts";
import type { CallOptions, OperationClientConfig } from "./config.ts";
import { OperationError } from "./errors.ts";
import {
	asArray,
	asNumber,
	asRecord,
	asString,
	optNumber,
	optString,
	perform,
	requireId,
	requireNonEmpty,
} from "./http.ts";

export type BatchEndpoint =
	| "/v1/responses"
	| "/v1/chat/completions"
	| "/v1/embeddings"
	| "/v1/completions"
	| "/v1/moderations";

export interface BatchRequest {
	/** Id of an uploaded `purpose: "batch"` JSONL file. */
	inputFileId: string;
	endpoint: BatchEndpoint;
	/** Default `24h`, the only window OpenAI supports. */
	completionWindow?: "24h";
	metadata?: Record<string, string>;
}

export interface BatchObject {
	id: string;
	status: string;
	endpoint: string;
	inputFileId: string;
	outputFileId?: string;
	errorFileId?: string;
	createdAt: number;
	requestCounts?: { total: number; completed: number; failed: number };
}

const TERMINAL = new Set(["completed", "failed", "expired", "cancelled"]);
export const isBatchTerminal = (batch: BatchObject): boolean => TERMINAL.has(batch.status);

function parseBatch(raw: unknown, op: string): BatchObject {
	const r = asRecord(raw, op, "batch");
	const counts = r.request_counts === undefined ? undefined : asRecord(r.request_counts, op, "request_counts");
	return {
		id: asString(r.id, op, "id"),
		status: asString(r.status, op, "status"),
		endpoint: asString(r.endpoint, op, "endpoint"),
		inputFileId: asString(r.input_file_id, op, "input_file_id"),
		outputFileId: optString(r.output_file_id) ?? undefined,
		errorFileId: optString(r.error_file_id) ?? undefined,
		createdAt: asNumber(r.created_at, op, "created_at"),
		requestCounts: counts
			? {
					total: optNumber(counts.total) ?? 0,
					completed: optNumber(counts.completed) ?? 0,
					failed: optNumber(counts.failed) ?? 0,
				}
			: undefined,
	};
}

/** `POST /batches`. */
export async function createBatch(
	config: OperationClientConfig,
	request: BatchRequest,
	options?: CallOptions,
): Promise<BatchObject> {
	const op = "batch.create";
	requireNonEmpty(request.inputFileId, op, "inputFileId");
	const { body } = await perform(
		config,
		{
			operation: op,
			method: "POST",
			path: "batches",
			json: {
				input_file_id: request.inputFileId,
				endpoint: request.endpoint,
				completion_window: request.completionWindow ?? "24h",
				...(request.metadata ? { metadata: request.metadata } : {}),
			},
		},
		"json",
		options,
	);
	return parseBatch(body, op);
}

/** `GET /batches/{id}`. */
export async function getBatch(config: OperationClientConfig, id: string, options?: CallOptions): Promise<BatchObject> {
	const op = "batch.get";
	const { body } = await perform(
		config,
		{ operation: op, method: "GET", path: `batches/${requireId(id, op)}` },
		"json",
		options,
	);
	return parseBatch(body, op);
}

/** `POST /batches/{id}/cancel`. */
export async function cancelBatch(
	config: OperationClientConfig,
	id: string,
	options?: CallOptions,
): Promise<BatchObject> {
	const op = "batch.cancel";
	const { body } = await perform(
		config,
		{ operation: op, method: "POST", path: `batches/${requireId(id, op)}/cancel` },
		"json",
		options,
	);
	return parseBatch(body, op);
}

/** `GET /batches`. */
export async function listBatches(
	config: OperationClientConfig,
	query: { limit?: number; after?: string } = {},
	options?: CallOptions,
): Promise<{ batches: BatchObject[]; hasMore: boolean }> {
	const op = "batch.list";
	const { body } = await perform(config, { operation: op, method: "GET", path: "batches", query }, "json", options);
	const root = asRecord(body, op, "response");
	return { batches: asArray(root.data, op, "data").map((b) => parseBatch(b, op)), hasMore: root.has_more === true };
}

export interface BatchResultLine {
	customId: string;
	statusCode?: number;
	/** Response body for a succeeded request. */
	response?: unknown;
	/** Error object for a failed request. */
	error?: unknown;
}

/** Parses a batch output/error JSONL file; any malformed line fails the whole parse. */
export function parseBatchJsonl(text: string): BatchResultLine[] {
	const op = "batch.parse";
	const out: BatchResultLine[] = [];
	for (const [i, line] of text.split("\n").entries()) {
		if (line.trim() === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			throw new OperationError("malformed_response", op, `line ${i + 1} is not valid JSON`);
		}
		const r = asRecord(parsed, op, `line ${i + 1}`);
		const response = r.response === null || r.response === undefined ? undefined : asRecord(r.response, op, "response");
		out.push({
			customId: asString(r.custom_id, op, "custom_id"),
			statusCode: response ? optNumber(response.status_code) : undefined,
			response: response?.body,
			error: r.error ?? undefined,
		});
	}
	return out;
}

/** Downloads and parses a batch's output file (or error file with `which: "error"`). Fails if the file id is absent. */
export async function fetchBatchResults(
	config: OperationClientConfig,
	batch: BatchObject,
	which: "output" | "error" = "output",
	options?: CallOptions,
): Promise<BatchResultLine[]> {
	const fileId = which === "output" ? batch.outputFileId : batch.errorFileId;
	if (!fileId)
		throw new OperationError(
			"invalid_input",
			"batch.results",
			`batch ${batch.id} has no ${which} file (status ${batch.status})`,
		);
	const bytes = await downloadFile(config, fileId, options);
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new OperationError("malformed_response", "batch.results", "result file is not valid UTF-8");
	}
	return parseBatchJsonl(text);
}
