import { describe, expect, it } from "vitest";
import type { ToolCallEvent } from "../../src/core/features/index.ts";
import { gitStateGate } from "../../src/octocode/permission/git-state.ts";
import { fakeCtx } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const call = (command: string, toolName = "bash") =>
	({ type: "tool_call", toolCallId: "t1", toolName, input: { command } }) as ToolCallEvent;

describe("the main session's git-state gate with a peer session in the checkout", () => {
	const ctx = fakeCtx({ cwd: tmp() });

	it("has no gate unless peers can be told", () => {
		expect(gitStateGate({ subagent: false, isolated: false })).toBeUndefined();
	});

	it.each([
		"git stash",
		"git stash push -u",
		"git stash pop",
		"git restore src/a.ts",
		"git checkout -- src/a.ts",
		"git checkout .",
	])("asks, not refuses, before `%s` while a peer is present", async (command) => {
		const gate = gitStateGate({ subagent: false, isolated: false, peers: () => true })!;
		const verdict = await gate(call(command), ctx);
		expect(verdict?.ask).toContain("another session works in it");
		expect(verdict?.block).toBeUndefined();
	});

	it.each(["git stash", "git restore a.ts", "git checkout -- a.ts"])(
		"does not ask for `%s` without a peer",
		async (command) => {
			const gate = gitStateGate({ subagent: false, isolated: false, peers: () => false })!;
			expect(await gate(call(command), ctx)).toBeUndefined();
		},
	);

	it.each(["git status", "git stash list", "git diff", "git add a.ts", "git commit -m x", "git switch -c topic"])(
		"leaves `%s` alone even with a peer",
		async (command) => {
			const gate = gitStateGate({ subagent: false, isolated: false, peers: () => true })!;
			expect(await gate(call(command), ctx)).toBeUndefined();
		},
	);

	it("does not look for peers on a command that cannot discard", async () => {
		let looked = 0;
		const gate = gitStateGate({
			subagent: false,
			isolated: false,
			peers: () => {
				looked++;
				return true;
			},
		})!;
		await gate(call("ls"), ctx);
		await gate(call("git status"), ctx);
		expect(looked).toBe(0);
	});

	it("still refuses a shared-tree subagent whatever the peers", async () => {
		const gate = gitStateGate({ subagent: true, isolated: false, peers: () => false })!;
		expect(await gate(call("git stash"), ctx)).toMatchObject({ block: true });
	});
});
