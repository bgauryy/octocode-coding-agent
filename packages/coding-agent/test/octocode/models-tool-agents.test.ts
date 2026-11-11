import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolDefinition } from "../../src/core/features/index.ts";
import { MODELS_DEV_ENV } from "../../src/octocode/subagents/catalog.ts";
import type { ModelRef } from "../../src/octocode/subagents/model.ts";
import { externalListing } from "../../src/octocode/external/describe.ts";
import { registerModelsTool } from "../../src/octocode/subagents/models-tool.ts";
import { meteredBilling } from "./fake-host.ts";

const refs: ModelRef[] = [
	{ provider: "openai", id: "gpt-5", cost: { input: 5, output: 25 }, contextWindow: 200_000 },
	{ provider: "gateway", id: "qwen", cost: { input: 1, output: 2 }, contextWindow: 200_000 },
];

function run(input: Record<string, unknown>, external?: { call: (value: unknown) => Promise<unknown> }, kinds = {}) {
	let tool: ToolDefinition | undefined;
	registerModelsTool(
		{ registerTool: (definition: ToolDefinition) => void (tool = definition) } as never,
		() => new Map(),
		// `octocode/index.ts` composes the external listing; the models tool imports nothing of `external/`.
		(ctx) => externalListing(external, ctx),
	);
	return tool!
		.execute("c", input, undefined, undefined, {
			model: refs[0],
			modelRegistry: {
				...meteredBilling,
				getAvailable: () => refs,
				getAll: () => refs,
				find: () => undefined,
				getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
				...kinds,
			},
		} as never)
		.then((result) => result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"));
}

describe("models tool agents and credentials", () => {
	let saved: string | undefined;
	beforeEach(() => {
		saved = process.env[MODELS_DEV_ENV];
		process.env[MODELS_DEV_ENV] = "0";
	});
	afterEach(() => {
		if (saved === undefined) delete process.env[MODELS_DEV_ENV];
		else process.env[MODELS_DEV_ENV] = saved;
	});

	it("lists connected and installed external agents when they are enabled", async () => {
		const external = {
			call: async (value: unknown) => {
				expect(value).toEqual({ action: "list" });
				return {
					connections: [{ id: "c1", transport: "acp", vendor: "claude", busy: false }],
					acpAgents: [{ vendor: "codex", command: "codex-acp" }],
				};
			},
		};
		const text = await run({}, external);
		expect(text).toContain("Connected external agents");
		expect(text).toContain("claude");
		expect(text).toContain("Installed ACP agents");
	});

	it("says nothing about external agents when disabled or when discovery fails", async () => {
		expect(await run({})).not.toContain("external agents");
		const failing = {
			call: async () => {
				throw new Error("boom");
			},
		};
		expect(await run({}, failing)).not.toContain("external agents");
	});

	it("names every listed provider's kind, asking the registry once per provider", async () => {
		const asked: string[] = [];
		const getProviderKind = (provider: string) => {
			asked.push(provider);
			return provider === "openai" ? "subscription" : "API key";
		};
		const text = await run({}, undefined, { getProviderKind });
		expect(asked.sort()).toEqual(["gateway", "openai"]);
		expect(text).toContain("\n  openai · subscription · saved credential");
		expect(text).toContain("\n  gateway · API key · saved credential");
	});
});
