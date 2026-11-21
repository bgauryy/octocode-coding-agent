import { describe, expect, it } from "vitest";
import { promptSource, renderPrompt } from "../../src/core/prompt-template.ts";
import { PolicyRenderError, renderPolicySection, SYSTEM_PROMPT_SECTIONS } from "../../src/core/system-prompt-spec.ts";
import { leanPromptSections } from "../../src/octocode/native/prompts/lean.ts";
import { octocodePromptSections } from "../../src/octocode/native/prompts/policy.ts";
import { FAKE_RESEARCH } from "./fake-research.ts";

/**
 * Every policy section template renders under every combination of the flags `turn.ts` passes. A template that names
 * a value the code does not pass throws at render time, and only for the branch that reads it, so one combination
 * rendered by hand does not show it.
 */
type Inputs = Parameters<typeof octocodePromptSections>[0];
const FLAGS = [
	"canDelegate",
	"canUseAgent",
	"canExternal",
	"readOnly",
	"canSave",
	"canShell",
	"canReadLocal",
	"canAsk",
	"canWeb",
	"canBacklog",
	"canMcp",
	"browserControl",
	"desktopControl",
	"childStarted",
] as const satisfies ReadonlyArray<keyof Inputs>;
const POLICY = SYSTEM_PROMPT_SECTIONS.filter((section) => section.group === "policy").map((section) => section.name);

describe("policy section templates", () => {
	it("render under every flag combination, with and without the research server, profiles and routing", () => {
		const routing = { sessionModel: "a/b", providers: [{ id: "a", count: 2 }], small: "a/s", medium: "no route found" };
		const extras: Array<Partial<Inputs>> = [
			{ research: undefined, profiles: [] },
			{
				research: FAKE_RESEARCH,
				profiles: [
					{ name: "reviewer", description: "Reviews.", model: "a/b" },
					{ name: "plain", description: "" },
				],
				routing,
				browserProfiles: ["browser"],
				desktopProfiles: ["desktop"],
				scratchDays: 0,
			},
		];
		let rendered = 0;
		for (let mask = 0; mask < 1 << FLAGS.length; mask++) {
			const flags = Object.fromEntries(FLAGS.map((flag, bit) => [flag, (mask & (1 << bit)) !== 0]));
			for (const extra of extras) {
				const input = { ...flags, ...extra } as Inputs;
				const sections = octocodePromptSections(input);
				expect(Object.keys(sections)).toEqual(POLICY);
				// No template leaves a marker behind, and every agent has the sections a prompt must not lack.
				for (const [name, text] of Object.entries(sections)) {
					if (text.includes("{{")) throw new Error(`${name} left a template marker for ${JSON.stringify(input)}`);
				}
				if (sections.work === "" || sections.communication === "")
					throw new Error(`work or communication is empty for ${JSON.stringify(input)}`);
				rendered++;
			}
		}
		expect(rendered).toBe(2 * 2 ** FLAGS.length);
		for (const scratchDays of [0, 1, 30])
			expect(
				octocodePromptSections({ research: undefined, profiles: [], canDelegate: false, scratchDays }).subagent,
			).not.toBe("");
	});

	it("tells the main agent when to delegate to the desktop specialist, only while one exists", () => {
		const base = { research: undefined, profiles: [], canDelegate: true, canUseAgent: true } as Inputs;
		const delegation = (desktopProfiles?: string[]) =>
			octocodePromptSections({ ...base, ...(desktopProfiles ? { desktopProfiles } : {}) }).delegation ?? "";
		expect(delegation()).not.toMatch(/desktop/i);
		const text = delegation(["desktop"]);
		expect(text).toContain("`desktop`");
		expect(text).toMatch(/native desktop app/);
		expect(text).toMatch(/user approves each start/);
		// How to brief it, and what to do with its answer: the other half of the exchange.
		expect(text).toMatch(/Brief it with one app, the goal, the state to start from and the proof you need/);
		expect(text).toMatch(/`blocked` report is a step only the user can take/);
		expect(text).toMatch(/`message` it to go on/);
		expect(text).toMatch(/never finish the task yourself with a shell or AppleScript/);
		expect(text).toMatch(/Check the screenshot path/);
		expect(text).toMatch(/browser/);
	});

	it("render the lean policy under every flag combination", () => {
		for (let mask = 0; mask < 16; mask++) {
			const [canShell, canSave, readOnly, agentTool] = [1, 2, 4, 8].map((bit) => (mask & bit) !== 0);
			const { lean } = leanPromptSections({ canShell, canSave, readOnly, agentTool });
			expect(lean).not.toContain("{{");
		}
	});

	it("has a chunk list of existing files for every section the map puts in the policy and lean groups", () => {
		for (const section of SYSTEM_PROMPT_SECTIONS.filter((section) => section.group !== undefined)) {
			expect(section.chunks?.length, section.name).toBeGreaterThan(0);
			for (const { file } of section.chunks ?? []) expect(promptSource(file), file).not.toBe("");
		}
	});

	it("names the section when a template does not render", () => {
		const failing = () =>
			renderPolicySection("safety", () => renderPrompt("shared/parent-waits.md", {}) + renderPrompt("no/such.md"));
		expect(failing).toThrow(PolicyRenderError);
		expect(failing).toThrow(/The `safety` prompt section failed to render \(Prompt template: no file no\/such\.md/);
		// A value the code does not pass: the renderer's error, wrapped the same way.
		expect(() => renderPolicySection("work", () => renderPrompt("policy/scratch.md", {}))).toThrow(
			/The `work` prompt section failed to render \(Prompt template: unknown name "keepsScratch"\)/,
		);
		expect(renderPolicySection("work", () => "text")).toBe("text");
	});
});
