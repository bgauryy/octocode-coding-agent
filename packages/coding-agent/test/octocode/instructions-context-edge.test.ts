import { describe, expect, it } from "vitest";
import { renderInstruction } from "../../src/core/prompt-template.ts";
import type { HarnessStatus } from "../../src/core/discovery/vendors/types.ts";
import { buildSystemPromptSections } from "../../src/core/system-prompt.ts";
import { SYSTEM_PROMPT_SECTIONS, systemPromptSectionSpec } from "../../src/core/system-prompt-spec.ts";
import { leanPromptSections } from "../../src/octocode/instructions/lean.ts";
import { octocodePrompt, octocodePromptSections } from "../../src/octocode/instructions/policy.ts";
import { FAKE_RESEARCH } from "./fake-research.ts";

/**
 * Context edges of the instruction text: what enters the cached system prompt, in which tier, and that one rule is
 * stated once. Provider cache rules: a changed section invalidates itself and everything after it, so each section's
 * tier must be declared in `instructions/sections/index.md`, not left to the fallback slot for unknown names.
 */
describe("instruction context edges", () => {
	it("declares the harnesses section the core writes in the section map, in the session tier after role", () => {
		const octocode: HarnessStatus = {
			id: "octocode",
			label: "Octocode",
			on: true,
			defaultOn: true,
			switchable: false,
			found: {},
			loaded: {},
		};
		const sections = buildSystemPromptSections({
			cwd: "/tmp",
			selectedTools: [],
			harnesses: [octocode],
			sections: { role: "Role." },
			environment: "Date: 2026-11-08",
		});
		expect(sections.harnesses).toContain("Harnesses: Octocode on.");
		expect(systemPromptSectionSpec("harnesses")).toMatchObject({ name: "harnesses", tier: "session" });
		// The declared order keeps the prompt byte for byte: after role, before the volatile tier, which `cwd` opens.
		const order = SYSTEM_PROMPT_SECTIONS.map((spec) => spec.name);
		expect(order.indexOf("harnesses")).toBe(order.indexOf("role") + 1);
		expect(order.indexOf("cwd")).toBe(order.indexOf("harnesses") + 1);
		expect(Object.keys(sections).slice(-4)).toEqual(["role", "harnesses", "cwd", "environment"]);
	});

	it("asks the main session once to say what it waits for before ending a turn", () => {
		// The main session is the one that can delegate (`policyFlags`: main = canDelegate), so it has both sections.
		for (const research of [FAKE_RESEARCH, undefined]) {
			const root = octocodePrompt({ research, profiles: [], canDelegate: true });
			expect(root.match(/say once what you wait for|say which\./g) ?? []).toHaveLength(1);
			// The delegation rule keeps what only it says: the coordinator owns the result and does not predict it.
			expect(root).toContain("you own the result: never predict a pending result.");
			// Waiting on a peer session it messaged is a licensed end of turn too, announced like a child or a job.
			expect(root).toContain(
				"End a turn only when it needs the user, a running child/job or a peer you messaged; say which.",
			);
		}
	});

	it("keeps the final judgment with the coordinator: no model tier is routed the work it must not delegate", () => {
		for (const research of [FAKE_RESEARCH, undefined]) {
			const delegation = octocodePromptSections({ research, profiles: [], canDelegate: true }).delegation ?? "";
			expect(delegation).toContain("Never delegate understanding, synthesis or the final judgment");
			// The routing line picks a child's model; naming the final judgment there invites delegating it.
			expect(delegation.match(/final judgment/g) ?? []).toHaveLength(1);
		}
	});

	it("leaves the ban on polling to the timer tool's snippet: the delegation policy only says what to wait on", () => {
		// Tool descriptions own tool mechanics (AGENTS.md); the policy says when to wait on an item, not how not to.
		const snippet = renderInstruction("tools/timer/snippet.md", {});
		expect(snippet).toContain("Use it instead of sleep, polling or `tail -f`");
		for (const research of [FAKE_RESEARCH, undefined]) {
			// The waiting rule is in the `children` section, sent once the session waits on an agent.
			const sections = octocodePromptSections({ research, profiles: [], canDelegate: true, childStarted: true });
			const delegation = `${sections.delegation}\n${sections.children}`;
			expect(delegation).toContain("wait on a peer's or a dependency's backlog item with `timer` `until item`");
			expect(delegation).not.toMatch(/\bpoll/);
		}
	});

	it("asks the coordinator for a brief with boundaries, objective, answer shape and a Definition of Done", () => {
		const root = octocodePrompt({ research: undefined, profiles: [], canDelegate: true });
		const brief = root.split("\n").find((line) => line.startsWith("- Write for a fresh agent:")) ?? "";
		expect(brief).toContain("hard limits first; output and purpose");
		expect(brief).toContain("when to stop (Definition of Done as evidence");
		// The child returns a conclusion the coordinator can use, not material it must digest again.
		expect(brief).toContain("Ask for the answer, not raw material or advice");
	});

	it("tells every child that can write to keep bulky output in a file and cite its path, so its report stays condensed", () => {
		// The coordinator keeps the first 8 KB of a report and gets the path of the whole one (pinned in prompt.test.ts);
		// the rule here keeps logs and listings out of the report in the first place, without cutting anything.
		const writer = octocodePrompt({ research: undefined, profiles: [], canDelegate: false });
		const reader = octocodePrompt({ research: undefined, profiles: [], canDelegate: false, readOnly: true });
		expect(writer).toContain("Put substantial results in a Markdown doc in your scratch folder and cite its path");
		expect(reader).toContain("Save substantial results as Markdown in scratch and cite the path.");
		expect(writer).toContain("Be concise and refer to files by their paths.");
		const lean = leanPromptSections({ canShell: true, canSave: true, readOnly: false }).lean;
		expect(lean).toContain("Put long output in a file in your scratch folder and cite its path.");
	});
});
