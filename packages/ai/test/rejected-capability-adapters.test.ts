import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { streamSimple as anthropic } from "../src/api/anthropic-messages.ts";
import { streamSimple as converse } from "../src/api/bedrock-converse-stream.ts";
import { streamSimple as completions } from "../src/api/openai-completions.ts";
import { streamSimple as responses } from "../src/api/openai-responses.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { Api, Model, SimpleStreamOptions } from "../src/types.ts";
import { clearRejectedCapabilities } from "../src/utils/rejected-capabilities.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

/** Every adapter sends through the one fetch of `streamSdk`; each is shown to resend once and then keep the field out. */
const context = normalizeContext({
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
	tools: [
		{
			name: "t",
			description: "a tool",
			parameters: Type.Object({ a: Type.String() }),
			constrainedSampling: { type: "json_schema", strict: "prefer" },
		},
	],
});

type Capability = "cache_control" | "strict" | "effort";

interface Case {
	label: string;
	capability: Capability;
	model: Model<Api>;
	stream: (model: never, context: never, options: SimpleStreamOptions) => { result(): Promise<unknown> };
	options?: SimpleStreamOptions;
	/** The request carries the field. */
	sent: RegExp;
	/** How the provider words its refusal. */
	refusal: string;
}

const base = {
	name: "m",
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 4096,
};

const gatewayClaude = (baseUrl: string, compat = {}): Model<"anthropic-messages"> => ({
	...getBuiltinModel("anthropic", "claude-opus-5-5"),
	provider: "gateway",
	baseUrl,
	compat: { supportsStrictTools: true, ...compat },
});

const chat = (baseUrl: string, compat = {}): Model<"openai-completions"> => ({
	...base,
	id: "claude-x",
	api: "openai-completions",
	provider: "gateway",
	baseUrl,
	reasoning: true,
	profile: "anthropic",
	compat: { supportsStrictMode: true, ...compat },
});

const resp = (baseUrl: string): Model<"openai-responses"> => ({
	...base,
	id: "gpt-x",
	api: "openai-responses",
	provider: "gateway",
	baseUrl,
	reasoning: true,
	compat: { supportsStrictMode: true },
});

const bedrock = (): Model<"bedrock-converse-stream"> => ({
	...getBuiltinModel("amazon-bedrock", "us.anthropic.claude-opus-4-8"),
	baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
});

const CASES: Case[] = [
	{
		label: "anthropic-messages cache_control",
		capability: "cache_control",
		model: gatewayClaude("https://a1.example"),
		stream: anthropic,
		sent: /"cache_control"/,
		refusal: "system.0.cache_control: Extra inputs are not permitted",
	},
	{
		label: "anthropic-messages strict",
		capability: "strict",
		model: gatewayClaude("https://a2.example"),
		stream: anthropic,
		sent: /"strict":true/,
		refusal: "tools.0.strict: Extra inputs are not permitted",
	},
	{
		label: "anthropic-messages effort",
		capability: "effort",
		model: gatewayClaude("https://a3.example", { forceAdaptiveThinking: true }),
		stream: anthropic,
		options: { reasoning: "high" },
		sent: /"effort"/,
		refusal: "output_config.effort: Extra inputs are not permitted",
	},
	{
		label: "openai-completions cache_control",
		capability: "cache_control",
		model: chat("https://c1.example/v1"),
		stream: completions,
		sent: /"cache_control"/,
		refusal: "messages.0.cache_control: Extra inputs are not permitted",
	},
	{
		label: "openai-completions strict",
		capability: "strict",
		model: chat("https://c2.example/v1"),
		stream: completions,
		sent: /"strict":true/,
		refusal: "Unknown parameter: 'tools[0].function.strict'",
	},
	{
		label: "openai-completions effort",
		capability: "effort",
		model: chat("https://c3.example/v1"),
		stream: completions,
		options: { reasoning: "high" },
		sent: /"reasoning_effort"/,
		refusal: "Unknown parameter: 'reasoning_effort'",
	},
	{
		label: "openai-responses strict",
		capability: "strict",
		model: resp("https://r1.example/v1"),
		stream: responses,
		sent: /"strict":true/,
		refusal: "Unknown parameter: 'tools[0].strict'",
	},
	{
		label: "openai-responses effort",
		capability: "effort",
		model: resp("https://r2.example/v1"),
		stream: responses,
		options: { reasoning: "high" },
		sent: /"effort"/,
		refusal: "Unknown parameter: 'reasoning.effort'",
	},
	{
		label: "bedrock-converse-stream cache_control",
		capability: "cache_control",
		model: bedrock(),
		stream: converse,
		sent: /"cachePoint"/,
		refusal: "extraneous key [cachePoint] is not permitted",
	},
	{
		label: "bedrock-converse-stream effort",
		capability: "effort",
		model: bedrock(),
		stream: converse,
		options: { reasoning: "high" },
		sent: /"effort"/,
		refusal: "output_config.effort: extraneous key is not permitted",
	},
];

function endpoint(sent: RegExp, refusal: string) {
	const bodies: string[] = [];
	const fetch: typeof globalThis.fetch = async (_input, init) => {
		const body = String(init?.body);
		bodies.push(body);
		const message = sent.test(body) ? refusal : "fixture end";
		return new Response(JSON.stringify({ message, error: { message } }), {
			status: 400,
			headers: { "content-type": "application/json" },
		});
	};
	return { bodies, fetch };
}

describe("a 400 that rejects a capability, on every adapter", () => {
	afterEach(() => clearRejectedCapabilities());

	it.each(CASES)("$label is resent once without the field, then never sent", async (testCase) => {
		const { bodies, fetch } = endpoint(testCase.sent, testCase.refusal);
		const options = { apiKey: "fixture", fetch, maxRetries: 0, ...testCase.options } as SimpleStreamOptions;

		await testCase.stream(testCase.model as never, context as never, options).result();
		expect(bodies[0]).toMatch(testCase.sent);
		expect(bodies).toHaveLength(2);
		expect(bodies[1]).not.toMatch(testCase.sent);

		await testCase.stream(testCase.model as never, context as never, options).result();
		expect(bodies).toHaveLength(3);
		expect(bodies[2]).not.toMatch(testCase.sent);
	});

	it("sends no effort field for a model whose map allows no level", async () => {
		const none: Model<"openai-completions"> = {
			...chat("https://n1.example/v1"),
			thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null },
		};
		const { bodies, fetch } = endpoint(/never/, "");
		await completions(none, context, { apiKey: "fixture", fetch, maxRetries: 0, reasoning: "high" }).result();
		expect(bodies[0]).not.toMatch(/reasoning_effort/);
	});
});
