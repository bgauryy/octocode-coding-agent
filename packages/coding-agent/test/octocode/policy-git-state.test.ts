import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { octocodePrompt } from "../../src/octocode/instructions/policy.ts";
import { FAKE_RESEARCH } from "./fake-research.ts";

const LINE =
	"- Leave the git index, stashes, commits and other agents' files alone; format and lint only the files you changed.";
const ROLES = path.join(path.dirname(new URL(import.meta.url).pathname), "../../src/octocode/instructions/roles");

/** Whether a bundled role's `tools:` line includes a shell, as `turn.ts` derives `canShell` from the active tools. */
const roleHasShell = (role: string): boolean => {
	const tools = /^tools:\s*(.*)$/m.exec(fs.readFileSync(path.join(ROLES, `${role}.md`), "utf8"))?.[1] ?? "";
	return tools.split(",").some((tool) => ["bash", "powershell"].includes(tool.trim()));
};

describe("the subagent git-state line", () => {
	it("is in a subagent's prompt when it has bash", () => {
		expect(octocodePrompt({ research: FAKE_RESEARCH, profiles: [], canDelegate: false, canShell: true })).toContain(
			LINE,
		);
	});

	it("is not in a browser child's prompt (no shell), nor in the main session's", () => {
		expect(roleHasShell("browser")).toBe(false);
		expect(
			octocodePrompt({ research: FAKE_RESEARCH, profiles: [], canDelegate: false, canShell: roleHasShell("browser") }),
		).not.toContain(LINE);
		expect(octocodePrompt({ research: FAKE_RESEARCH, profiles: [], canDelegate: true, canShell: true })).not.toContain(
			LINE,
		);
	});
});
