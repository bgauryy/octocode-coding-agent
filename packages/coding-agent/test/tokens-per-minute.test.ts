import { type Api, type Model, normalizeContext } from "@octocodeai/octocode-ai";
import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import { describe, expect, it } from "vitest";
import type { ThroughputReserveInput } from "../../db/src/api.ts";
import { configuredTokensPerMinute } from "../src/core/model-runtime/request-rate.ts";
import { throughputPolicy } from "../src/core/model-runtime/throughput-policy.ts";
import {
	ProviderThroughput,
	throughputStep,
	type ThroughputStore,
} from "../src/core/model-runtime/throughput-request.ts";

const kimi = {
	...getBuiltinModel("amazon-bedrock", "global.moonshotai.kimi-k3.1"),
	baseUrl: "https://bedrock-runtime.eu-central-1.amazonaws.com/openai/v1",
};

describe("tokensPerMinute in models.json", () => {
	it("takes the model's value over the provider's", () => {
		const provider = {
			tokensPerMinute: 300,
			models: [{ id: "own", tokensPerMinute: 100 }],
			modelOverrides: { builtin: { tokensPerMinute: 200 } },
		};
		expect(configuredTokensPerMinute(provider, "own")).toBe(100);
		expect(configuredTokensPerMinute(provider, "builtin")).toBe(200);
		expect(configuredTokensPerMinute(provider, "other")).toBe(300);
		expect(configuredTokensPerMinute(undefined, "x")).toBeUndefined();
	});

	it("sets the gate's budget, below the environment override and above the default", () => {
		expect(throughputPolicy(kimi, {}, undefined)?.tokensPerMinute).toBe(500_000);
		expect(throughputPolicy(kimi, {}, 123_000)?.tokensPerMinute).toBe(123_000);
		expect(throughputPolicy(kimi, { OCTOCODE_BEDROCK_KIMI_TPM: "77" }, 123_000)?.tokensPerMinute).toBe(77);
	});

	it("reaches the reservation the request makes", async () => {
		const reserved: ThroughputReserveInput[] = [];
		const store = {
			reserve: (input: ThroughputReserveInput) => {
				reserved.push(input);
				return { admitted: true, effectiveTokenLimit: 1, effectiveRequestLimit: 1, usage: { tokens: 0, requests: 0 } };
			},
			state: () => ({ scale: 1, successes: 0 }),
		} as unknown as ThroughputStore;
		const gate = new ProviderThroughput(() => store);
		const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });
		const step = throughputStep(
			kimi,
			context,
			{ maxTokens: 100, tokensPerMinute: (model: Model<Api>) => (model.id === kimi.id ? 4242 : undefined) },
			gate,
		);
		const hooks = step.hooks({}, kimi, { AWS_REGION: "eu-central-1" });
		await hooks.onPayload?.({ max_tokens: 100 }, kimi);
		expect(reserved.map((input) => input.tokenLimit)).toEqual([4242]);
	});
});

describe("tokensPerMinute on a model the gate did not cover before", () => {
	const openai = {
		...getBuiltinModel("openai", "gpt-5"),
		api: "openai-completions" as const,
		baseUrl: "https://api.example.com/v1",
	} as Model<Api>;

	/** A store that admits while the window's tokens fit, and one over-limit request into an empty window. */
	function fakeStore() {
		const reserved: ThroughputReserveInput[] = [];
		let used = 0;
		const store = {
			reserve: (input: ThroughputReserveInput) => {
				reserved.push(input);
				const fits = used + input.estimatedTokens <= input.tokenLimit;
				if (!fits && used > 0)
					return {
						admitted: false,
						effectiveTokenLimit: input.tokenLimit,
						usage: { tokens: used, requests: 1 },
						retryAt: input.now + 60_000,
					};
				used += input.estimatedTokens;
				return { admitted: true, effectiveTokenLimit: input.tokenLimit, usage: { tokens: used, requests: 1 } };
			},
			state: () => ({ scale: 1, successes: 0 }),
		} as unknown as ThroughputStore;
		return { store, reserved };
	}

	const send = async (store: ThroughputStore, tokensPerMinute: number | undefined, maxTokens: number) => {
		const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });
		const step = throughputStep(
			openai,
			context,
			{ maxTokens, maxRetryDelayMs: 1, tokensPerMinute: () => tokensPerMinute },
			new ProviderThroughput(() => store),
		);
		await step.hooks({}, openai, {}).onPayload?.({ max_tokens: maxTokens }, openai);
	};

	it("has no policy unconfigured, and a token-only one when configured", () => {
		expect(throughputPolicy(openai, {})).toBeUndefined();
		expect(throughputPolicy(openai, {}, 1000)).toEqual({
			key: `${openai.provider}/${openai.id}`,
			region: undefined,
			tokensPerMinute: 1000,
			outputBurndown: 1,
		});
	});

	it("holds a request whose estimate exceeds the budget, and passes the same request unconfigured", async () => {
		const gated = fakeStore();
		await send(gated.store, 1000, 800);
		await expect(send(gated.store, 1000, 800)).rejects.toThrow("would require");
		expect(gated.reserved.every((input) => input.tokenLimit === 1000 && input.requestLimit === undefined)).toBe(true);

		const open = fakeStore();
		await send(open.store, undefined, 800);
		await send(open.store, undefined, 800);
		expect(open.reserved).toEqual([]);
	});
});
