import type { GenerateContentParameters } from "@google/genai";
import { describe, expect, it } from "vitest";
import { streamSimple as streamSimpleGoogle } from "../src/api/google-generative-ai.ts";
import { streamSimple as streamSimpleVertex } from "../src/api/google-vertex.ts";
import { replaysWithReasoningUnchanged } from "../src/models/capabilities.ts";
import type { Model, SimpleStreamOptions } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

/**
 * The cache warmer replays the latest request with a one-token output cap. On Gemini the thinking setting is a level
 * or a fixed per-family budget, never derived from the output cap, so the replay must send the same contents, system
 * instruction, tools and thinking config as the original: only `maxOutputTokens` differs.
 */
const context = normalizeContext({
	messages: [
		{ role: "system", content: "You are terse.", timestamp: 0 },
		{ role: "user", content: "Hello", timestamp: 1 },
	],
});

function model<T extends "google-generative-ai" | "google-vertex">(api: T, id: string): Model<T> {
	return {
		id,
		name: id,
		api,
		provider: `test-${api}`,
		baseUrl: "https://example.invalid/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 65536,
	};
}

type Run = (options: SimpleStreamOptions) => ReturnType<typeof streamSimpleGoogle>;

async function capture(run: Run, options: SimpleStreamOptions): Promise<GenerateContentParameters> {
	let payload: GenerateContentParameters | undefined;
	await run({
		...options,
		apiKey: "test",
		onPayload: (request) => {
			payload = request as GenerateContentParameters;
			throw new Error("payload captured");
		},
	}).result();
	if (!payload) throw new Error("payload was not captured");
	return payload;
}

function withoutOutputCap(payload: GenerateContentParameters): GenerateContentParameters {
	const { maxOutputTokens: _cap, ...config } = payload.config ?? {};
	return { ...payload, config };
}

type Case = [string, Run, Model<"google-generative-ai" | "google-vertex">, "thinkingBudget" | "thinkingLevel"];

// Budget control (Gemini 2.5 family) and level control (Gemini 3 and later), on both Google APIs.
const cases: Case[] = (
	[
		["gemini-2.5-pro", "thinkingBudget"],
		["gemini-3.7-flash", "thinkingLevel"],
	] as const
).flatMap(([id, control]): Case[] => {
	const google = model("google-generative-ai", id);
	const vertex = model("google-vertex", id);
	return [
		[`Google Generative AI ${id}`, (options) => streamSimpleGoogle(google, context, options), google, control],
		[`Google Vertex ${id}`, (options) => streamSimpleVertex(vertex, context, options), vertex, control],
	];
});

describe("Gemini one-token replay with reasoning", () => {
	it.each(cases)(
		"%s: the replay differs from the original only in maxOutputTokens",
		async (_name, run, target, control) => {
			const original = await capture(run, { reasoning: "high", maxTokens: 32000 });
			const replay = await capture(run, { reasoning: "high", maxTokens: 1 });
			expect(original.config?.thinkingConfig?.[control]).toBeDefined();
			expect(replay.config?.maxOutputTokens).toBe(1);
			expect(withoutOutputCap(replay)).toEqual(withoutOutputCap(original));
			expect(replaysWithReasoningUnchanged(target)).toBe(true);
		},
	);
});
