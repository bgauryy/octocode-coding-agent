import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolDefinition } from "../../src/core/features/index.ts";
import { MODELS_DEV_ENV } from "../../src/octocode/subagents/catalog.ts";
import type { ModelRef } from "../../src/octocode/subagents/model.ts";
import { runnerRows } from "../../src/octocode/external/connected.ts";
import type { RunnerState } from "../../src/octocode/external/runner-status.ts";
import { externalListing } from "../../src/octocode/external/describe.ts";
import { registerModelsTool } from "../../src/octocode/subagents/models-tool.ts";
import { meteredBilling } from "./fake-host.ts";

const refs: ModelRef[] = [
	{ provider: "openai", id: "gpt-5", cost: { input: 5, output: 25 }, contextWindow: 200_000 },
	{ provider: "gateway", id: "qwen", cost: { input: 1, output: 2 }, contextWindow: 200_000 },
];

function run(
	input: Record<string, unknown>,
	external?: { call: (value: unknown) => Promise<unknown> },
	kinds = {},
	runners: RunnerState[] = [],
) {
	let tool: ToolDefinition | undefined;
	registerModelsTool(
		{ registerTool: (definition: ToolDefinition) => void (tool = definition) } as never,
		() => new Map(),
		// `octocode/index.ts` composes the external listing; the models tool imports nothing of `external/`.
		async (ctx, _signal, filters) => [
			...runnerRows(runners, filters),
			...(await externalListing(external, ctx, filters)),
		],
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
		const text = await run({ provider: "openai" }, undefined, { getProviderKind });
		expect(asked.sort()).toEqual(["gateway", "openai"]);
		expect(text).toContain("\n  openai · subscription · saved credential");
		expect(text).toContain("\n  gateway · API key · saved credential");
	});
	it("lists only matching external runners even when no native model matches", async () => {
		const runners: RunnerState[] = ["opencode", "codex"].map((id) => ({
			id,
			name: id === "opencode" ? "OpenCode" : "Codex CLI",
			cli: true,
			adapter: true,
			auth: { signedIn: true },
		}));
		for (const filter of [{ query: "OpenCode" }, { provider: "opencode" }]) {
			const text = await run(filter, undefined, {}, runners);
			expect(text).toContain("Installed runners");
			expect(text).toContain("opencode · OpenCode");
			expect(text).not.toContain("codex ·");
			expect(text).not.toContain("No model matches");
		}
		const missing = await run({ query: "missing-runner" }, undefined, {}, runners);
		expect(missing).toContain("No model matches");
		const unknownAbility = await run({ query: "opencode", ability: "tools" }, undefined, {}, runners);
		expect(unknownAbility).toContain("No model matches");
		expect(unknownAbility).not.toContain("Installed runners");
	});

	it("filters structured external connections, instances and installed adapters", async () => {
		const external = {
			call: async () => ({
				connections: [
					{ id: "oc-1", vendor: "opencode", transport: "acp", model: "native-model" },
					{ id: "codex-1", vendor: "codex", transport: "acp" },
				],
				instances: [{ id: "other-session", name: "other" }],
				acpAgents: [
					{ vendor: "opencode", command: "opencode" },
					{ vendor: "codex", command: "codex-acp" },
				],
			}),
		};
		const text = await run({ provider: "opencode" }, external);
		expect(text).toContain("oc-1");
		expect(text).toContain("Installed ACP agents");
		expect(text).not.toContain("codex-1");
		expect(text).not.toContain("other-session");
		expect(text).not.toContain("codex-acp");
		const selected = await run({ query: "native-model" }, external);
		expect(selected).toContain("oc-1");
		expect(selected).not.toContain("Installed ACP agents");
	});
});
