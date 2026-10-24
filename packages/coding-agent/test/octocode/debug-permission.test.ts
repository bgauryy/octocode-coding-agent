import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import type { ToolCallEvent } from "../../src/core/extensions/index.ts";
import { classify } from "../../src/octocode/permission/gate/classify.ts";
import { isolatedTreeRefusal } from "../../src/octocode/permission/isolated-tree.ts";
import { readOnlyRoleRefusal } from "../../src/octocode/permission/read-only-role.ts";
import { READ_ONLY_ENV, SUBAGENT_ENV, TEAM_WORKSPACE_ENV } from "../../src/octocode/shared/env.ts";

import { profileReach } from "../../src/octocode/subagents/profiles.ts";
import { tmp } from "./helpers.ts";

const call = (action: string): ToolCallEvent => ({
	type: "tool_call",
	toolCallId: "debug-check",
	toolName: "debug",
	input: { action, adapter: "adapter", launch: { program: "/outside/program" } },
});

describe("debugger permission integration", () => {
	it("includes an explicitly selected debugger in the child's authorized process capabilities", () => {
		expect(profileReach(undefined, ["debug"])).toContain("shell");
		expect(profileReach(undefined, ["file"])).not.toContain("shell");
	});
	it.each(["launch", "breakpoints", "continue", "next", "stepIn", "stepOut", "stack", "scopes", "variables", "output"])(
		"classifies %s as process execution and refuses it for a read-only role",
		(action) => {
			const event = call(action);
			const request = classify(event, { cwd: "/repo" }, () => undefined);
			expect(request).toMatchObject({ action: "shell", toolCallId: "debug-check" });
			expect(request?.what).toContain(JSON.stringify(event.input));
			expect(request?.grant).toBeUndefined();
			expect(readOnlyRoleRefusal(event, "/repo", { [SUBAGENT_ENV]: "1", [READ_ONLY_ENV]: "1" })).toMatch(
				/read-only role/,
			);
		},
	);

	it("refuses opaque debugger effects in isolated workers, retaining termination", () => {
		const main = fs.realpathSync(tmp());
		const worktree = fs.realpathSync(tmp());
		execFileSync("git", ["init", "-q"], { cwd: main });
		execFileSync("git", ["init", "-q"], { cwd: worktree });
		const env = { [SUBAGENT_ENV]: "1", [TEAM_WORKSPACE_ENV]: main, [READ_ONLY_ENV]: "1" };
		expect(isolatedTreeRefusal(call("launch"), worktree, env)).toMatch(/isolated/);
		expect(isolatedTreeRefusal(call("variables"), worktree, env)).toMatch(/isolated/);
		expect(isolatedTreeRefusal(call("terminate"), worktree, env)).toBeUndefined();
		expect(readOnlyRoleRefusal(call("terminate"), worktree, env)).toBeUndefined();
		expect(classify(call("terminate"), { cwd: worktree }, () => undefined)).toBeUndefined();
		expect(isolatedTreeRefusal(call("launch"), main, env)).toBeUndefined();
	});
});
