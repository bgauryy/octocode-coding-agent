import { describe, expect, it } from "vitest";
import type { ToolCallEvent } from "../../src/core/extensions/index.ts";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { gitStateGate } from "../../src/octocode/permission/git-state.ts";
import { gitStateMutation } from "../../src/octocode/permission/shell/git-state.ts";
import { PERMISSION_ENV, SUBAGENT_ENV, TEAM_WORKSPACE_ENV } from "../../src/octocode/shared/env.ts";

import { registerToolGates, type ToolGatesOptions } from "../../src/octocode/tool-gates.ts";
import { fakeCtx, fakePi } from "./fake-pi.ts";
import { tmp } from "./helpers.ts";

const call = (command: string, toolName = "bash") =>
	({ type: "tool_call", toolCallId: "t1", toolName, input: { command } }) as ToolCallEvent;

describe("git state mutations in a shell command", () => {
	it.each([
		["git add .", "git add"],
		["git add -A && git status", "git add"],
		["git rm --cached secrets.env", "git rm"],
		["git stash", "git stash"],
		["git stash pop", "git stash pop"],
		["git stash -u", "git stash"],
		['git commit -m "wip"', "git commit"],
		["git reset --hard HEAD", "git reset"],
		["git reset", "git reset"],
		["git checkout -- src/a.ts", "git checkout -- <path>"],
		["git checkout main -- src/a.ts", "git checkout -- <path>"],
		["git checkout .", "git checkout -- <path>"],
		["git restore --staged src/a.ts", "git restore"],
		["git restore src/a.ts", "git restore"],
		["git -C packages/ai add x.ts", "git add"],
		["env GIT_PAGER=cat git add x", "git add"],
		["FOO=1 timeout 10 git commit -am x", "git commit"],
		['bash -c "cd pkg && git add ."', "git add"],
		["yarn test; git stash", "git stash"],
		['echo "git add ." | sh', "git add"],
		["sh <<EOF\ngit commit -m x\nEOF", "git commit"],
		["eval git reset --hard", "git reset"],
		["/usr/bin/git add x", "git add"],
	])("finds %j", (command, found) => expect(gitStateMutation(command)).toBe(found));

	it.each([
		["git status"],
		["git diff --cached"],
		["git log --oneline -5"],
		["git stash list"],
		["git stash show -p"],
		["git add --dry-run ."],
		["git checkout -b feature"],
		["git show HEAD:src/a.ts"],
		['grep -rn "git add" docs'],
		['echo "git add ."'],
		['git commit --dry-run -m "x"'],
	])("leaves %j alone", (command) => expect(gitStateMutation(command)).toBeUndefined());
});

describe("the subagent git-state invariant", () => {
	const ctx = fakeCtx({ cwd: tmp() });

	it("refuses a shared-tree subagent, telling it to leave git state to its parent", async () => {
		const gate = gitStateGate({ subagent: true, isolated: false })!;
		const verdict = await gate(call("git add -A"), ctx);
		expect(verdict?.block).toBe(true);
		expect(verdict?.reason).toContain("`git add`");
		expect(verdict?.reason).toContain("Leave git state to your parent");
		expect(await gate(call("git status"), ctx)).toBeUndefined();
		expect(await gate(call("git stash", "powershell"), ctx)).toMatchObject({ block: true });
		expect(await gate({ ...call("x"), toolName: "file", input: { path: "a" } }, ctx)).toBeUndefined();
	});

	it("does not apply to the main session or an isolated subagent", () => {
		expect(gitStateGate({ subagent: false, isolated: false })).toBeUndefined();
		expect(gitStateGate({ subagent: true, isolated: true })).toBeUndefined();
	});

	it("blocks in the tool_call pipeline even in full mode, before the hooks run", async () => {
		const run = async (env: NodeJS.ProcessEnv) => {
			const f = fakePi();
			const permission = new Permission({ pi: f.pi, env: { [PERMISSION_ENV]: "full" }, isSubagent: true });
			permission.start(ctx);
			const hooked: string[] = [];
			const options = {
				permission,
				provenance: { check: () => undefined },
				annotations: () => undefined,
				collab: { reservationGate: async () => undefined },
				hooks: {
					preToolUse: async (event: ToolCallEvent) => {
						hooked.push(event.toolName);
						return undefined;
					},
				},
				sourcePolicy: { refresh: async () => undefined },
				activity: { checking: () => undefined },
				localReads: new Map(),
				env,
			} as unknown as ToolGatesOptions;
			registerToolGates(f.pi, options);
			return { verdict: await f.fire("tool_call", call("git commit -am wip"), ctx), hooked };
		};
		const child = await run({ [SUBAGENT_ENV]: "1" });
		expect(child.verdict).toMatchObject({ block: true });
		expect(child.hooked).toEqual([]);
		const main = await run({});
		expect(main.verdict).toBeUndefined();
		expect(main.hooked).toEqual(["bash"]);
		const isolated = await run({ [SUBAGENT_ENV]: "1", [TEAM_WORKSPACE_ENV]: "/repo" });
		expect(isolated.verdict).toBeUndefined();
	});
});
