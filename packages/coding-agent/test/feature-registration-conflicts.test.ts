import { createEventBus } from "@octocodeai/octocode-agent-core";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { detectFeatureConflicts } from "../src/core/features/conflicts.ts";
import type { ExtensionAPI } from "../src/core/features/types.ts";
import type { PathMetadata } from "../src/core/package-manager.ts";
import { ignoredExtensionWarnings } from "../src/core/resource-loader/feature-loading.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "./helpers/features.ts";

const tool = (name: string) => ({
	name,
	label: name,
	description: "Test tool",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
});

async function register(path: string, owner: "native" | "builtin", setup: (api: ExtensionAPI) => void) {
	return loadExtensionFromFactory(setup, process.cwd(), createEventBus(), createExtensionRuntime(), path, owner);
}

describe("feature registration: duplicate ids", () => {
	it("names both owners when two features register the same tool, and the first keeps the name", async () => {
		const native = await register("<inline:octocode>", "native", (api) => api.registerTool(tool("shared")));
		const builtin = await register("builtin:mcp", "builtin", (api) => api.registerTool(tool("shared")));

		const conflicts = detectFeatureConflicts([native, builtin]);

		expect(conflicts).toEqual([
			{
				path: "builtin:mcp",
				message: 'Tool "shared" registered by builtin:mcp (builtin) conflicts with <inline:octocode> (native)',
			},
		]);
	});

	it("reports a duplicate flag the same way", async () => {
		const flag = (api: ExtensionAPI) => api.registerFlag("mode-x", { type: "boolean", description: "x" });
		const first = await register("builtin:llama.cpp", "builtin", flag);
		const second = await register("builtin:mcp", "builtin", flag);

		expect(detectFeatureConflicts([first, second]).map((conflict) => conflict.message)).toEqual([
			'Flag "--mode-x" registered by builtin:mcp (builtin) conflicts with builtin:llama.cpp (builtin)',
		]);
	});

	it("does not report distinct names", async () => {
		const a = await register("<inline:octocode>", "native", (api) => api.registerTool(tool("a")));
		const b = await register("builtin:mcp", "builtin", (api) => api.registerTool(tool("b")));

		expect(detectFeatureConflicts([a, b])).toEqual([]);
	});
});

describe("ignored extension entries", () => {
	it("warns for code entries, naming the shipping package, and not for builtin switches", () => {
		const metadata = new Map<string, PathMetadata>([
			["/pkg/index.ts", { source: "npm:pkg", scope: "user", origin: "package", packageRoot: "/pkg" }],
		]);

		const warnings = ignoredExtensionWarnings(["/pkg/index.ts", "/own/ext.ts", "builtin:mcp"], metadata);

		expect(warnings.map((warning) => warning.path)).toEqual(["/pkg/index.ts", "/own/ext.ts"]);
		expect(warnings[0]?.warning).toContain("shipped by package /pkg");
		expect(warnings[0]?.warning).toContain("PLUGINS.md");
		expect(warnings[1]?.warning).not.toContain("shipped by package");
	});
});
