import { createEventBus } from "@octocodeai/octocode-agent-core";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { detectFeatureConflicts } from "../src/core/features/conflicts.ts";
import type { FeatureSetup } from "../src/core/features/types.ts";
import { createFeatureRuntime, loadFeatureFromFactory } from "./helpers/features.ts";

const tool = (name: string) => ({
	name,
	label: name,
	description: "Test tool",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
});

async function register(path: string, owner: "native" | "builtin", setup: (api: FeatureSetup) => void) {
	return loadFeatureFromFactory(setup, process.cwd(), createEventBus(), createFeatureRuntime(), path, owner);
}

describe("feature registration: duplicate ids", () => {
	it("names both owners when two features register the same tool, and the first keeps the name", async () => {
		const native = await register("<inline:octocode>", "native", (api) => api.tools.register(tool("shared")));
		const builtin = await register("builtin:mcp", "builtin", (api) => api.tools.register(tool("shared")));

		const conflicts = detectFeatureConflicts([native, builtin]);

		expect(conflicts).toEqual([
			{
				path: "builtin:mcp",
				message: 'Tool "shared" registered by builtin:mcp (builtin) conflicts with <inline:octocode> (native)',
			},
		]);
	});

	it("does not report distinct names", async () => {
		const a = await register("<inline:octocode>", "native", (api) => api.tools.register(tool("a")));
		const b = await register("builtin:mcp", "builtin", (api) => api.tools.register(tool("b")));

		expect(detectFeatureConflicts([a, b])).toEqual([]);
	});
});
