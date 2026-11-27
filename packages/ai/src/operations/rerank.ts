import type { CallOptions, OperationClientConfig } from "./config.ts";
import { OperationError } from "./errors.ts";
import { asArray, asNumber, asRecord, perform, requireNonEmpty } from "./http.ts";

/**
 * Rerank has no OpenAI standard. The caller names the wire shape explicitly:
 * - `cohere`: `{model, query, documents, top_n}` → `{results:[{index, relevance_score}]}` (Cohere v2, Jina, many gateways)
 * - `voyage`: `{model, query, documents, top_k}` → `{data:[{index, relevance_score}]}`
 * - `tei`: `{query, texts}` → `[{index, score}]` (HF text-embeddings-inference; model is fixed by the server)
 */
export type RerankShape = "cohere" | "voyage" | "tei";

export interface RerankConfig extends OperationClientConfig {
	/** Path under baseUrl, e.g. `rerank` or `v2/rerank`. Required: there is no default. */
	endpoint: string;
	shape: RerankShape;
}

export interface RerankRequest {
	model?: string;
	query: string;
	documents: string[];
	topN?: number;
}

export interface RerankHit {
	index: number;
	score: number;
	document: string;
}

export const MAX_RERANK_DOCUMENTS = 10_000;

/** Returns hits sorted by descending score, each pointing at the input document. */
export async function rerank(
	config: RerankConfig,
	request: RerankRequest,
	options?: CallOptions,
): Promise<RerankHit[]> {
	const op = "rerank";
	requireNonEmpty(config.endpoint, op, "endpoint");
	requireNonEmpty(request.query, op, "query");
	if (request.documents.length === 0 || request.documents.length > MAX_RERANK_DOCUMENTS) {
		throw new OperationError("invalid_input", op, `documents must contain 1..${MAX_RERANK_DOCUMENTS} items`);
	}
	if (config.shape !== "tei") requireNonEmpty(request.model ?? "", op, "model");
	if (request.topN !== undefined && (!Number.isInteger(request.topN) || request.topN < 1)) {
		throw new OperationError("invalid_input", op, "topN must be a positive integer");
	}
	const json =
		config.shape === "tei"
			? { query: request.query, texts: request.documents }
			: {
					model: request.model,
					query: request.query,
					documents: request.documents,
					...(request.topN === undefined
						? {}
						: config.shape === "voyage"
							? { top_k: request.topN }
							: { top_n: request.topN }),
				};
	const { body } = await perform(
		config,
		{ operation: op, method: "POST", path: config.endpoint, json },
		"json",
		options,
	);
	let items: unknown[];
	let scoreKey = "relevance_score";
	if (config.shape === "tei") {
		items = asArray(body, op, "response");
		scoreKey = "score";
	} else {
		const root = asRecord(body, op, "response");
		items = asArray(
			config.shape === "voyage" ? root.data : root.results,
			op,
			config.shape === "voyage" ? "data" : "results",
		);
	}
	const seen = new Set<number>();
	const hits = items.map((raw): RerankHit => {
		const item = asRecord(raw, op, "result item");
		const index = asNumber(item.index, op, "index");
		if (!Number.isInteger(index) || index < 0 || index >= request.documents.length || seen.has(index)) {
			throw new OperationError("malformed_response", op, "result index out of range or duplicated");
		}
		seen.add(index);
		return { index, score: asNumber(item[scoreKey], op, scoreKey), document: request.documents[index] };
	});
	hits.sort((a, b) => b.score - a.score || a.index - b.index);
	return request.topN === undefined ? hits : hits.slice(0, request.topN);
}
