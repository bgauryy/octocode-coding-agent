import { describe, expect, it } from "vitest";
import { CACHE_PROFILES, planCacheMarkers, type CacheLayout } from "../src/utils/cache-profiles.ts";

const total = (plan: ReturnType<typeof planCacheMarkers>) =>
	plan.blocks.filter(Boolean).length + (plan.tool ? 1 : 0) + plan.history;

interface Case {
	name: string;
	layout: Omit<CacheLayout, "historyTurns" | "instructions" | "history">;
	/** Expected `blocks` with two or more history turns, and with one. */
	two: ReturnType<typeof planCacheMarkers>;
	one: ReturnType<typeof planCacheMarkers>;
}

const CASES: Case[] = [
	{
		name: "tools + base only",
		layout: { instructionBlocks: 1, tools: 3, toolBoundary: true },
		two: { blocks: [true], tool: true, history: 2 },
		one: { blocks: [true], tool: true, history: 1 },
	},
	{
		name: "tools (no boundary) + base only",
		layout: { instructionBlocks: 1, tools: 3, toolBoundary: false },
		two: { blocks: [true], tool: true, history: 2 },
		one: { blocks: [true], tool: true, history: 1 },
	},
	{
		name: "tools + base + project_context: the shared base keeps its marker",
		layout: { instructionBlocks: 2, workspaceBlock: true, tools: 3, toolBoundary: true },
		two: { blocks: [true, false], tool: true, history: 2 },
		one: { blocks: [true, true], tool: true, history: 1 },
	},
	{
		name: "tools + base + session sections + project_context",
		layout: { instructionBlocks: 3, workspaceBlock: true, tools: 3, toolBoundary: true },
		two: { blocks: [false, true, false], tool: true, history: 2 },
		one: { blocks: [false, true, true], tool: true, history: 1 },
	},
	{
		name: "tools + base + session sections, no project_context",
		layout: { instructionBlocks: 2, tools: 3, toolBoundary: true },
		two: { blocks: [false, true], tool: true, history: 2 },
		one: { blocks: [false, true], tool: true, history: 1 },
	},
	{
		name: "no tools + base + project_context",
		layout: { instructionBlocks: 2, workspaceBlock: true, tools: 0, toolBoundary: false },
		two: { blocks: [true, true], tool: false, history: 2 },
		one: { blocks: [true, true], tool: false, history: 1 },
	},
	{
		name: "no tools + base + session sections + project_context",
		layout: { instructionBlocks: 3, workspaceBlock: true, tools: 0, toolBoundary: false },
		two: { blocks: [true, true, false], tool: false, history: 2 },
		one: { blocks: [true, true, true], tool: false, history: 1 },
	},
];

describe("planCacheMarkers layouts (Anthropic profile)", () => {
	for (const entry of CASES) {
		for (const turns of [1, 2, 5]) {
			it(`${entry.name}, ${turns} history turn(s)`, () => {
				const plan = planCacheMarkers(CACHE_PROFILES.anthropic, {
					...entry.layout,
					instructions: true,
					history: true,
					historyTurns: turns,
				});
				expect(plan).toEqual(turns === 1 ? entry.one : entry.two);
				expect(total(plan)).toBeLessThanOrEqual(CACHE_PROFILES.anthropic.maxMarkers);
				// The last shared block (the part every workspace has) always ends in a marker.
				const lastShared = entry.layout.instructionBlocks - (entry.layout.workspaceBlock ? 1 : 0) - 1;
				expect(plan.blocks[lastShared]).toBe(true);
			});
		}
	}
	it("a request with no history turns marks no history and gives the slot to the workspace block", () => {
		const plan = planCacheMarkers(CACHE_PROFILES.anthropic, {
			instructionBlocks: 3,
			workspaceBlock: true,
			tools: 3,
			toolBoundary: true,
			instructions: true,
			history: true,
			historyTurns: 0,
		});
		expect(plan).toEqual({ blocks: [false, true, true], tool: true, history: 0 });
	});
});
