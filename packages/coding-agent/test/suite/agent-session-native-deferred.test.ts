import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionFactory } from "../../src/core/extensions/types.ts";
import { createToolSearchExtension } from "../../src/core/tools/tool-search.ts";
import { createHarness, type Harness } from "./harness.ts";

const nativeTool = (name: string, exposure: "deferred" | "direct"): ExtensionFactory => {
	return (pi: ExtensionAPI) =>
		pi.registerTool({
			name,
			label: name,
			description: `${name} builds a dependency graph snapshot of the workspace.`,
			parameters: Type.Object({}),
			exposure,
			execute: async () => ({ content: [{ type: "text", text: "built" }], details: {} }),
		});
};

describe("deferred native tools without any MCP server", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function session(factories: ExtensionFactory[]) {
		const harness = await createHarness({ extensionFactories: [...factories, createToolSearchExtension()] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		return harness;
	}

	it("activates tool_search, which loads the deferred tool so the next call can use it", async () => {
		const harness = await session([nativeTool("graphBuild", "deferred")]);
		expect(harness.session.getActiveToolNames()).toContain("tool_search");
		expect(harness.session.getActiveToolNames()).not.toContain("graphBuild");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("tool_search", { query: "graphBuild" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("graphBuild", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("load it");
		expect(harness.session.getActiveToolNames()).toContain("graphBuild");
		const results = harness.sessionManager
			.getBranch()
			.flatMap((entry) => (entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []));
		expect(results.map((result) => [result.toolName, result.isError])).toEqual([
			["tool_search", false],
			["graphBuild", false],
		]);
	});

	it("does not add tool_search when every native tool is direct", async () => {
		const harness = await session([nativeTool("plain", "direct")]);
		expect(harness.session.getActiveToolNames()).not.toContain("tool_search");
	});
});
