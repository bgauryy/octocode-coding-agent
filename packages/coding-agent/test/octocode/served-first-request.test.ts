import { beforeAll, describe, expect, it } from "vitest";
import { type AgentContext, captureAll } from "./agent-context/capture.ts";
import { type Layers, measureLayers } from "./agent-context/layers.ts";

/*
 * The size of each agent's first request as a user's home serves it: FreeLlama on, the research tools declared as a
 * workspace that uses them declares them, no mid-conversation tool changes (`agent-context/served.ts`). The prompt-size
 * ceilings measure a fixture that leaves these out. Each ceiling is the measured size plus 5%; lower one when a layer
 * shrinks, and raise one only for an intended change a reviewer can weigh against its cost on every request.
 */
const CEILINGS: Record<string, Omit<Layers, "freellama">> = {
	// skills: the octocode-code-review core skill (user request) measured 7,905.
	main: {
		system: 23_300,
		mcpInstructions: 9_700,
		skills: 8_300,
		nativeTools: 18_650,
		mcpTools: 64_550,
		total: 124_000,
	},
	general: {
		system: 20_850,
		mcpInstructions: 4_900,
		skills: 2_850,
		nativeTools: 10_350,
		mcpTools: 51_150,
		total: 90_000,
	},
	researcher: {
		system: 18_100,
		mcpInstructions: 4_900,
		skills: 1_550,
		nativeTools: 10_350,
		mcpTools: 51_150,
		total: 86_000,
	},
	// Octocode MCP declares every tool by default (gh, clone, package, security): mcpTools measured 49,101, total 86,650.
	implementer: {
		system: 21_250,
		mcpInstructions: 4_900,
		skills: 2_850,
		nativeTools: 10_350,
		mcpTools: 50_050,
		total: 88_350,
	},
	// Octocode MCP declares every tool by default (gh, clone, package, security): mcpTools measured 49,101, total 83,311.
	// skills: octocode-code-review in the reviewer's catalog (its working method) measured 1,560.
	reviewer: {
		system: 19_300,
		mcpInstructions: 4_900,
		skills: 1_640,
		nativeTools: 10_350,
		mcpTools: 50_050,
		total: 84_950,
	},
};

describe("served first request", () => {
	let contexts: AgentContext[] = [];
	beforeAll(async () => {
		contexts = await captureAll(undefined, true);
	}, 600_000);
	const layersOf = (name: string): Layers => measureLayers(contexts.find((context) => context.name === name)!);

	it.each(Object.keys(CEILINGS))("%s stays under its per-layer ceilings", (name) => {
		const layers = layersOf(name);
		console.log(`LAYERS ${name} ${JSON.stringify(layers)}`);
		for (const [layer, ceiling] of Object.entries(CEILINGS[name]))
			expect(layers[layer as keyof Layers], `${name} ${layer}`).toBeLessThanOrEqual(ceiling);
	});

	it("serves FreeLlama to the main session and to no child", () => {
		expect(layersOf("main").freellama).toBeGreaterThan(0);
		for (const name of ["general", "researcher", "implementer", "reviewer"])
			expect(layersOf(name).freellama, `${name} FreeLlama bytes`).toBe(0);
	});
});
