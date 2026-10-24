import type { Model } from "@octocodeai/octocode-ai";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { prefersDeferred, resolveMcpExposure } from "../src/extensions/mcp/exposure.ts";
import type { McpServer } from "../src/extensions/mcp/server.ts";
import { McpExtensionState } from "../src/extensions/mcp/state.ts";

type Compat = Record<string, boolean | undefined>;
const model = (compat: Compat = {}, api = "openai-responses") => ({ api, contextWindow: 1000, compat }) as Model<any>;
/** A transport with native tool loading: additions through the client tool search. */
const NATIVE: Compat = { supportsMidConvoSystemMessages: true, supportsToolSearch: true };
const small = [{ name: "read", inputSchema: { type: "object" as const } }];
const large = [{ ...small[0], description: "x".repeat(500) }];
const many = (count: number) => Array.from({ length: count }, () => small[0]);

describe("automatic MCP exposure", () => {
	it("budgets combined catalogs against input space after the output reserve", () => {
		const selected = { ...model(NATIVE), contextWindow: 1000, maxTokens: 500 };
		expect(resolveMcpExposure("auto", small, selected, true)).toBe("direct");
		expect(resolveMcpExposure("auto", [...small, ...small, ...small, ...small, ...small], selected, true)).toBe(
			"deferred",
		);
		expect(resolveMcpExposure("direct", large, selected, true)).toBe("direct");
	});
	it("uses direct calls for small catalogs even when deferred loading is supported", () => {
		expect(resolveMcpExposure("auto", small, model(NATIVE), true)).toBe("direct");
	});
	it.each([
		["openai-responses", { supportsMidConvoSystemMessages: true, supportsToolSearch: true }],
		["openai-responses", { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true }],
		["anthropic-messages", { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true }],
		["openai-completions", { supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: true }],
	])("defers large catalogs only with supported native loading: %s %j", (api, compat) => {
		expect(resolveMcpExposure("auto", large, model(compat, api), true)).toBe("deferred");
	});
	it("falls back to direct tools without native loading, discovery, or a selected model", () => {
		expect(resolveMcpExposure("auto", large, model(), true)).toBe("direct");
		expect(resolveMcpExposure("auto", large, model({ supportsAdditionalTools: true }), true)).toBe("direct");
		// Tool search without the mid-conversation system messages it anchors on is not native loading.
		expect(resolveMcpExposure("auto", large, model({ supportsToolSearch: true }), true)).toBe("direct");
		expect(resolveMcpExposure("auto", large, model(NATIVE), false)).toBe("direct");
		expect(resolveMcpExposure("auto", large, undefined, true)).toBe("direct");
	});
	it("defers more than 30 tools on native loading and keeps 30 direct", () => {
		const roomy = { ...model(NATIVE), contextWindow: 10_000_000 };
		expect(resolveMcpExposure("auto", many(30), roomy, true)).toBe("direct");
		expect(resolveMcpExposure("auto", many(31), roomy, true)).toBe("deferred");
	});
	it("keeps 31 small tools direct without native loading", () => {
		const roomy = { ...model(), contextWindow: 10_000_000 };
		expect(resolveMcpExposure("auto", many(31), roomy, true)).toBe("direct");
	});
	it.each(["direct", "deferred", "hidden"] as const)("preserves explicit %s exposure", (exposure) => {
		expect(resolveMcpExposure(exposure, large, model(), false)).toBe(exposure);
		expect(resolveMcpExposure(exposure, small, model(), true, true)).toBe(exposure);
	});
	it("defers a preferring server's tools on native loading, even for a small catalog", () => {
		expect(resolveMcpExposure("auto", small, model(NATIVE), true, true)).toBe("deferred");
		expect(resolveMcpExposure("auto", small, model(NATIVE), false, true)).toBe("direct");
	});
	it("declares a preferring server's tools directly without native loading unless the catalog is huge", () => {
		expect(resolveMcpExposure("auto", small, model(), true, true)).toBe("direct");
		expect(resolveMcpExposure("auto", small, undefined, true, true)).toBe("direct");
		// 500 bytes of schema is 125 estimated tokens: more than 10% of a 1000-token window.
		expect(resolveMcpExposure("auto", large, model(), true, true)).toBe("deferred");
		expect(resolveMcpExposure("auto", large, model(), false, true)).toBe("direct");
	});
	it("prefers discovery only for the octocode server without its own exposure", () => {
		expect(prefersDeferred("octocode", {})).toBe(true);
		expect(prefersDeferred("octocode", { exposure: "direct" })).toBe(false);
		expect(prefersDeferred("octocode", { exposure: "auto" })).toBe(false);
		expect(prefersDeferred("docs", {})).toBe(false);
	});
});

describe("automatic exposure across servers", () => {
	const tools = (count: number) =>
		Array.from({ length: count }, (_, index) => ({ name: `tool${index}`, inputSchema: { type: "object" as const } }));
	const server = (name: string, count: number): McpServer =>
		({
			entry: { name, config: { command: "x" }, source: "test" },
			connection: { tools: tools(count), state: "connected" },
		}) as unknown as McpServer;
	const selected = { ...model(NATIVE), contextWindow: 1000, maxTokens: 500 };

	const piWithSearch = () =>
		({
			getAllTools: () => [{ name: "tool_search", reachesTools: true }],
			events: { on: () => () => {} },
		}) as unknown as ExtensionAPI;

	it("decides a connecting server against the combined catalog, without flipping servers already decided", () => {
		const state = new McpExtensionState(piWithSearch(), {});
		state.selectedModel = selected;
		state.settleAutomaticExposure();
		const first = server("first", 1);
		state.servers = [first];
		const before = state.effectiveExposure(first.entry);
		expect(before).toBe("direct");

		// Together the catalogs reach the 10% window: the newcomer is deferred, `first` stays direct.
		const second = server("second", 6);
		state.servers = [first, second];
		expect(state.effectiveExposure(first.entry)).toBe(before);
		expect(state.effectiveExposure(second.entry)).toBe("deferred");
		expect(state.automaticCatalog("first")).toHaveLength(1);
		expect(state.automaticCatalog()).toHaveLength(7);

		state.servers = [first];
		expect(state.effectiveExposure(first.entry)).toBe(before);
	});

	it("decides small catalogs together when their combined declarations exceed the budget", () => {
		const state = new McpExtensionState(piWithSearch(), {});
		state.selectedModel = selected;
		state.settleAutomaticExposure();
		const [first, second] = [server("first", 3), server("second", 3)];
		state.servers = [first, second];
		expect(state.effectiveExposure(first.entry)).toBe("deferred");
		expect(state.effectiveExposure(second.entry)).toBe("deferred");
	});

	it("decides again when the model changes, but not when the same model is selected again", () => {
		const state = new McpExtensionState(piWithSearch(), {});
		state.selectedModel = selected;
		state.settleAutomaticExposure();
		const [first, second] = [server("first", 1), server("second", 4)];
		state.servers = [first];
		expect(state.effectiveExposure(first.entry)).toBe("direct");
		state.servers = [first, second];
		state.selectedModel = { ...selected };
		expect(state.effectiveExposure(first.entry)).toBe("direct");
		state.selectedModel = { ...selected, id: "other" };
		expect(state.effectiveExposure(first.entry)).toBe("deferred");
		expect(state.effectiveExposure(second.entry)).toBe("deferred");
	});

	it("decides a server again when its own tools change", () => {
		const state = new McpExtensionState(piWithSearch(), {});
		state.selectedModel = selected;
		state.settleAutomaticExposure();
		const first = server("first", 1);
		state.servers = [first];
		expect(state.effectiveExposure(first.entry)).toBe("direct");
		state.servers = [server("first", 6)];
		expect(state.effectiveExposure(first.entry)).toBe("deferred");
	});

	it("does not serialize the catalogs again for a decision it already made", () => {
		const state = new McpExtensionState(piWithSearch(), {});
		state.selectedModel = selected;
		state.settleAutomaticExposure();
		let serialized = 0;
		const counted = server("counted", 1);
		const [tool] = counted.connection!.tools;
		Object.defineProperty(tool, "toJSON", {
			value: () => {
				serialized++;
				return { name: tool.name };
			},
		});
		state.servers = [counted];
		state.effectiveExposure(counted.entry);
		const afterDecision = serialized;
		expect(afterDecision).toBeGreaterThan(0);
		for (let call = 0; call < 5; call++) state.effectiveExposure(counted.entry);
		expect(serialized).toBe(afterDecision);
	});

	describe("before the startup wait ends", () => {
		const decide = (order: string[]) => {
			const state = new McpExtensionState(piWithSearch(), {});
			state.selectedModel = selected;
			const all = new Map([server("alpha", 1), server("beta", 3), server("gamma", 3)].map((s) => [s.entry.name, s]));
			// Servers connect one by one, and the tools of each connected server are registered as it connects.
			const connected: McpServer[] = [];
			for (const name of order) {
				connected.push(all.get(name)!);
				state.servers = [...connected];
				for (const { entry } of connected) state.effectiveExposure(entry);
			}
			state.settleAutomaticExposure();
			return Object.fromEntries(
				[...all.keys()].sort().map((name) => [name, state.effectiveExposure(all.get(name)!.entry)]),
			);
		};

		it("gives the same decisions whichever server connects first", () => {
			const forward = decide(["alpha", "beta", "gamma"]);
			expect(decide(["gamma", "beta", "alpha"])).toEqual(forward);
			expect(decide(["beta", "alpha", "gamma"])).toEqual(forward);
			// The combined catalog (7 tools) exceeds the budget, so every server is deferred.
			expect(forward).toEqual({ alpha: "deferred", beta: "deferred", gamma: "deferred" });
		});

		it("does not stick: a server decided early is decided again against the settled catalog", () => {
			const state = new McpExtensionState(piWithSearch(), {});
			state.selectedModel = selected;
			const first = server("first", 1);
			state.servers = [first];
			expect(state.effectiveExposure(first.entry)).toBe("direct");
			state.servers = [first, server("second", 6)];
			expect(state.effectiveExposure(first.entry)).toBe("deferred");
		});

		it("sticks after the wait: a late server does not move the settled ones", () => {
			const state = new McpExtensionState(piWithSearch(), {});
			state.selectedModel = selected;
			const first = server("first", 1);
			state.servers = [first];
			state.settleAutomaticExposure();
			state.servers = [first, server("late", 6)];
			expect(state.effectiveExposure(first.entry)).toBe("direct");
			expect(state.effectiveExposure(state.servers[1].entry)).toBe("deferred");
		});

		it("is provisional again after a session start resets it", () => {
			const state = new McpExtensionState(piWithSearch(), {});
			state.selectedModel = selected;
			const first = server("first", 1);
			state.servers = [first];
			state.settleAutomaticExposure();
			state.resetAutomaticExposure();
			state.servers = [first, server("second", 6)];
			expect(state.effectiveExposure(first.entry)).toBe("deferred");
		});
	});
});
