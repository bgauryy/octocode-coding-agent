import { beforeAll, describe, expect, it } from "vitest";
import { type AgentContext, captureAll } from "./agent-context/capture.ts";
import { type Layers, measureLayers } from "./agent-context/layers.ts";

/*
 * The size of each agent's first request as a warm user's home serves it: FreeLlama on, the research tools and the
 * native tools a main session uses most declared as a workspace that uses them declares them (a child takes its
 * coordinator's set less the role-dependent native tools), no mid-conversation tool changes (`agent-context/served.ts`).
 * The `mcpTools` layer is every declared schema of the MCP presets this repository owns (octocode-mcp, FreeLlama, the
 * browser server). `prompt-size.test.ts` measures the same agents on a fresh install, with nothing promoted. Each
 * ceiling is the measured size plus 5%; lower one when a layer shrinks, and raise one only for an intended change a
 * reviewer can weigh against its cost on every request.
 */
/**
 * A child's native tools (bash, file, web, mcp, wait, archive, memory, agent, skill), measured 10,380 bytes. Raised from
 * 10,350 for intended text a reviewer can weigh: the file tool's `fromAttachment` field (about 105 bytes; a teammate's
 * attachment no longer comes back as up to 64 KiB of model output), the wait tool's free and paid checks (77), the
 * `mcp` tool's restart rule (18), the memory line's form (14) and the bash thresholds named as defaults (11).
 */
const CHILD_NATIVE_TOOLS = 10_900;

const CEILINGS: Record<string, Omit<Layers, "freellama">> = {
	// skills: the octocode-code-review core skill (user request) measured 7,905.
	main: {
		system: 23_300,
		mcpInstructions: 9_700,
		skills: 8_300,
		// Thin declarations carry each field's allowed values, item bounds and required fields.
		nativeTools: 19_600,
		mcpTools: 64_550,
		total: 124_000,
	},
	general: {
		system: 20_750,
		mcpInstructions: 4_900,
		skills: 2_800,
		nativeTools: CHILD_NATIVE_TOOLS,
		mcpTools: 27_950,
		total: 67_300,
	},
	researcher: {
		system: 17_950,
		mcpInstructions: 4_900,
		skills: 1_550,
		nativeTools: CHILD_NATIVE_TOOLS,
		mcpTools: 27_950,
		total: 63_200,
	},
	// Octocode MCP declares every tool by default (gh, clone, package, security): mcpTools measured 49,101, total 86,650.
	implementer: {
		system: 21_100,
		mcpInstructions: 4_900,
		skills: 2_850,
		nativeTools: CHILD_NATIVE_TOOLS,
		mcpTools: 50_050,
		total: 88_350,
	},
	// Octocode MCP declares every tool by default (gh, clone, package, security): mcpTools measured 49,101, total 83,311.
	// skills: octocode-code-review in the reviewer's catalog (its working method) measured 1,560.
	reviewer: {
		system: 19_150,
		mcpInstructions: 4_900,
		skills: 1_640,
		nativeTools: CHILD_NATIVE_TOOLS,
		mcpTools: 50_050,
		total: 84_950,
	},
	browser: {
		system: 19_550,
		mcpInstructions: 6_300,
		skills: 300,
		nativeTools: 10_800,
		mcpTools: 31_550,
		total: 68_400,
	},
	// No MCP server and no skill catalog.
	lean: {
		system: 13_650,
		mcpInstructions: 0,
		skills: 0,
		nativeTools: 6_550,
		mcpTools: 0,
		total: 20_150,
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
		for (const name of ["general", "researcher", "implementer", "reviewer", "browser", "lean"])
			expect(layersOf(name).freellama, `${name} FreeLlama bytes`).toBe(0);
	});

	it("declares no FreeLlama tool and no planning tool to any child", () => {
		const freellama = (names: readonly string[]) => names.filter((name) => name.startsWith("mcp__freellama__"));
		const main = contexts.find((context) => context.name === "main")!;
		// Not vacuous: the main session has the server's tools, declared or waiting for a first call.
		expect(freellama([...main.tools, ...(main.deferred ?? [])].map((tool) => tool.name)).length).toBeGreaterThan(0);
		for (const child of contexts.filter((context) => context.kind === "child")) {
			const declared = child.tools.map((tool) => tool.name);
			expect(freellama(declared), `${child.name} FreeLlama tools`).toEqual([]);
			expect(declared, child.name).not.toContain("backlogPlan");
		}
	});

	it("declares a child's role-dependent native tools thin or not at all, whatever its coordinator's in-use set names", () => {
		const children = contexts.filter((context) => context.kind === "child" && context.name !== "lean");
		for (const child of children)
			for (const tool of ["memory", "archive", "models"]) {
				const declared = child.tools.some((each) => each.name === tool);
				const thin = child.deferred?.some((each) => each.name === tool && each.state === "deferred");
				expect(!declared || thin, `${child.name} declares ${tool} in full`).toBe(true);
			}
		// The shared prefix stays as the coordinator declares it.
		const wait = (name: string) =>
			JSON.stringify(contexts.find((context) => context.name === name)!.tools.find((tool) => tool.name === "wait"));
		expect(wait("general")).toBe(wait("main"));
	});
});
