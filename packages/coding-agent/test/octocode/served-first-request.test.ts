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
	main: {
		system: 23_700,
		mcpInstructions: 9_800,
		skills: 8_800,
		nativeTools: 20_900,
		mcpTools: 65_600,
		total: 128_700,
	},
	general: {
		system: 20_900,
		mcpInstructions: 4_950,
		skills: 3_050,
		nativeTools: 12_000,
		mcpTools: 52_200,
		total: 93_050,
	},
	researcher: {
		system: 18_100,
		mcpInstructions: 4_950,
		skills: 1_650,
		nativeTools: 12_000,
		mcpTools: 52_200,
		total: 88_850,
	},
	implementer: {
		system: 21_300,
		mcpInstructions: 4_950,
		skills: 3_050,
		nativeTools: 12_000,
		mcpTools: 44_450,
		total: 85_700,
	},
	reviewer: {
		system: 19_300,
		mcpInstructions: 4_950,
		skills: 1_450,
		nativeTools: 12_000,
		mcpTools: 44_450,
		total: 82_050,
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
