import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/compat.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { Context, Model, SimpleStreamOptions } from "../src/types.ts";

interface AnthropicThinkingPayload {
	thinking?: { type: string; budget_tokens?: number; display?: string };
	output_config?: { effort?: string };
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

function makePayloadCaptureContext(): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

async function capturePayload(
	model: Model<"anthropic-messages">,
	options?: SimpleStreamOptions,
): Promise<AnthropicThinkingPayload> {
	let capturedPayload: AnthropicThinkingPayload | undefined;
	const payloadCaptureModel: Model<"anthropic-messages"> = {
		...model,
		baseUrl: "http://127.0.0.1:9",
	};

	const s = streamSimple(payloadCaptureModel, makePayloadCaptureContext(), {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as AnthropicThinkingPayload;
			throw new PayloadCaptured();
		},
	});

	await s.result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}

	return capturedPayload;
}

describe("Anthropic thinking budget near the context limit", () => {
	it("sends no budget below the API minimum: thinking is off when the free context cannot hold 1024 thinking tokens", async () => {
		const base = getBuiltinModel("anthropic", "claude-sonnet-4-5");
		const near = { ...base, contextWindow: 1800, compat: { ...base.compat, forceAdaptiveThinking: false } };
		const payload = (await capturePayload(near, { reasoning: "high" })) as AnthropicThinkingPayload & {
			max_tokens?: number;
		};
		expect(payload.thinking).toEqual({ type: "disabled" });
		// With room to spare, budget-based thinking still applies with a valid budget.
		const roomy = { ...base, compat: { ...base.compat, forceAdaptiveThinking: false } };
		const enabled = (await capturePayload(roomy, { reasoning: "high" })) as AnthropicThinkingPayload & {
			max_tokens: number;
		};
		expect(enabled.thinking?.budget_tokens).toBeGreaterThanOrEqual(1024);
		expect(enabled.max_tokens).toBeGreaterThan(enabled.thinking!.budget_tokens!);
	});
});

describe("Anthropic thinking disable payload", () => {
	it.each(["claude-sonnet-4-5", "claude-opus-4-6"] as const)(
		"preserves thinking cache parameters with a summary cap for %s",
		async (id) => {
			const model = getBuiltinModel("anthropic", id);
			const normal = await capturePayload(model, { reasoning: "high", thinkingBudgets: { high: 4000 } });
			const summary = await capturePayload(model, {
				reasoning: "high",
				thinkingBudgets: { high: 4000 },
				maxTokens: 8000,
			});
			expect(summary.thinking).toEqual(normal.thinking);
			expect(summary.output_config).toEqual(normal.output_config);
		},
	);

	it("sends thinking.type=disabled for budget-based reasoning models when thinking is off", async () => {
		const payload = await capturePayload(getBuiltinModel("anthropic", "claude-sonnet-4-5"));

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config).toBeUndefined();
	});

	it("sends thinking.type=disabled for adaptive reasoning models when thinking is off", async () => {
		const payload = await capturePayload(getBuiltinModel("anthropic", "claude-opus-4-6"));

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config).toBeUndefined();
	});

	it("sends thinking.type=disabled for Claude Opus 4.8 when thinking is off", async () => {
		const payload = await capturePayload(getBuiltinModel("anthropic", "claude-opus-4-8"));

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config).toBeUndefined();
	});

	it("omits thinking.type=disabled for Claude Fable 5 when thinking is off and asks for its least effort", async () => {
		const payload = await capturePayload(getBuiltinModel("anthropic", "claude-fable-5"));

		// Fable 5 cannot turn thinking off (`off: null`), so it thinks adaptively at its least effort.
		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "low" });
	});

	it("uses adaptive thinking for Claude Opus 4.8 when reasoning is enabled", async () => {
		const payload = await capturePayload(getBuiltinModel("anthropic", "claude-opus-4-8"), { reasoning: "high" });

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "high" });
	});

	it("uses adaptive thinking for Claude Sonnet 5 when reasoning is enabled", async () => {
		const payload = await capturePayload(getBuiltinModel("anthropic", "claude-sonnet-5"), { reasoning: "high" });

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "high" });
	});

	it("maps xhigh reasoning to effort=xhigh for Claude Opus 4.8", async () => {
		const payload = await capturePayload(getBuiltinModel("anthropic", "claude-opus-4-8"), { reasoning: "xhigh" });

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "xhigh" });
	});
});
