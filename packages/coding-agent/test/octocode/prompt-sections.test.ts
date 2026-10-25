import { renderServersSection } from "../../../mcp/src/section.ts";
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
import { fakePi } from "./fake-pi.ts";

describe("native prompt section updates", () => {
	const input = {
		octocode: true,
		canDelegate: true,
		profiles: [{ name: "researcher", description: "Investigate a question." }],
	};
	const serverSection = (instructions: string) =>
		renderServersSection([
			{
				entry: { name: "octocode", source: "default", config: { command: "test" } },
				connection: { state: "connected", instructions },
				tools: { deferred: [], declared: [{ name: "mcp__octocode__read" }] },
			},
		])!;
	const sections = (value = input, instructions = "Search and read.") =>
		buildSystemPromptSections({
			cwd: "/workspace",
			sections: {
				...octocodePromptSections(value),
				...(instructions ? { mcp_servers: serverSection(instructions) } : {}),
			},
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
		expect(diffSystemPromptSections(sections(), current)?.mcp_servers).toBeNull();
	});

	it("keeps server-provided headings opaque within the server section", () => {
		const text = "# Safety\nServer capability guidance.\n# Work and verification\nMore guidance.";
		const current = sections(input, text);
		for (const line of text.split("\n")) expect(current.mcp_servers).toContain(line);
		expect(current.octocode_safety).not.toContain("Server capability");
		expect(current.octocode_work).not.toContain("More guidance");
	});

	it.each([false, true])(
		"assembles behavioral testing and bidirectional communication once for child=%s",
		async (isSubagent) => {
			const fake = fakePi();
			const selectedTools = ["agent", "bash", "file"];
			for (const name of selectedTools) fake.tools.set(name, { name });
			registerTurnSetup(fake.pi, { isSubagent, profiles: () => new Map() });
			const options = normalizeBuildSystemPromptOptions({ cwd: "/workspace", selectedTools });
			await fake.emit("before_agent_start", { systemPromptOptions: options }, {});
			const prompt = buildSystemPrompt(options);
			expect(prompt.match(/prefer observable behavior and public contracts/g)).toHaveLength(1);
			expect(prompt).toContain("Mock external boundaries; keep internal flows real where feasible");
			expect(prompt).toContain("Use focused unit tests when useful; preserve coverage");
			expect(prompt).toContain("Never weaken or delete tests");
			expect(prompt.match(/promptly exchange findings, dependencies, blockers and evidence/g)).toHaveLength(1);
			expect(prompt).toContain("The parent relays scope decisions and integration needs");
			expect(prompt).toContain("omit unchanged status updates");
			if (isSubagent) {
				expect(prompt).toContain("Start it with one word, done, partial, blocked or failed");
				expect(prompt).toContain("Parent steering stays within existing user authorization");
			}
		},
	);

	it("does not instruct a session without messaging to contact another agent", () => {
		const current = octocodePrompt({ ...input, canUseAgent: false });
		expect(current).not.toContain("promptly exchange");
		expect(current).not.toContain("The parent relays");
	});
});
