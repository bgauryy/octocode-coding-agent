import { describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../coding-agent/src/core/features/types.ts";
import { createMcpManageTool, type McpManageOperations } from "../src/manage-tool.ts";
import { residentBlock } from "../src/presentation/deferred.ts";
import { builtinPresets } from "../src/presets/index.ts";

/**
 * A preset with `instructionsOnDemand` (FreeLlama) keeps its server's instructions out of a block that declares none of
 * its tools; the `mcp` tool's first read of one of its tools carries them instead.
 */
describe("instructions on demand", () => {
	const block = (instructionsOnDemand: boolean, offered: string[] = []) =>
		residentBlock({
			offered,
			deferral: { deferred: new Set(offered), onDemand: new Set(["run_task"]), instructionsOnDemand },
			spent: 0,
			contractOf: () => ({ file: undefined, text: "" }),
			indexLine: (tool) => `- ${tool}`,
			onDemandLine: (tool) => `- ${tool}: Run a task on a local model.`,
			instructionsOf: () => "Pick a model that fits this machine before running a task.",
		}).text;

	it("lists only the triggers while no tool is declared, and keeps the instructions once one is", () => {
		expect(block(true)).toBe("- run_task: Run a task on a local model.");
		expect(block(false)).toContain("Pick a model");
		expect(block(true, ["models"])).toContain("Pick a model");
	});

	it("is set for FreeLlama, the browser and the desktop, and not for the research server", () => {
		const presets = builtinPresets({ OCTOCODE_MCP_FREELLAMA: "1" });
		expect(presets.filter((preset) => preset.instructionsOnDemand).map(({ name }) => name)).toEqual([
			"freellama",
			"browser",
			"desktop",
		]);
		expect(presets.find(({ name }) => name === "freellama")?.config?.exposure).toBe("onDemand");
	});

	it("sends the instructions with the first one-tool read of a server whose prompt block lacks them", async () => {
		const operations: McpManageOperations = {
			servers: () => [{ name: "freellama", state: "connected · 1 tool", connected: true }],
			tools: () => [
				{
					name: "run_task",
					description: "Run a task.",
					inputSchema: { type: "object" },
					exposure: "onDemand" as const,
				},
			],
			instructions: () => "Pick a model that fits this machine before running a task.",
			instructionsInPrompt: () => false,
			restart: vi.fn(async () => undefined),
			stop: vi.fn(async () => undefined),
		};
		const tool = createMcpManageTool(operations);
		const read = async () =>
			(
				(
					await tool.execute(
						"call",
						{ intent: "tools", server: "freellama", tool: "run_task" } as never,
						new AbortController().signal,
						undefined,
						{ hasUI: false } as unknown as ToolContext,
					)
				).content[0] as { text: string }
			).text;
		const first = await read();
		expect(first).toMatch(/^Instructions:\nPick a model/);
		expect(first).toContain("run_task [onDemand] — Run a task.");
		expect(await read()).not.toContain("Pick a model");
	});
});
