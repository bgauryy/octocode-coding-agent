import type { GoogleWirePayload as GenerateContentParameters } from "./google-fetch-fixture.ts";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { streamSimple as streamSimpleGoogle } from "../src/api/google-generative-ai.ts";
import { captureMistralPayload } from "./mistral-payload-fixture.ts";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import type { Model, ThinkingLevelMap, Tool } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const userMessage = { role: "user" as const, content: "hi", timestamp: 0 };

async function capture<T>(run: (onPayload: (payload: unknown) => never) => { result(): Promise<unknown> }) {
	let captured: T | undefined;
	await run((payload) => {
		captured = payload as T;
		throw new Error("payload captured");
	}).result();
	if (!captured) throw new Error("payload was not captured");
	return captured;
}

describe("OpenAI Responses supportsTemperature", () => {
	const model = (compat?: Model<"openai-responses">["compat"]): Model<"openai-responses"> => ({
		id: "m",
		name: "m",
		api: "openai-responses",
		provider: "vendor",
		baseUrl: "https://vendor.example/v1",
		reasoning: false,
		input: ["text"],
		cost,
		contextWindow: 100_000,
		maxTokens: 4096,
		compat,
	});
	const payload = (m: Model<"openai-responses">) =>
		capture<{ temperature?: number }>((onPayload) =>
			streamOpenAIResponses(m, normalizeContext({ messages: [userMessage] }), {
				apiKey: "k",
				temperature: 0.4,
				onPayload,
			}),
		);

	it("sends temperature by default and omits it when disabled", async () => {
		expect((await payload(model())).temperature).toBe(0.4);
		expect((await payload(model({ supportsTemperature: false }))).temperature).toBeUndefined();
	});
});

describe("Google supportsTemperature and disabled thinking", () => {
	const model = (
		compat?: Model<"google-generative-ai">["compat"],
		thinkingLevelMap?: ThinkingLevelMap,
	): Model<"google-generative-ai"> => ({
		id: "gemini-2.5-flash",
		name: "g",
		api: "google-generative-ai",
		provider: "test-google",
		baseUrl: "https://example.invalid/v1beta",
		reasoning: true,
		thinkingLevelMap,
		input: ["text"],
		cost,
		contextWindow: 100_000,
		maxTokens: 4096,
		compat,
	});
	const payload = (m: Model<"google-generative-ai">, reasoning?: "low") =>
		capture<{ generationConfig?: GenerateContentParameters["config"] }>((onPayload) =>
			streamSimpleGoogle(m, normalizeContext({ messages: [userMessage] }), {
				apiKey: "k",
				temperature: 0.4,
				reasoning,
				onPayload,
			}),
		);

	it("sends temperature by default and omits it when disabled", async () => {
		expect((await payload(model())).generationConfig?.temperature).toBe(0.4);
		expect((await payload(model({ supportsTemperature: false }))).generationConfig?.temperature).toBeUndefined();
	});

	it("disables a budget model with budget 0 unless its off mapping says otherwise", async () => {
		expect((await payload(model())).generationConfig?.thinkingConfig).toEqual({ thinkingBudget: 0 });
		expect((await payload(model(undefined, { off: "128" }))).generationConfig?.thinkingConfig).toEqual({
			thinkingBudget: 128,
		});
		expect((await payload(model(undefined, { off: null }))).generationConfig?.thinkingConfig).toEqual({});
	});
});

describe("Mistral supportsTemperature and supportsStrictMode", () => {
	const model = (compat?: Model<"mistral-conversations">["compat"]): Model<"mistral-conversations"> => ({
		id: "m",
		name: "m",
		api: "mistral-conversations",
		provider: "mistral",
		baseUrl: "https://api.mistral.ai",
		reasoning: false,
		input: ["text"],
		cost,
		contextWindow: 100_000,
		maxTokens: 4096,
		compat,
	});
	const tool: Tool = {
		name: "inspect",
		description: "Inspect",
		parameters: Type.Object({ value: Type.String() }),
		constrainedSampling: { type: "json_schema", strict: "prefer" },
	};
	const build = (m: Model<"mistral-conversations">) => {
		const context = normalizeContext({ messages: [userMessage], tools: [tool] });
		return captureMistralPayload(m, context, { temperature: 0.4 });
	};

	it("omits temperature when disabled", async () => {
		expect((await build(model())).temperature).toBe(0.4);
		expect((await build(model({ supportsTemperature: false }))).temperature).toBeUndefined();
	});

	it("sends strict tools unless the model does not support them", async () => {
		expect((await build(model())).tools?.[0]?.function.strict).toBe(true);
		expect((await build(model({ supportsStrictMode: false }))).tools?.[0]?.function.strict).toBe(false);
	});
});
