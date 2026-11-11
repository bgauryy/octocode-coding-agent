import "../../src/octocode/mcp-host/render-install.ts";
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
import { FAKE_RESEARCH } from "./fake-research.ts";
import { registerTurnSetup } from "../../src/octocode/turn.ts";
import { fakeHost } from "./fake-host.ts";

describe("native prompt section updates", () => {
	const input = {
		research: FAKE_RESEARCH,
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
		expect(Object.keys(patch)).toEqual(["delegation"]);
		const first: SystemMessage = { role: "system", content: "", sections: before, timestamp: 0 };
		const update: SystemMessage = { role: "system", content: "", sections: patch, timestamp: 1 };
		expect(getCurrentSystemPrompt([first, update])).toBe(getSystemMessageText({ ...first, sections: after }));
		const oldReplacement = octocodePrompt({
			...input,
			profiles: [{ name: "researcher", description: "Investigate with source evidence." }],
		});
		const updateText = getSystemMessageText(update);
		const unchanged = Object.entries(after).filter(
			(entry): entry is [string, string] =>
				entry[0] !== "delegation" && typeof entry[1] === "string" && entry[1].length > 40,
		);
		expect(unchanged.length).toBeGreaterThan(0);
		for (const [name, text] of unchanged)
			expect(updateText, `the update repeats unchanged section ${name}`).not.toContain(text);
		expect(updateText.length).toBeLessThan(oldReplacement.length / 2);
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
		expect(current.safety).not.toContain("Server capability");
		expect(current.work).not.toContain("More guidance");
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
			expect(prompt.match(/Test public behavior/g)).toHaveLength(1);
			expect(prompt).toContain("Test public behavior");
			expect(prompt).toContain("reproduce bugs with failing tests");
			expect(prompt).toContain("mocking only external boundaries");
			expect(prompt).toContain("Never weaken or delete tests");
			// The agent tool's message guideline owns when to message; the policy does not restate it.
			expect(prompt).not.toContain("promptly exchange");
			if (isSubagent) {
				// The report contract rides in the child's task, not in its prompt.
				expect(prompt).not.toContain("Start it with the outcome word");
				expect(prompt).toContain("Your coordinator's messages steer your task within the user's authorization");
			}
		},
	);

	it("gives writers blast-radius cleanup and only the main session diagrams and close-out", () => {
		const root = octocodePrompt(input);
		const writer = octocodePrompt({ ...input, canDelegate: false });
		const reader = octocodePrompt({ ...input, canDelegate: false, readOnly: true });
		for (const prompt of [root, writer]) expect(prompt).toContain("check exports, config and docs");
		expect(root).toContain("propose wider cleanups.");
		expect(writer).toContain("report issues outside your assignment");
		expect(reader).not.toContain("blast radius");
		// Plain-text visuals the terminal shows as written (user request: no Mermaid); only the main session answers the user.
		const forms = [
			"Flow / dependencies → arrows",
			"Branches            → decision tree",
			"Hierarchy           → tree",
			"Comparison          → table",
			"Runnable procedure  → numbered steps + commands",
			"Simple answer       → sentence",
		];
		for (const form of forms) {
			expect(root).toContain(form);
			for (const prompt of [writer, reader]) expect(prompt).not.toContain(form);
		}
		expect(root).toContain("within 100 columns, no Mermaid:");
		expect(root).toContain("Numeric comparisons need units; before/after needs change.");
		expect(root).toContain("Compare choices by criteria.");
		expect(root).toContain("Fence code with its known language, logs as `text`;");
		expect(root).toContain("keep commands and link targets exact.");
		expect(root).toContain("Do not repeat visuals in prose;");
		expect(root).toContain("Use the shortest clear form.");
		expect(root).toContain("Finish or revert partial edits; stop only your jobs whose result is moot.");
		for (const prompt of [writer, reader]) {
			expect(prompt).not.toContain("draw it in plain text");
			expect(prompt).not.toContain("Finish or revert partial edits");
		}
	});

	it("does not instruct a session without messaging to contact another agent", () => {
		const current = octocodePrompt({ ...input, canUseAgent: false });
		expect(current).not.toContain("`agent`");
		expect(current).not.toContain("## Run children and use reports");
	});
});
