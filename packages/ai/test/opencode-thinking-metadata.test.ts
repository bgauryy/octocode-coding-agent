import { describe, expect, it } from "vitest";
import { applyUpstreamCorrections } from "../scripts/generate-models/upstream-corrections.ts";
import { streamSimple } from "../src/compat.ts";
import { clampThinkingLevel, getSupportedThinkingLevels } from "../src/models/model-helpers.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { Api, Model } from "../src/types.ts";

const enabledLevels = ["low", "medium", "high", "xhigh", "max"];

describe("OpenCode Claude 5.5 thinking metadata", () => {
	it.each(["claude-opus-5-5", "claude-sonnet-5-5"] as const)(
		"%s exposes only supported effort choices in hydrated catalogs and generation",
		(id) => {
			const builtin = getBuiltinModel("opencode", id);
			expect(getSupportedThinkingLevels(builtin)).toEqual(enabledLevels);
			expect(clampThinkingLevel(builtin, "off")).toBe("low");
			expect(clampThinkingLevel(builtin, "minimal")).toBe("low");
			const generated: Model<Api> = { ...builtin, thinkingLevelMap: { xhigh: "xhigh", max: "max" } };
			applyUpstreamCorrections([generated]);
			expect(generated.thinkingLevelMap).toEqual(builtin.thinkingLevelMap);
		},
	);

	it.each(["opencode", "opencode-go"] as const)("%s preserves Haiku's supported off option", (provider) => {
		const model = getBuiltinModel(provider, "claude-haiku-5-5");
		expect(getSupportedThinkingLevels(model)).toEqual(["off", ...enabledLevels]);
		expect(clampThinkingLevel(model, "off")).toBe("off");
	});

	it("does not disable always-on thinking and sends the selected effort in gateway requests", async () => {
		const model = getBuiltinModel("opencode", "claude-sonnet-5-5");
		const requests: { thinking?: { type: string }; output_config?: { effort: string } }[] = [];
		const fetchStub: typeof fetch = async (_url, init) => {
			requests.push(JSON.parse(String(init?.body)));
			return Response.json({ error: { message: "intercepted" } }, { status: 400 });
		};
		const context = { messages: [{ role: "user" as const, content: "hello", timestamp: 0 }] };
		await streamSimple(model, context, { apiKey: "test-key", maxRetries: 0, fetch: fetchStub }).result();
		expect(requests[0]).toMatchObject({ model: model.id });
		expect(requests[0]?.thinking?.type).not.toBe("disabled");
		await streamSimple(model, context, {
			apiKey: "test-key",
			maxRetries: 0,
			fetch: fetchStub,
			reasoning: "low",
		}).result();
		expect(requests[1]).toMatchObject({ thinking: { type: "adaptive" }, output_config: { effort: "low" } });
	});
});
