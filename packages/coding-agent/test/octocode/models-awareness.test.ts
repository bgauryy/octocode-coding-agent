import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolDefinition } from "../../src/core/features/index.ts";
import { credentialSourceLabel } from "../../src/core/provider-composer/types.ts";
import { MODELS_DEV_ENV } from "../../src/octocode/subagents/catalog.ts";
import { canRunTask, type ModelRef, routeModel } from "../../src/octocode/subagents/model.ts";
import { registerModelsTool } from "../../src/octocode/subagents/models-tool.ts";
import { meteredBilling } from "./fake-host.ts";

const m = (provider: string, id: string, input: number, output: number, context = 200_000): ModelRef => ({
	provider,
	id,
	cost: { input, output },
	contextWindow: context,
});
const sessionModel = m("openai", "gpt-5", 5, 25);
const mini = m("openai", "gpt-5-mini", 0.25, 2);
// Small window: `canRunTask` rejects it from its own metadata, with no models.dev entry.
const tiny = m("openai", "gpt-4", 30, 60, 8_192);
const zen = m("opencode-go", "qwen-coder", 0.5, 2);
const refs = [sessionModel, mini, tiny, zen];

describe("canRunTask and explicit routes", () => {
	it("rejects a known small window and accepts a model with unknown capability", () => {
		expect(canRunTask(tiny, undefined)).toBe(false);
		expect(canRunTask(mini, undefined)).toBe(true);
		const unknown = { provider: "p", id: "mystery" };
		expect(canRunTask(unknown, undefined)).toBe(true);
	});

	it("refuses an explicit model that cannot run a task and names runnable ones of its provider", () => {
		const route = routeModel({ explicit: "openai/gpt-4", available: refs, parent: sessionModel });
		expect(route).toEqual({
			error:
				'Model "openai/gpt-4" cannot run a task: context 8.2k (needs 100k). Runnable openai models: openai/gpt-5, openai/gpt-5-mini',
		});
		// A bare id resolves the same way.
		expect(routeModel({ explicit: "gpt-4:low", available: refs, parent: sessionModel })).toHaveProperty("error");
	});

	it("starts a model the catalog does not know, and a runnable one", () => {
		const unknown = { provider: "p", id: "mystery" } as ModelRef;
		expect(routeModel({ explicit: "p/mystery", available: [sessionModel, unknown], parent: sessionModel })).toEqual({
			model: "p/mystery",
		});
		expect(routeModel({ explicit: "openai/gpt-5-mini", available: refs, parent: sessionModel })).toEqual({
			model: "openai/gpt-5-mini",
		});
	});
});

describe("credential labels", () => {
	it("names each source in words, preferring the credential's own label", () => {
		expect(credentialSourceLabel({ configured: true, source: "models_json_key" })).toBe("models.json");
		expect(credentialSourceLabel({ configured: true, source: "stored" })).toBe("saved credential");
		expect(credentialSourceLabel({ configured: true, source: "environment", label: "OPENAI_API_KEY" })).toBe(
			"OPENAI_API_KEY",
		);
	});
});

function modelsTool(available: ModelRef[] = refs) {
	let tool: ToolDefinition | undefined;
	registerModelsTool(
		{ registerTool: (definition: ToolDefinition) => void (tool = definition) } as never,
		() => new Map(),
	);
	return async (input: Record<string, unknown>) => {
		const result = await tool!.execute("c", input, undefined, undefined, {
			model: sessionModel,
			thinkingLevel: "low",
			modelRegistry: {
				...meteredBilling,
				getProviderKind: () => "API key",
				getAvailable: () => available,
				getAll: () => available,
				find: () => undefined,
				getProviderAuthStatus: (provider: string) => ({
					configured: true,
					source: provider === "openai" ? "models_json_key" : "stored",
				}),
			},
		} as never);
		return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
	};
}

describe("models tool listings", () => {
	let saved: string | undefined;
	beforeEach(() => {
		saved = process.env[MODELS_DEV_ENV];
		process.env[MODELS_DEV_ENV] = "0";
	});
	afterEach(() => {
		if (saved === undefined) delete process.env[MODELS_DEV_ENV];
		else process.env[MODELS_DEV_ENV] = saved;
	});

	it("without a filter gives one row per provider with credential labels and counts, and no model rows", async () => {
		const text = await modelsTool()({});
		expect(text).toContain("  openai · API key · models.json · 2 runnable of 3 · cheapest openai/gpt-5-mini");
		expect(text).toContain("highest priced openai/gpt-5");
		expect(text).not.toContain("most capable");
		expect(text).toContain("  opencode-go · API key · saved credential · 1 runnable · priced opencode-go/qwen-coder");
		expect(text).not.toMatch(/per M in\/out · \d+k/);
		expect(text).not.toContain("Models this session can use");
		expect(text).toContain("Set `provider` to list one provider's models.");
		expect(text).toContain("Subagent purposes:");
		expect(text.length).toBeLessThan(3_000);
	});

	it("lists a provider's runnable models, then those that cannot run a task under their own heading", async () => {
		const text = await modelsTool()({ provider: "openai" });
		const [runnable, other] = text.split("Cannot run a task");
		expect(runnable).toMatch(/openai\/gpt-5-mini · /);
		expect(runnable).not.toContain("openai/gpt-4 ");
		expect(other).toMatch(/openai\/gpt-4 · .* · context 8\.2k \(needs 100k\)/);
		expect(text).not.toContain("qwen-coder");
		expect(text).toContain("append :off, :minimal, :low, :medium, :high, :xhigh or :max to set its thinking");
	});

	it("lists a short filter in full and summarizes one that keeps more than 40 models", async () => {
		const many = Array.from({ length: 45 }, (_, index) => m("gateway", `model-${index}`, 1, 2));
		const tool = modelsTool([...refs, ...many]);
		expect(await tool({ query: "gpt-5" })).toContain("openai/gpt-5-mini · ");
		const text = await tool({ query: "model-" });
		expect(text).toContain("45 models match; too many to list.");
		expect(text).toContain("gateway · API key · saved credential · 45 runnable · 45 match");
		expect(text).toContain("openai · API key · models.json · 2 runnable of 3 · 0 match");
		expect(text).not.toMatch(/gateway\/model-1 · /);
	});
});
