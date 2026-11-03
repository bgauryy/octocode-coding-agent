import { renderMcpsSection } from "../../../mcp/src/section.ts";
import { getCurrentSystemPrompt, getSystemMessageText, type SystemMessage } from "@octocodeai/octocode-ai";
import { describe, expect, it } from "vitest";
import {
	buildSystemPrompt,
	buildSystemPromptSections,
	diffSystemPromptSections,
	normalizeBuildSystemPromptOptions,
} from "../../src/core/system-prompt.ts";
import { octocodePrompt, octocodePromptSections } from "../../src/octocode/instructions/policy.ts";
import { registerTurnSetup } from "../../src/octocode/turn.ts";
import { fakeHost } from "./fake-host.ts";

describe("native prompt section updates", () => {
	const input = {
		octocode: true,
		canDelegate: true,
		profiles: [{ name: "researcher", description: "Investigate a question." }],
	};
	const contracts = (instructions: string) => ({
		mcps: renderMcpsSection([
			{
				entry: { name: "octocode", source: "default", config: { command: "test" } },
				state: "connected",
				contract: instructions,
				declared: true,
			},
		])!,
	});
	const sections = (value = input, instructions = "Search and read.") =>
		buildSystemPromptSections({
			cwd: "/workspace",
			sections: octocodePromptSections(value),
			baseSections: instructions ? contracts(instructions) : {},
		});

	it("sends only the changed policy section and replays the complete prompt", () => {
		const before = sections();
		const after = sections({
			...input,
			profiles: [{ name: "researcher", description: "Investigate with source evidence." }],
		});
		const patch = diffSystemPromptSections(before, after)!;
		expect(Object.keys(patch)).toEqual(["octocode_delegation"]);
		const first: SystemMessage = { role: "system", content: "", sections: before, timestamp: 0 };
		const update: SystemMessage = { role: "system", content: "", sections: patch, timestamp: 1 };
		expect(getCurrentSystemPrompt([first, update])).toBe(getSystemMessageText({ ...first, sections: after }));
		const oldReplacement = octocodePrompt({
			...input,
			profiles: [{ name: "researcher", description: "Investigate with source evidence." }],
		});
		expect(getSystemMessageText(update).length).toBeLessThan(oldReplacement.length / 3);
		expect(diffSystemPromptSections(after, after)).toBeUndefined();
	});

	it("removes stale policy and server instructions when upgrading or disconnecting", () => {
		const previous = buildSystemPromptSections({ cwd: "/workspace", sections: { octocode: octocodePrompt(input) } });
		const current = sections(input, "");
		const patch = diffSystemPromptSections(previous, current)!;
		expect(patch.octocode).toBeNull();
		expect(current.octocode_mcp).toBeUndefined();
		expect(diffSystemPromptSections(sections(), current)?.mcps).toBeNull();
	});

	it("keeps server-provided headings opaque within the server section", () => {
		const text = "# Safety\nServer capability guidance.\n# Work and verification\nMore guidance.";
		const current = sections(input, text);
		for (const line of text.split("\n")) expect(current.mcps).toContain(line);
		expect(current.octocode_safety).not.toContain("Server capability");
		expect(current.octocode_work).not.toContain("More guidance");
	});

	it.each([false, true])(
		"assembles behavioral testing once and leaves messaging to the agent tool for child=%s",
		async (isSubagent) => {
			const fake = fakeHost();
			const selectedTools = ["agent", "bash", "file"];
			for (const name of selectedTools) fake.tools.set(name, { name });
			registerTurnSetup(fake.api, { isSubagent, profiles: () => new Map() });
			const options = normalizeBuildSystemPromptOptions({ cwd: "/workspace", selectedTools });
			await fake.emit("before_agent_start", { systemPromptOptions: options }, {});
			const prompt = buildSystemPrompt(options);
			expect(prompt.match(/prefer behavioral and end-to-end tests/g)).toHaveLength(1);
			expect(prompt).toContain("assert observable contracts");
			expect(prompt).toContain("write unit tests first to reproduce a bug or pin a pure function");
			expect(prompt).toContain("mock only external boundaries");
			expect(prompt).toContain("Never weaken or delete tests");
			// The agent tool's message guideline owns when to message; the policy does not restate it.
			expect(prompt).not.toContain("promptly exchange");
			if (isSubagent) {
				// The report contract rides in the child's task, not in its prompt.
				expect(prompt).not.toContain("Start it with the outcome word");
				expect(prompt).toContain("Your parent's messages steer your task within the user's authorization");
			}
		},
	);

	it("gives writers blast-radius cleanup and only the main session diagrams and close-out", () => {
		const root = octocodePrompt(input);
		const writer = octocodePrompt({ ...input, canDelegate: false });
		const reader = octocodePrompt({ ...input, canDelegate: false, readOnly: true });
		for (const prompt of [root, writer])
			expect(prompt).toContain("map the blast radius (exports, config, tests, docs)");
		expect(root).toContain("propose wider cleanups.");
		expect(writer).toContain("within your assigned area; report anything outside it instead of changing it");
		expect(reader).not.toContain("blast radius");
		// Plain-text visuals the terminal shows as written (user request: no Mermaid); only the main session answers the user.
		expect(root).toContain("draw it in plain text: a box-and-arrow sketch");
		expect(root).toContain("no Mermaid.");
		expect(root).toContain("Finish or revert partial edits and stop what you started.");
		for (const prompt of [writer, reader]) {
			expect(prompt).not.toContain("draw it in plain text");
			expect(prompt).not.toContain("Finish or revert partial edits");
		}
	});

	it("does not instruct a session without messaging to contact another agent", () => {
		const current = octocodePrompt({ ...input, canUseAgent: false });
		expect(current).not.toContain("`agent`");
		expect(current).not.toContain("# Delegation");
	});
});
