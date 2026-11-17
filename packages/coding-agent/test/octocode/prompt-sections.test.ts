import "../../src/octocode/mcp-host/render-install.ts";
import { renderMcpsSection } from "../../../mcp/src/section.ts";
import { getCurrentSystemPrompt, getSystemMessageText, type SystemMessage } from "@octocodeai/octocode-ai";
import { describe, expect, it } from "vitest";
import { buildSystemPromptSections, diffSystemPromptSections } from "../../src/core/system-prompt.ts";
import { octocodePrompt, octocodePromptSections } from "../../src/octocode/instructions/policy.ts";
import { FAKE_RESEARCH } from "./fake-research.ts";

describe("native prompt section updates", () => {
	const input = {
		research: FAKE_RESEARCH,
		canDelegate: true,
		profiles: [{ name: "researcher", description: "Investigate a question." }],
	};
	const sections = (value = input, instructions = "Search and read.") =>
		buildSystemPromptSections({
			cwd: "/workspace",
			sections: octocodePromptSections(value),
			baseSections: instructions
				? {
						mcps: renderMcpsSection([
							{
								entry: { name: "octocode", source: "default", config: { command: "test" } },
								state: "connected",
								contract: instructions,
								declared: true,
							},
						])!,
					}
				: {},
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
		expect(diffSystemPromptSections(after, after)).toBeUndefined();
	});

	it("removes stale policy and server instructions when upgrading or disconnecting", () => {
		const previous = buildSystemPromptSections({ cwd: "/workspace", sections: { octocode: octocodePrompt(input) } });
		const current = sections(input, "");
		const patch = diffSystemPromptSections(previous, current)!;
		expect(patch.octocode).toBeNull();
		expect(current.octocode_mcp).toBeUndefined();
		expect(diffSystemPromptSections(sections(), current)).toMatchObject({ mcps: null, "mcps:octocode": null });
	});

	it("keeps synthetic server headings opaque within the server section", () => {
		const text = "# Safety\nServer capability guidance.\n# Work and verification\nMore guidance.";
		const current = sections(input, text);
		for (const line of text.split("\n")) expect(current["mcps:octocode"]).toContain(line);
		expect(current.safety).not.toContain("Server capability");
		expect(current.work).not.toContain("More guidance");
	});
});
