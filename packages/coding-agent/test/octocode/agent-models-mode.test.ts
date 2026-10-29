import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "../../src/core/extensions/index.ts";
import { MODELS_DEV_ENV } from "../../src/octocode/subagents/catalog.ts";
import type { ModelRef } from "../../src/octocode/subagents/model.ts";
import { registerModels } from "../../src/octocode/subagents/models-command.ts";

const m = (provider: string, id: string, input: number, output: number): ModelRef => ({
	provider,
	id,
	cost: { input, output },
	contextWindow: 200_000,
});
const opus = m("anthropic", "claude-opus", 5, 25);
const haiku = m("anthropic", "claude-haiku", 1, 5);
const zen = m("opencode", "qwen-coder", 0.5, 2);

function mode(profiles = new Map()) {
	let tool: ToolDefinition | undefined;
	registerModels(
		{ add: () => {} } as never,
		() => profiles,
		(definition) => void (tool = definition as ToolDefinition),
	);
	if (!tool) throw new Error("not registered");
	const streamSimple = vi.fn((model: ModelRef) => ({
		result: async () =>
			model.provider === "opencode"
				? { stopReason: "error", errorMessage: "401 api_key_expired" }
				: { stopReason: "stop" },
	}));
	const catalog = [opus, haiku, zen, m("google", "gemini-3.1-pro", 2, 12)];
	const run = async (input: Record<string, unknown>, available = [opus, haiku, zen]) => {
		const result = await tool!.execute("call-1", input, undefined, undefined, {
			model: { ...opus, contextWindow: 180_000 },
			thinkingLevel: "high",
			modelRegistry: {
				getAvailable: () => available,
				streamSimple,
				getAll: () => catalog,
				find: (provider: string, id: string) => catalog.find((e) => e.provider === provider && e.id === id),
				getProviderAuthStatus: (provider: string) => ({
					configured: true,
					source: provider === "opencode" ? "runtime" : "stored",
				}),
			},
		} as never);
		return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
	};
	return { tool, run, streamSimple };
}

let saved: string | undefined;
beforeEach(() => {
	saved = process.env[MODELS_DEV_ENV];
	process.env[MODELS_DEV_ENV] = "0";
});
afterEach(() => {
	if (saved === undefined) delete process.env[MODELS_DEV_ENV];
	else process.env[MODELS_DEV_ENV] = saved;
});

describe("agent models mode", () => {
	it("registers as the agent tool's models mode with an optional query and check", () => {
		const { tool } = mode();
		expect(tool.name).toBe("agentModels");
		expect(Object.keys((tool.parameters as { properties: object }).properties)).toEqual(["query", "check", "scope"]);
	});

	it("opens with this session's model, thinking level and context budget against capacity", async () => {
		const { run } = mode();
		const text = await run({});
		expect(text.split("\n")[0]).toBe(
			"This session: anthropic/claude-opus · thinking high · context budget 180k of 200k capacity.",
		);
		expect(text).toContain(
			"Session only (--api-key; subagents do not receive it, so tasks cannot use them): opencode.",
		);
	});

	it("lists unconnected catalog models as not runnable only when asked for the catalog scope", async () => {
		const { run } = mode();
		expect(await run({})).not.toContain("google/gemini-3.1-pro");
		const text = await run({ scope: "catalog", query: "gemini" });
		expect(text).toContain("Not connected (not runnable");
		expect(text).toContain("google/gemini-3.1-pro");
	});

	it("checks one model per provider on request and marks each provider's credential", async () => {
		const { run, streamSimple } = mode();
		const plain = await run({});
		expect(streamSimple).not.toHaveBeenCalled();
		expect(plain).not.toContain("credential refused");
		const text = await run({ check: true });
		expect(streamSimple.mock.calls.map(([model]) => `${model.provider}/${model.id}`)).toEqual([
			"anthropic/claude-opus",
			"opencode/qwen-coder",
		]);
		expect(text).toMatch(/^anthropic: ✓ credential worked \(check, /m);
		expect(text).toMatch(/^opencode: ✗ credential refused \(check, .*401 api_key_expired — fix with \/login$/m);
	});

	it("lists every model the session can use with the ids `model` accepts, the purposes and the profiles", async () => {
		const text = await mode(new Map([["researcher", { name: "researcher", model: "small" }]])).run({});
		for (const id of ["anthropic/claude-opus", "anthropic/claude-haiku", "opencode/qwen-coder"])
			expect(text).toContain(id);
		expect(text).toMatch(/^● anthropic\/claude-opus/m);
		expect(text).toContain("small: ");
		expect(text).toContain("researcher: ");
		expect(text).toContain('Pass one as `model` ("provider/id") when you start a task');
	});

	it("narrows the list to models whose provider or id contains the query, keeping the purposes", async () => {
		const { run } = mode();
		const text = await run({ query: "opencode" });
		expect(text).toContain("opencode/qwen-coder");
		expect(text).not.toContain("anthropic/claude-haiku");
		expect(text).toContain("Subagent purposes:");
		expect(await run({ query: "nothing-like-this" })).toContain('No model matches "nothing-like-this"');
	});
});
