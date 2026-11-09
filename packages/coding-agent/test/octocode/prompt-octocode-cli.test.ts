import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../../src/core/system-prompt.ts";
import { leanPromptSections } from "../../src/octocode/instructions/lean.ts";
import { octocodePromptSections } from "../../src/octocode/instructions/policy.ts";
import { FAKE_RESEARCH } from "./fake-research.ts";

// The Octocode MCP server and the `octocode` CLI are external (decision 2026-11-05): their own instructions, tool
// descriptions and `--help` explain them, so no instruction of ours names their tools, commands or flags.
const research = (input: { research: boolean; canShell?: boolean; canWeb?: boolean; canDelegate?: boolean }) =>
	octocodePromptSections({
		research: input.research ? FAKE_RESEARCH : undefined,
		profiles: [],
		canDelegate: input.canDelegate ?? true,
		canShell: input.canShell ?? true,
		canWeb: input.canWeb ?? true,
	}).research;

const CLI_USAGE = /`octocode[` ]|graphBuild|graphQuery|ghCloneRepo/;

describe("research guidance without Octocode CLI usage", () => {
	it("with a research server, restarts a failing server, then falls back to bash search", () => {
		expect(research({ research: true })).toContain(
			"- If one of these tools fails or is missing, say so and restart its server; if it still fails, fall back to bash search (`rg`, `fd`, `sed -n`).",
		);
		expect(research({ research: true, canShell: false })).toContain(
			"- If one of these tools fails or is missing, say so and restart its server.",
		);
	});

	it("without a research server, uses bash search and gh or web", () => {
		const text = research({ research: false });
		expect(text).toContain("- Search with bash when the location is unknown");
		expect(text).toContain("- Use `web` (or the `gh` CLI in bash when available)");
	});

	it("never names the octocode CLI or its tools in the policy, the bash rule or the lean section", () => {
		for (const hasServer of [true, false])
			for (const canDelegate of [true, false])
				expect(research({ research: hasServer, canDelegate })).not.toMatch(CLI_USAGE);
		const prompt = buildSystemPrompt({ cwd: "/tmp", selectedTools: ["bash"], contextFiles: [], skills: [] });
		expect(prompt).toContain(
			"Search and read files with bash (rg, fd, ls, sed -n), since no dedicated search or read tool is declared",
		);
		expect(prompt).not.toMatch(CLI_USAGE);
		for (const canShell of [true, false])
			expect(leanPromptSections({ canShell, canSave: true, readOnly: false }).lean).not.toMatch(CLI_USAGE);
	});
});
