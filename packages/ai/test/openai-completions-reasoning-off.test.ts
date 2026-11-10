import { describe, expect, it } from "vitest";
import { buildParams } from "../src/api/openai-completions/params.ts";
import type { Model, ThinkingLevelMap } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });

function model(
	compat: Model<"openai-completions">["compat"],
	thinkingLevelMap?: ThinkingLevelMap,
	baseUrl = "https://vendor.example/v1",
): Model<"openai-completions"> {
	return {
		id: "m",
		name: "m",
		api: "openai-completions",
		provider: "vendor",
		baseUrl,
		reasoning: true,
		thinkingLevelMap,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4096,
		compat,
	};
}

const off = (m: Model<"openai-completions">) => buildParams(m, context) as unknown as Record<string, unknown>;

describe("openai-completions thinking off without an off mapping", () => {
	it("openai format sends reasoning_effort none to the OpenAI API", () => {
		const m = model(
			{ thinkingFormat: "openai", supportsReasoningEffort: true },
			undefined,
			"https://api.openai.com/v1",
		);
		expect(off(m).reasoning_effort).toBe("none");
	});

	it("openai format sends nothing to an endpoint whose data lists no off value", () => {
		expect(off(model({ thinkingFormat: "openai", supportsReasoningEffort: true })).reasoning_effort).toBeUndefined();
	});

	it("openai format keeps an explicit off mapping and omits it when unsupported", () => {
		expect(off(model({ supportsReasoningEffort: true }, { off: "minimal" })).reasoning_effort).toBe("minimal");
		const unsupported = model({ supportsReasoningEffort: true }, { off: null }, "https://api.openai.com/v1");
		expect(off(unsupported).reasoning_effort).toBeUndefined();
	});

	it("baseten format sends its mapped off effort", () => {
		expect(
			off(model({ thinkingFormat: "baseten", supportsReasoningEffort: true }, { off: "none" })).reasoning_effort,
		).toBe("none");
	});

	it("zai format disables thinking", () => {
		expect(off(model({ thinkingFormat: "zai" })).thinking).toEqual({ type: "disabled" });
	});

	it("qwen format sets enable_thinking false", () => {
		expect(off(model({ thinkingFormat: "qwen" })).enable_thinking).toBe(false);
	});

	it("qwen-chat-template format sets enable_thinking false", () => {
		expect(off(model({ thinkingFormat: "qwen-chat-template" })).chat_template_kwargs).toMatchObject({
			enable_thinking: false,
		});
	});

	it("deepseek format disables thinking", () => {
		expect(off(model({ thinkingFormat: "deepseek" })).thinking).toEqual({ type: "disabled" });
	});

	it("openrouter format sends reasoning effort none", () => {
		expect(off(model({ thinkingFormat: "openrouter" })).reasoning).toEqual({ effort: "none" });
	});

	it("together format disables reasoning", () => {
		expect(off(model({ thinkingFormat: "together" })).reasoning).toEqual({ enabled: false });
	});

	it("string-thinking format sends thinking none", () => {
		expect(off(model({ thinkingFormat: "string-thinking" })).thinking).toBe("none");
	});

	it("ant-ling format has no documented off value, so it sends nothing", () => {
		const params = off(model({ thinkingFormat: "ant-ling", supportsReasoningEffort: false }));
		expect(params.reasoning).toBeUndefined();
		expect(params.reasoning_effort).toBeUndefined();
	});
});

describe("openai-completions temperature", () => {
	it("is omitted when the model does not accept it", () => {
		const options = { temperature: 0.3 };
		const accepted = buildParams(model({}), context, options) as unknown as Record<string, unknown>;
		const rejected = buildParams(model({ supportsTemperature: false }), context, options) as unknown as Record<
			string,
			unknown
		>;
		expect(accepted.temperature).toBe(0.3);
		expect(rejected.temperature).toBeUndefined();
	});
});
