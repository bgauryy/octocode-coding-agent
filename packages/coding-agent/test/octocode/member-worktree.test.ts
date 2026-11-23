import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { animationClock, visibleWidth } from "@octocodeai/octocode-tui";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { memberWorktree, worktreeLabel } from "../../src/octocode/worktree-paths/member-worktree.ts";
import { worktreeFooterText } from "../../src/octocode/worktrees/footer.ts";
import { roster } from "../../src/octocode/team/panel/roster.ts";
import { describeMembers } from "../../src/octocode/team/member-list.ts";
import { describeChild } from "../../src/octocode/subagents/children.ts";
import { renderAgentCall, renderAgentResult } from "../../src/octocode/subagents/render.ts";
import { agentDetailText } from "../../src/octocode/subagents/run-text.ts";
import { collapsedRows, gridRows } from "../../src/octocode/team/panel/rows.ts";
import { detailLine } from "../../src/octocode/team/panel/grid.ts";
import { rendered, theme } from "./fake-host.ts";
import { GIT_TEST_ENV, makeRepo } from "./worktree-fixture.ts";

// Reduced motion draws a running light as a full ⏺: an animation or a state, never a half-filled circle held still.
beforeEach(() => animationClock.setReducedMotion(true));

const ROOT = "/r";
const member = (id: string, extra: Partial<Member> = {}): Member => ({
	id,
	role: "general",
	pid: 1,
	status: "working",
	joinedAt: 1,
	updatedAt: 1,
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
	checkout: ROOT,
	...extra,
});
const main = member("main", { role: "main", cwd: ROOT });
const isolated = member("iso-1", { parentId: "main", cwd: "/home/u/.octocode/agent/worktrees/iso-1" });
const linked = member("peer", {
	checkout: "/r/.octocode/agent/worktrees/hotfix",
	cwd: "/r/.octocode/agent/worktrees/hotfix/src",
});
const sub = member("sub", { parentId: "main", cwd: "/r/packages/a" });

const temp: string[] = [];
afterEach(() => {
	animationClock.setReducedMotion(false);
	temp.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

describe("memberWorktree", () => {
	it("is empty in the main checkout, including a subfolder", () => {
		expect(memberWorktree(main, ROOT)).toBeUndefined();
		expect(memberWorktree(sub, ROOT)).toBeUndefined();
		expect(memberWorktree(member("old", { cwd: undefined }), ROOT)).toBeUndefined();
		expect(memberWorktree(isolated, undefined)).toBeUndefined();
	});
	it("names an isolated child's folder although its checkout is its coordinator's", () => {
		expect(memberWorktree(isolated, ROOT)).toBe("/home/u/.octocode/agent/worktrees/iso-1");
	});
	it("names the checkout of a session in a linked worktree", () => {
		expect(memberWorktree(linked, ROOT)).toBe("/r/.octocode/agent/worktrees/hotfix");
	});
	it("marks a folder that no longer exists as gone", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-"));
		temp.push(dir);
		expect(worktreeLabel(dir)).toBe(`worktree ${path.basename(dir)}`);
		expect(worktreeLabel(path.join(dir, "missing"))).toBe("worktree missing (gone)");
	});
});

describe("surfaces", () => {
	it("footer counts isolated children and linked sessions, not the main checkout", () => {
		expect(worktreeFooterText(undefined, ROOT, [main, sub])).toBeUndefined();
		expect(worktreeFooterText(undefined, ROOT, [main, isolated])).toBe("+1 agent in 1 worktree");
		expect(worktreeFooterText(undefined, ROOT, [main, isolated, linked])).toBe("+2 agents in 2 worktrees");
	});
	it("panel roster carries the folder", () => {
		const { tree } = roster([main, isolated, sub], "main", 10, []);
		expect(tree.find((e) => e.member.id === "iso-1")?.isolated?.folder).toBe(isolated.cwd);
		expect(tree.find((e) => e.member.id === "sub")?.isolated).toBeUndefined();
	});
	it("coordinate list labels isolated and linked members, not the main checkout", () => {
		const text = describeMembers([main, isolated, linked, sub], "main", 10);
		const line = (id: string) => text.split("\n").find((l) => l.startsWith(`${id} `)) ?? "";
		expect(line("iso-1")).toContain("· worktree iso-1 (gone)");
		expect(line("peer")).toContain("· worktree hotfix (gone)");
		expect(line("sub")).not.toContain("worktree");
		expect(line("main")).not.toContain("worktree");
	});
	it("agent call row shows the folder once the result names the agent", () => {
		const state: Record<string, unknown> = {};
		const context = { args: { task: "t", isolate: true }, state, isError: false, isPartial: false, expanded: false };
		renderAgentResult(
			{
				content: [{ type: "text", text: "ok" }],
				details: {
					id: "iso-1",
					profile: "general",
					goal: "g",
					toolCalls: 0,
					startedAt: 0,
					status: "done",
					activity: [],
					input: 0,
					cacheRead: 0,
					output: 0,
					cost: 0,
					unpriced: false,
				},
			} as never,
			{ expanded: false, isPartial: false },
			theme,
			context,
		);
		expect(rendered(renderAgentCall({ task: "t", goal: "fix", isolate: true }, theme, context as never))).toContain(
			"fix · isolated · worktree iso-1",
		);
	});
	it("history names the folder, and says it is gone with the ref once the child ended", () => {
		const child = { id: "iso-1", profile: "general", goal: "g", status: "background", isolated: true } as const;
		expect(describeChild(child)).toContain("isolated, worktree iso-1)");
		expect(describeChild({ ...child, status: "done" })).toContain(
			"isolated, worktree iso-1 (gone), result on refs/octocode/iso-1",
		);
	});
	it("/agents <id> marks a missing cwd as gone", () => {
		const text = agentDetailText({ agentId: "iso-1", cwd: "/nope/iso-1", live: false } as never);
		expect(text).toContain("cwd: /nope/iso-1 (gone");
	});
});

describe("worktree root and compact rows", () => {
	it("names the worktree root, not the subfolder an isolated child started in", () => {
		Object.assign(process.env, GIT_TEST_ENV);
		const repo = makeRepo();
		try {
			repo.write("packages/a/x.txt", "x\n");
			const child = member("iso-2", { parentId: "main", cwd: path.join(repo.root, "packages", "a") });
			expect(memberWorktree(child, ROOT)).toBe(repo.root);
			expect(worktreeFooterText(undefined, ROOT, [main, child])).toBe("+1 agent in 1 worktree");
		} finally {
			repo.cleanup();
		}
	});
	it("collapsed panel rows mark the worktree; the opened stats line names the folder", () => {
		const entry = { member: isolated, depth: 0, isolated: { folder: isolated.cwd! } };
		const [row] = collapsedRows([entry], 10, theme, 120);
		expect(row).toMatch(/^ └ ⏺ iso-1 · general · worktree +0s$/);
		expect(visibleWidth(row)).toBe(120);
		const { agents } = gridRows(main, "main", [entry], [], 10, theme);
		expect(detailLine(theme, agents[0], 120)).toBe(
			"                                                                                                          worktree iso-1",
		);
	});
});
