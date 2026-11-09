import { expect, it } from "vitest";
import { hookPayload } from "../../src/octocode/hooks/profiles.ts";
it("projects Claude Bash units without native execution options", () => {
	expect(
		hookPayload("claude", {
			hook_event_name: "PermissionRequest",
			pi_tool_name: "bash",
			tool_input: { command: "x", timeout: 2, background: true, type: "bash" },
		}).tool_input,
	).toEqual({ command: "x", timeout: 2000, run_in_background: true });
});

import { rewriteClaudeBash } from "../../src/octocode/tool-input/claude-bash.ts";
it("whitelists source fields and never turns native-only keys into execution options", () => {
	expect(
		rewriteClaudeBash(
			{ command: "old", timeout: 50, background: true },
			{
				command: "new",
				background: true,
				type: "powershell",
				description: "why",
			},
		),
	).toEqual({ command: "new", description: "why" });
});
