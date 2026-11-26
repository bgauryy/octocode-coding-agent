import { realpathSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolCallEvent } from "../../src/core/features/index.ts";
import { gitStateGate } from "../../src/octocode/permission/git-state.ts";
import { foreignCliInCheckout } from "../../src/octocode/worktrees/foreign-clis.ts";
import { checkoutSharers } from "../../src/octocode/worktrees/sharing.ts";
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

describe("the gate with another vendor's CLI in the checkout", () => {
	const ctx = fakeCtx({ cwd: tmp() });

	it("asks before `git stash`, naming the CLI", async () => {
		const gate = gitStateGate({ subagent: false, isolated: false, peers: async () => "a Codex session (pid 7)" })!;
		const verdict = await gate(call("git stash"), ctx);
		expect(verdict?.ask).toContain("a Codex session (pid 7) works in it");
		expect(verdict?.block).toBeUndefined();
	});

	it("finds a CLI whose folder is the checkout or inside it, not one in its worktrees folder, and scans once", async () => {
		const root = realpathSync(tmp());
		let scans = 0;
		const lookup = foreignCliInCheckout({
			table: async () => {
				scans++;
				return [{ pid: 7, ppid: 1, rssKb: 1, started: "1", command: "/usr/bin/codex" }];
			},
			cwdOf: async () => new Map([[7, path.join(root, "pkg")]]),
			ownRoots: [],
		});
		expect(await lookup(root)).toMatchObject({ pid: 7, name: "Codex" });
		expect(await lookup(path.join(tmp(), "elsewhere"))).toBeUndefined();
		expect(scans).toBe(1);
	});

	it("does not count CLIs that work in the checkout's own worktrees", async () => {
		const root = realpathSync(tmp());
		const lookup = foreignCliInCheckout({
			table: async () => [{ pid: 7, ppid: 1, rssKb: 1, started: "1", command: "/usr/bin/codex" }],
			cwdOf: async () => new Map([[7, path.join(root, ".octocode", "agent", "worktrees", "x")]]),
			ownRoots: [],
		});
		expect(await lookup(root)).toBeUndefined();
	});

	it("tells a team peer from a foreign CLI", async () => {
		const team = { id: "me", members: () => [{ id: "other", role: "main" }] };
		expect(await checkoutSharers(team, async () => undefined)(tmp())).toBe(true);
		const alone = { id: "me", members: () => [] };
		const cli = { pid: 9, name: "Gemini CLI", cwd: "/x" };
		expect(await checkoutSharers(alone, async () => cli)(tmp())).toBe("a Gemini CLI session (pid 9)");
		expect(await checkoutSharers(alone, async () => undefined)(tmp())).toBeUndefined();
	});
});

describe("`git worktree add` by a session that is not the main orchestrator", () => {
	const ctx = fakeCtx({ cwd: tmp() });

	it("is refused in a linked worktree, naming the orchestrator, and passes in the main checkout", async () => {
		const linked = gitStateGate({
			subagent: false,
			isolated: false,
			orchestrator: () => "this session, a proxy of the main-checkout session of /repo,",
		})!;
		const verdict = await linked(call("git worktree add ../x -b y"), ctx);
		expect(verdict).toMatchObject({ block: true });
		expect(verdict?.reason).toContain("proxy of the main-checkout session of /repo");
		expect(await linked(call("git worktree list"), ctx)).toBeUndefined();
		const main = gitStateGate({ subagent: false, isolated: false, orchestrator: () => undefined, peers: () => false })!;
		expect(await main(call("git worktree add ../x"), ctx)).toBeUndefined();
	});
});
