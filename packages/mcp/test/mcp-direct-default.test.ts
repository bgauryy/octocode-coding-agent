import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../coding-agent/src/core/extensions/types.ts";
import type { McpServerEntry } from "../src/config.ts";
import { octocodePreset } from "../src/presets/octocode/index.ts";
import { McpExtensionState } from "../src/state.ts";

function catalog(name: string, config: Pick<McpServerEntry["config"], "exposure" | "toolExposure"> = {}) {
	const state = new McpExtensionState({ events: { on: () => () => {} } } as unknown as ExtensionAPI, {
		presets: [octocodePreset(() => [], {})],
	});
	const entry: McpServerEntry = { name, config: { command: "fixture", ...config }, source: "test" };
	const tools = Array.from({ length: 40 }, (_, index) => ({
		name: index === 0 ? "localFetch" : `tool${index}`,
		description: "Read the selected record. ".repeat(20),
		inputSchema: { type: "object" as const, properties: { id: { type: "string" } } },
	}));
	state.servers = [{ entry, connection: { tools, state: "connected" } } as unknown as (typeof state.servers)[number]];
	return { state, entry, tools };
}

describe("direct MCP defaults", () => {
	it.each(["octocode", "docs"])("declares the complete %s catalog, however large", (name) => {
		const { state, entry, tools } = catalog(name);
		for (const tool of tools) expect(state.toolExposure(entry, tool.name)).toBe("direct");
	});

	it("retains explicit hidden exposure", () => {
		const { state, entry, tools } = catalog("octocode", { exposure: "hidden" });
		for (const tool of tools) expect(state.toolExposure(entry, tool.name)).toBe("hidden");
	});

	it("preserves exact and pattern tool controls over direct defaults", () => {
		const { state, entry } = catalog("octocode", {
			toolExposure: { "tool*": "hidden", tool1: "direct" },
		});
		expect(state.toolExposure(entry, "tool1")).toBe("direct");
		expect(state.toolExposure(entry, "tool2")).toBe("hidden");
		expect(state.toolExposure(entry, "localFetch")).toBe("direct");
	});
});
