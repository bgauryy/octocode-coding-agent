import { isDeepStrictEqual } from "node:util";

/** Observations from a single tool call. The adapter supplies each observation at its own boundary. */
export interface ToolCallStages {
	/** Argument-text fragments for this call, in wire order. Omit when the route has no raw evidence. */
	rawDeltas?: string[];
	assistant: unknown;
	beforeValidation: unknown;
	validation: { accepted: true; arguments: unknown } | { accepted: false; error: string };
	/** Each invocation observed by the server for this call, including an unexpected retry. */
	serverCalls: unknown[];
}

/** First observed difference from the control's intended arguments, or "unknown" across a missing raw boundary. */
export function firstToolCallDifference(expected: unknown, stages: ToolCallStages) {
	const rawDeltas = stages.rawDeltas;
	if (rawDeltas?.length) {
		let raw: unknown;
		try {
			raw = JSON.parse(rawDeltas.join(""));
		} catch (error) {
			if (error instanceof SyntaxError) return "provider-deltas";
			throw error;
		}
		if (!isDeepStrictEqual(expected, raw)) return "provider-deltas";
	}
	if (!isDeepStrictEqual(expected, stages.assistant)) return rawDeltas?.length ? "parsed-assistant" : "unknown";
	if (!isDeepStrictEqual(expected, stages.beforeValidation)) return "host-preparation";
	if (!stages.validation.accepted || !isDeepStrictEqual(expected, stages.validation.arguments)) return "validation";
	if (!isDeepStrictEqual([expected], stages.serverCalls)) return "server-received";
	return "none";
}
