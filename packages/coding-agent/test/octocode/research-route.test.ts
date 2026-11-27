import { describe, expect, it } from "vitest";
import { buildSystemPromptSections } from "../../src/core/system-prompt.ts";
import { octocodePromptSections } from "../../src/octocode/native/prompts/policy.ts";
import { RESEARCH, useResearchRoles } from "./fake-research-roles.ts";
import { FAKE_RESEARCH } from "./fake-research.ts";

/** The base prompt's own bash search rule, shown only while nothing else owns code search. */
const BASH_SEARCH_RULE = "Search and read files with bash";
/** The research section's bash search line, without a research server. */
const POLICY_BASH_SEARCH = "Find unknown paths with bash";

const policy = (overrides: Partial<Parameters<typeof octocodePromptSections>[0]> = {}) =>
	octocodePromptSections({ research: FAKE_RESEARCH, profiles: [], canDelegate: true, ...overrides });

describe("research route", () => {
	useResearchRoles();

	it("names the research server by namespace and its reader by role, defers to its route, with bash after a refusal", () => {
		const research = policy().research;
		expect(research).toContain(`\`${FAKE_RESEARCH.prefix}*\``);
		// Contract change: the reader is named by its full tool name, the one a call must use (a bare name is not found).
		expect(research).toContain(`read with \`${RESEARCH.reader}\``);
		// Contract change: the server's own route sends quick exact lookups (a known spelling, a line range, a count) to the
		// shell, so the section follows that route instead of forbidding the shell readers it names.
		expect(research).not.toMatch(/\bnot (?:rg|grep|cat|sed)\b/);
		expect(research).toContain("`<mcps>` block routes each question, shell lookups included");
		expect(research).toContain("if one refuses the path or fails, use bash");
	});

	it("names the reader only while it is declared, and bash only while the agent has a shell", () => {
		const research = policy({ canReadLocal: false, canShell: false }).research;
		expect(research).toContain(`\`${FAKE_RESEARCH.prefix}*\``);
		expect(research).not.toContain(RESEARCH.reader.slice(FAKE_RESEARCH.prefix.length));
		expect(research).not.toContain("bash");
	});

	it("leaves the base bash search rule out while the research section owns search, even before the server's tools are declared", () => {
		const rules = (sections: Record<string, string>) =>
			buildSystemPromptSections({ cwd: "/workspace", selectedTools: ["bash"], sections }).rules ?? "";
		expect(rules(policy())).not.toContain(BASH_SEARCH_RULE);
		// Without a research server the research section names the bash commands, so the search line shows once.
		const noServer = policy({ research: undefined });
		expect(noServer.research).toContain(POLICY_BASH_SEARCH);
		expect(rules(noServer)).not.toContain(BASH_SEARCH_RULE);
		// Without Octocode's policy the base rule is the only one.
		expect(rules({})).toContain(BASH_SEARCH_RULE);
	});
});
