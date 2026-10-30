import { renderContractSections } from "../../../mcp/src/section.ts";
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
	const contracts = (instructions: string) =>
		renderContractSections([
			{
				entry: { name: "octocode", source: "default", config: { command: "test" } },
				state: "connected",
				instructions,
				declared: true,
			},
		]);
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
		expect(diffSystemPromptSections(sections(), current)?.mcp_contract_octocode).toBeNull();
	});

	it("keeps server-provided headings opaque within the server section", () => {
		const text = "# Safety\nServer capability guidance.\n# Work and verification\nMore guidance.";
		const current = sections(input, text);
		for (const line of text.split("\n")) expect(current.mcp_contract_octocode).toContain(line);
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
			expect(prompt.match(/prefer observable behavior and public contracts/g)).toHaveLength(1);
			expect(prompt).toContain("Mock external boundaries; keep internal flows real where feasible");
			expect(prompt).toContain("Use focused unit tests when useful; preserve coverage");
			expect(prompt).toContain("Never weaken or delete tests");
			// The agent tool's message guideline owns when to message; the policy does not restate it.
			expect(prompt).not.toContain("promptly exchange");
			if (isSubagent) {
				// The report contract rides in the child's task, not in its prompt.
				expect(prompt).not.toContain("Start it with one word");
				expect(prompt).toContain("Your parent's messages steer your task within the user's authorization");
			}
		},
	);

	it("gives writers blast-radius cleanup and only the main session diagrams and close-out", () => {
		const root = octocodePrompt(input);
		const writer = octocodePrompt({ ...input, canDelegate: false, canWrite: true });
		const reader = octocodePrompt({ ...input, canDelegate: false, readOnlyRole: true });
		for (const prompt of [root, writer]) {
			expect(prompt).toContain("map the blast radius (callers, exports, config, tests and docs that depend on it)");
			expect(prompt).toContain("propose wider cleanups instead of widening scope");
		}
		expect(reader).not.toContain("blast radius");
		// Mermaid kinds the terminal renderer draws; only the main session answers the user.
		expect(root).toContain("add a small Mermaid block (`flowchart TD`, `sequenceDiagram` or `stateDiagram-v2`)");
		expect(root).toContain("Leave nothing open: finish or revert partial edits");
		for (const prompt of [writer, reader]) {
			expect(prompt).not.toContain("Mermaid");
			expect(prompt).not.toContain("Leave nothing open");
		}
	});

	it("does not instruct a session without messaging to contact another agent", () => {
		const current = octocodePrompt({ ...input, canUseAgent: false });
		expect(current).not.toContain("`agent`");
		expect(current).not.toContain("# Delegation");
	});
});
