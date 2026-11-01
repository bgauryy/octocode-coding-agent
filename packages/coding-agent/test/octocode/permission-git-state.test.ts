import { describe, expect, it } from "vitest";
import type { ToolCallEvent } from "../../src/core/extensions/index.ts";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { gitStateGate } from "../../src/octocode/permission/git-state.ts";
import { gitStateMutation } from "../../src/octocode/permission/shell/git-state.ts";
import { PERMISSION_ENV, SUBAGENT_ENV, TEAM_WORKSPACE_ENV } from "../../../common/src/env.ts";

import { registerToolGates, type ToolGatesOptions } from "../../src/octocode/tool-gates.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
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
		// Moving HEAD or rewriting checked-out files changes the tree every agent here shares.
		["git switch main", "git switch"],
		["git switch -c fix origin/main", "git switch"],
		["git switch --orphan fresh", "git switch"],
		["git checkout main", "git checkout <ref>"],
		["git checkout -", "git checkout <ref>"],
		["git checkout HEAD src/a.ts", "git checkout <ref>"],
		["git checkout -b fix origin/main", "git checkout <ref>"],
		["git merge feature", "git merge"],
		["git pull --rebase", "git pull"],
		["git rebase main", "git rebase"],
		["git cherry-pick abc123", "git cherry-pick"],
		["git revert abc123", "git revert"],
		["git am fix.mbox", "git am"],
		["git mv a.ts b.ts", "git mv"],
		["git clean -fdx", "git clean"],
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
		["git switch -c feature"],
		["git switch --detach"],
		["git checkout"],
		["git clean -n"],
		["git mv --dry-run a.ts b.ts"],
		["git pull --dry-run"],
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
		const run = async (env: NodeJS.ProcessEnv, command = "git commit -am wip") => {
			const f = fakeHost();
			const permission = new Permission({ api: f.api, env: { [PERMISSION_ENV]: "full" }, isSubagent: true });
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
			registerToolGates(f.api, options);
			return {
				verdict: (await f.fire("tool_call", call(command), ctx)) as { block?: boolean } | undefined,
				hooked,
			};
		};
		const child = await run({ [SUBAGENT_ENV]: "1" });
		expect(child.verdict).toMatchObject({ block: true });
		expect(child.hooked).toEqual([]);
		expect((await run({ [SUBAGENT_ENV]: "1" }, "git switch main")).verdict).toMatchObject({ block: true });
		expect((await run({ [SUBAGENT_ENV]: "1" }, "git merge feature")).verdict).toMatchObject({ block: true });
		const main = await run({});
		expect(main.verdict?.block).toBeUndefined();
		expect(main.hooked).toEqual(["bash"]);
		const isolated = await run({ [SUBAGENT_ENV]: "1", [TEAM_WORKSPACE_ENV]: "/repo" });
		expect(isolated.verdict?.block).toBeUndefined();
	});
});
