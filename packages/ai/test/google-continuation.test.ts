import type { GenerateContentParameters } from "@google/genai";
import { describe, expect, it } from "vitest";
import { streamSimple as streamSimpleGoogle } from "../src/api/google-generative-ai.ts";
import { buildGoogleParams } from "../src/api/google-shared/params.ts";
import { streamSimple as streamSimpleVertex } from "../src/api/google-vertex.ts";
import type { Model, SimpleStreamOptions } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

/**
 * Since @google/genai 2.29 `generateContentStream` defaults `config.automaticContinuation` to true: a long output is
 * re-requested as separately billed hops, and a dropped stream is resent up to three times outside `retryGoogleRequest`.
 * Every Google request turns it off, so our own retry and the CONTINUATION -> "length" stop reason stay in charge.
 */
const context = normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 0 }] });

function model<T extends "google-generative-ai" | "google-vertex">(api: T): Model<T> {
	return {
		id: "gemini-3.7-flash",
		name: "gemini-3.7-flash",
		api,
		provider: `test-${api}`,
		baseUrl: "https://example.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

type Run = (options: SimpleStreamOptions) => ReturnType<typeof streamSimpleGoogle>;

async function capture(run: Run) {
	let payload: GenerateContentParameters | undefined;
	const result = await run({
		apiKey: "test",
		onPayload: (request) => {
			payload = request as GenerateContentParameters;
			throw new Error("payload captured");
		},
	}).result();
	expect(result.errorMessage).toContain("payload captured");
	if (!payload) throw new Error("payload was not captured");
	return payload;
}

describe("Google automatic continuation", () => {
	it("is off in the built config, even when nothing else sets a config field", () => {
		const params = buildGoogleParams(model("google-generative-ai"), context);
		expect(params.config?.automaticContinuation).toBe(false);
	});

	it.each<[string, Run]>([
		["Google Generative AI", (options) => streamSimpleGoogle(model("google-generative-ai"), context, options)],
		["Google Vertex", (options) => streamSimpleVertex(model("google-vertex"), context, options)],
	])("is off in the request %s sends", async (_name, run) => {
		const payload = await capture(run);
		expect(payload.config?.automaticContinuation).toBe(false);
	});
});
