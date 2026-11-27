import { afterEach, describe, expect, it } from "vitest";
import { streamSimple } from "../src/compat.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";
import { getSupportedThinkingLevels } from "../src/models.ts";

const originalBasetenApiKey = process.env.BASETEN_API_KEY;

afterEach(() => {
	if (originalBasetenApiKey === undefined) {
		delete process.env.BASETEN_API_KEY;
	} else {
		process.env.BASETEN_API_KEY = originalBasetenApiKey;
	}
});

describe("Baseten models", () => {
	it("keeps both GLM 5.2 endpoints text-only", () => {
		expect(getBuiltinModel("baseten", "zai-org/GLM-5.2").input).toEqual(["text"]);
		expect(getBuiltinModel("baseten", "zai-org/GLM-5.2-Fast").input).toEqual(["text"]);
	});

	it("models toggle-only Baseten reasoning as an explicit off/on toggle", async () => {
		// No current catalog model is toggle-only (Kimi K2.6 was, and has been retired), so derive a fixture
		// from a catalog model that uses the Baseten thinking format.
		const base = getBuiltinModel("baseten", "zai-org/GLM-5.2");
		const model = {
			...base,
			thinkingLevelMap: {
				off: "off",
				minimal: null,
				low: null,
				medium: null,
				high: "high",
				xhigh: null,
				max: null,
			},
			compat: { ...base.compat, supportsReasoningEffort: false },
		} satisfies typeof base;
		let payload: Record<string, unknown> | undefined;

		expect(model.thinkingLevelMap).toEqual({
			off: "off",
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			xhigh: null,
			max: null,
		});
		expect(model.compat).toMatchObject({
			supportsReasoningEffort: false,
			thinkingFormat: "baseten",
			chatTemplateArgs: { enable_thinking: { $var: "thinking.enabled" } },
		});
		expect(getSupportedThinkingLevels(model)).toEqual(["off", "high"]);

		await streamSimple(
			model,
			{ messages: [{ role: "user", content: "test", timestamp: 0 }] },
			{
				apiKey: "test-baseten-key",
				reasoning: "high",
				onPayload: (value) => {
					payload = value as Record<string, unknown>;
					throw new Error("payload captured");
				},
			},
		).result();

		expect(payload?.chat_template_args).toEqual({ enable_thinking: true });
		expect(payload?.reasoning_effort).toBeUndefined();
	});

	it("sends Baseten chat_template_args with reasoning effort", async () => {
		const model = getBuiltinModel("baseten", "zai-org/GLM-5.2");
		let payload: Record<string, unknown> | undefined;

		await streamSimple(
			model,
			{ messages: [{ role: "user", content: "test", timestamp: 0 }] },
			{
				apiKey: "test-baseten-key",
				reasoning: "high",
				onPayload: (value) => {
					payload = value as Record<string, unknown>;
					throw new Error("payload captured");
				},
			},
		).result();

		expect(payload?.chat_template_args).toEqual({ enable_thinking: true });
		expect(payload?.reasoning_effort).toBe("high");
	});

	it("disables Baseten opt-in reasoning when thinking is off", async () => {
		const model = getBuiltinModel("baseten", "zai-org/GLM-5.2");
		let payload: Record<string, unknown> | undefined;

		await streamSimple(
			model,
			{ messages: [{ role: "user", content: "test", timestamp: 0 }] },
			{
				apiKey: "test-baseten-key",
				onPayload: (value) => {
					payload = value as Record<string, unknown>;
					throw new Error("payload captured");
				},
			},
		).result();

		expect(payload?.chat_template_args).toEqual({ enable_thinking: false });
		expect(payload?.reasoning_effort).toBe("none");
	});

	it("resolves BASETEN_API_KEY from the environment", () => {
		process.env.BASETEN_API_KEY = "test-baseten-key";

		expect(findEnvKeys("baseten")).toEqual(["BASETEN_API_KEY"]);
		expect(getEnvApiKey("baseten")).toBe("test-baseten-key");
	});
});
