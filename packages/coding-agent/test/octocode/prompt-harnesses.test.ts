import "../../src/octocode/mcp-host/render-install.ts";
import { describe, expect, it } from "vitest";
import type { HarnessStatus } from "../../src/core/discovery/vendors/types.ts";
import { buildSystemPromptSections, normalizeBuildSystemPromptOptions } from "../../src/core/system-prompt.ts";
import { registerTurnSetup } from "../../src/octocode/turn.ts";
import { fakeHost } from "./fake-host.ts";

const status = (overrides: Partial<HarnessStatus>): HarnessStatus => ({
	id: "octocode",
	label: "Octocode",
	on: true,
	defaultOn: true,
	switchable: false,
	found: {},
	loaded: {},
	...overrides,
});

const harnesses: HarnessStatus[] = [
	status({}),
	status({ id: "claude", label: "Claude Code", on: false, switchable: true, found: { skill: 1, mcp: 2 } }),
	status({ id: "codex", label: "Codex", on: true, projectOnly: true, switchable: true, found: { mcp: 1 } }),
	status({ id: "mcp-json", label: "root .mcp.json", on: true, switchable: true }),
	status({ id: "cursor", label: "Cursor", on: false, switchable: true }),
];

/**
 * The `Harnesses:` line tells the main session which harnesses exist and that the user switches them with /harness.
 * Its prose lives in instructions/system/harnesses.md (AGENTS.md: prose only in instructions), and a subagent, which
 * cannot run /harness, does not get it.
 */
describe("harnesses prompt line", () => {
	it.each([false, true])("is in the main prompt and absent from a child's (child=%s)", async (isSubagent) => {
		const fake = fakeHost();
		const selectedTools = ["agent", "bash", "file"];
		for (const name of selectedTools) fake.tools.set(name, { name });
		registerTurnSetup(fake.api, { isSubagent, profiles: () => new Map() });
		const options = normalizeBuildSystemPromptOptions({ cwd: "/workspace", selectedTools, harnesses });
		await fake.emit("before_agent_start", { systemPromptOptions: options }, {});
		const sections = buildSystemPromptSections(options);
		if (isSubagent) {
			expect(sections.harnesses).toBeUndefined();
		} else {
			expect(sections.harnesses).toBeTruthy();
		}
	});
});
