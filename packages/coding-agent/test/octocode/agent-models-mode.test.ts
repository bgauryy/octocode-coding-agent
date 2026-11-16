import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "../../src/core/features/index.ts";
import { MODELS_DEV_ENV } from "../../src/octocode/subagents/catalog.ts";
import type { ModelRef } from "../../src/octocode/subagents/model.ts";
import { registerModelsTool } from "../../src/octocode/subagents/models-tool.ts";
import { meteredBilling } from "./fake-host.ts";

// The native `models` tool, formerly `agent` type `models`; the file keeps its old name.

const m = (provider: string, id: string, input: number, output: number): ModelRef => ({
	provider,
	id,
	cost: { input, output },
	contextWindow: 200_000,
});
const opus = m("anthropic", "claude-opus", 5, 25);
const haiku = { ...m("anthropic", "claude-haiku", 1, 5), input: ["text", "image"] } as ModelRef;
const zen = m("opencode", "qwen-coder", 0.5, 2);

function mode(profiles = new Map()) {
	let tool: ToolDefinition | undefined;
	const api = { registerTool: (definition: ToolDefinition) => void (tool = definition) };
	registerModelsTool(api as never, () => profiles);
	if (!tool) throw new Error("not registered");
	const streamSimple = vi.fn((model: ModelRef) => ({
		result: async () =>
			model.provider === "opencode"
				? { stopReason: "error", errorMessage: "401 api_key_expired" }
				: { stopReason: "stop" },
	}));
	const catalog = [opus, haiku, zen, m("google", "gemini-3.1-pro", 2, 12)];
	const run = async (
		input: Record<string, unknown>,
		available = [opus, haiku, zen],
		kinds?: Record<string, string>,
	) => {
		const result = await tool!.execute("call-1", input, undefined, undefined, {
			model: { ...opus, contextWindow: 180_000 },
			thinkingLevel: "high",
			modelRegistry: {
				...meteredBilling,
				getAvailable: () => available,
				streamSimple,
				getAll: () => catalog,
				find: (provider: string, id: string) => catalog.find((e) => e.provider === provider && e.id === id),
				...(kinds ? { getProviderKind: (provider: string) => kinds[provider] ?? "API key" } : {}),
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

describe("models tool", () => {
	it("registers as the native models tool with its filters", () => {
		const { tool } = mode();
		expect(tool.name).toBe("models");
		expect(Object.keys((tool.parameters as { properties: object }).properties)).toEqual([
			"routes",
			"provider",
			"ability",
			"query",
			"check",
			"scope",
		]);
	});

	it("opens with this session's model, thinking level and context budget against capacity", async () => {
		const { run } = mode();
		const text = await run({});
		expect(text.split("\n")[0]).toBe(
			"This session: anthropic/claude-opus · thinking high · context budget 180k of 200k capacity.",
		);
		expect(text).toContain("\nanthropic/claude-haiku · $1/$5 · 200k · tools, images · ?");
		expect(text).toContain("\nopencode/qwen-coder · $0.50/$2 · 200k · tools · ?");
	});

	it("names each provider's kind on its row", async () => {
		const { run } = mode();
		const text = await run({ query: "/" }, undefined, { anthropic: "subscription" });
		expect(text).toContain("\n  anthropic · subscription · saved credential");
		expect(text).toContain("\n  opencode · --api-key, this session only (tasks cannot use it)");
		const keyed = await run({ query: "/" }, undefined, { anthropic: "API key" });
		expect(keyed).toContain("\n  anthropic · API key · saved credential");
		expect(await run({ query: "/" }, undefined, { anthropic: "local" })).toContain(
			"\n  anthropic · local · saved credential",
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
		expect(text).toMatch(/^anthropic\/claude-haiku · .* · ✓$/m);
		expect(text).toMatch(/^anthropic\/claude-opus · .* · ✓$/m);
		expect(text).toMatch(/^opencode\/qwen-coder · .* · ✗$/m);
		const details = await run({ provider: "opencode" });
		expect(details.match(/credential refused/g)).toHaveLength(1);
		expect(details).toContain("401 api_key_expired — fix with /providers");
	});

	it("lists one provider's models with the ids `model` accepts, the purposes and the profiles", async () => {
		const text = await mode(new Map([["researcher", { name: "researcher", model: "small" }]])).run({
			provider: "anthropic",
		});
		for (const id of ["anthropic/claude-opus", "anthropic/claude-haiku"]) expect(text).toContain(id);
		expect(text).not.toContain("opencode/qwen-coder");
		expect(text).toMatch(/^● anthropic\/claude-opus/m);
		expect(text).toContain("small: ");
		expect(text).toContain("researcher: ");
		expect(text).toContain('Pass one as `model` ("provider/id") when you start a task');
	});

	it("filters the rows by provider, ability and query while the routes still cover every model", async () => {
		const { run } = mode();
		const byQuery = await run({ query: "opencode" });
		expect(byQuery).toContain("opencode/qwen-coder");
		expect(byQuery).not.toMatch(/claude-haiku ·/);
		expect(byQuery).toContain("Subagent purposes:");
		const byProvider = await run({ provider: "OpenCode" });
		expect(byProvider).toMatch(/qwen-coder ·/);
		expect(byProvider).not.toMatch(/^● anthropic\/claude-opus/m);
		const byAbility = await run({ ability: "images" });
		expect(byAbility).toMatch(/anthropic\/claude-haiku · .*images/);
		expect(byAbility).not.toMatch(/qwen-coder ·/);
		expect(await run({ query: "opus", ability: "images" })).toContain("No model matches the filters; 3 without them.");
	});
});
