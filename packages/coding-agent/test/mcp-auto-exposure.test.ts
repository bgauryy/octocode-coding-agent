import type { Model } from "@octocodeai/octocode-ai";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { prefersDeferred, resolveMcpExposure } from "../src/extensions/mcp/exposure.ts";
import type { McpServer } from "../src/extensions/mcp/server.ts";
import { McpExtensionState } from "../src/extensions/mcp/state.ts";

const model = (compat: Record<string, boolean | undefined> = {}) => ({ contextWindow: 1000, compat }) as Model<any>;
const small = [{ name: "read", inputSchema: { type: "object" as const } }];
const large = [{ ...small[0], description: "x".repeat(500) }];

describe("automatic MCP exposure", () => {
	it("budgets combined catalogs against input space after the output reserve", () => {
		const selected = { ...model({ supportsToolSearch: true }), contextWindow: 1000, maxTokens: 500 };
		expect(resolveMcpExposure("auto", small, selected, true)).toBe("direct");
		expect(resolveMcpExposure("auto", [...small, ...small, ...small, ...small, ...small], selected, true)).toBe(
			"deferred",
		);
		expect(resolveMcpExposure("direct", large, selected, true)).toBe("direct");
	});
	it("uses direct calls for small catalogs even when deferred loading is supported", () => {
		expect(resolveMcpExposure("auto", small, model({ supportsToolSearch: true }), true)).toBe("direct");
	});
	it.each([
		{ supportsToolSearch: true },
		{ supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
		{ supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
	])("defers large catalogs only with supported native loading: %j", (compat) => {
		expect(resolveMcpExposure("auto", large, model(compat), true)).toBe("deferred");
	});
	it("falls back to direct tools without native loading, discovery, or a selected model", () => {
		expect(resolveMcpExposure("auto", large, model(), true)).toBe("direct");
		expect(resolveMcpExposure("auto", large, model({ supportsAdditionalTools: true }), true)).toBe("direct");
		expect(resolveMcpExposure("auto", large, model({ supportsToolSearch: true }), false)).toBe("direct");
		expect(resolveMcpExposure("auto", large, undefined, true)).toBe("direct");
	});
	it.each(["direct", "deferred", "hidden"] as const)("preserves explicit %s exposure", (exposure) => {
		expect(resolveMcpExposure(exposure, large, model(), false)).toBe(exposure);
		expect(resolveMcpExposure(exposure, small, model(), true, true)).toBe(exposure);
	});
	it("defers a preferring server's small catalog whenever discovery is available, with or without native loading", () => {
		expect(resolveMcpExposure("auto", small, model(), true, true)).toBe("deferred");
		expect(resolveMcpExposure("auto", small, undefined, true, true)).toBe("deferred");
		expect(resolveMcpExposure("auto", small, model({ supportsToolSearch: true }), false, true)).toBe("direct");
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
	const selected = { ...model({ supportsToolSearch: true }), contextWindow: 1000, maxTokens: 500 };

	const piWithSearch = () =>
		({
			getAllTools: () => [{ name: "tool_search", reachesTools: true }],
			events: { on: () => () => {} },
		}) as unknown as ExtensionAPI;

	it("decides a connecting server against the combined catalog, without flipping servers already decided", () => {
		const state = new McpExtensionState(piWithSearch(), {});
		state.selectedModel = selected;
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
		const [first, second] = [server("first", 3), server("second", 3)];
		state.servers = [first, second];
		expect(state.effectiveExposure(first.entry)).toBe("deferred");
		expect(state.effectiveExposure(second.entry)).toBe("deferred");
	});

	it("decides again when the model changes, but not when the same model is selected again", () => {
		const state = new McpExtensionState(piWithSearch(), {});
		state.selectedModel = selected;
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
		const first = server("first", 1);
		state.servers = [first];
		expect(state.effectiveExposure(first.entry)).toBe("direct");
		state.servers = [server("first", 6)];
		expect(state.effectiveExposure(first.entry)).toBe("deferred");
	});
});
