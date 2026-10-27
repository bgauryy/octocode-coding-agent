import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../coding-agent/src/core/extensions/types.ts";
import type { McpServerEntry } from "../src/config.ts";
import { octocodePreset } from "../src/presets/octocode/index.ts";
import { McpExtensionState } from "../src/state.ts";

function catalog(name: string, config: Pick<McpServerEntry["config"], "exposure" | "toolExposure"> = {}) {
	const state = new McpExtensionState(
		{
			getAllTools: () => [{ name: "tool_search", reachesTools: true }],
			events: { on: () => () => {} },
		} as unknown as ExtensionAPI,
		{ presets: [octocodePreset(() => [], {})] },
	);
	state.selectedModel = {
		api: "openai-responses",
		contextWindow: 8000,
		maxTokens: 4000,
		compat: { supportsMidConvoSystemMessages: true, supportsToolSearch: true },
	} as typeof state.selectedModel;
	const entry: McpServerEntry = { name, config: { command: "fixture", ...config }, source: "test" };
	const tools = Array.from({ length: 40 }, (_, index) => ({
		name: index === 0 ? "localFetch" : `tool${index}`,
		description: "Read the selected record. ".repeat(20),
		inputSchema: { type: "object" as const, properties: { id: { type: "string" } } },
	}));
	state.servers = [{ entry, connection: { tools, state: "connected" } } as unknown as (typeof state.servers)[number]];
	state.settleAutomaticExposure();
	return { state, entry, tools };
}

describe("direct MCP defaults", () => {
	it.each(["octocode", "docs"])("declares the complete %s catalog even with discovery and a small window", (name) => {
		const { state, entry, tools } = catalog(name);
		expect(state.effectiveExposure(entry)).toBe("direct");
		for (const tool of tools) expect(state.effectiveExposure(entry, tool.name)).toBe("direct");
	});

	it.each(["auto", "deferred", "hidden"] as const)("retains explicit %s exposure", (exposure) => {
		const { state, entry, tools } = catalog("octocode", { exposure });
		for (const tool of tools)
			expect(state.effectiveExposure(entry, tool.name)).toBe(exposure === "auto" ? "deferred" : exposure);
	});

	it("preserves exact and pattern tool controls over direct defaults", () => {
		const { state, entry } = catalog("octocode", {
			toolExposure: { "tool*": "hidden", tool1: "direct", localFetch: "deferred" },
		});
		expect(state.effectiveExposure(entry, "tool1")).toBe("direct");
		expect(state.effectiveExposure(entry, "tool2")).toBe("hidden");
		expect(state.effectiveExposure(entry, "localFetch")).toBe("deferred");
	});
});
