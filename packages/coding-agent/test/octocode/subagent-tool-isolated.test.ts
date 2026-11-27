import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type * as NativeConfig from "../../src/config.ts";
import { ReportGroups } from "../../src/octocode/subagents/report-groups.ts";
import { createWorktree, worktreesDir } from "../../src/octocode/subagents/worktree.ts";
import { git, repo, reportOf, setup, useScriptedChild } from "./subagent-tool-harness.ts";

vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof NativeConfig>()),
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]] }),
}));

useScriptedChild();

describe("isolated subagents and /agents merge", () => {
	it("requires isolation for a working-copy snapshot and leaves a dirty parent untouched", async () => {
		const dir = repo();
		const s = setup(dir);
		await expect(s.run({ task: "report quickly", workingCopy: true })).rejects.toThrow(
			"workingCopy requires isolate: true",
		);
		fs.writeFileSync(path.join(dir, "parent.txt"), "dirty parent\n");
		const result = await s.run({ task: "edit a file", isolate: true, workingCopy: true });
		const id = result.details.id as string;
		expect(result.content[0].text).toContain(`/agents merge ${id}`);
		expect(fs.readFileSync(path.join(dir, "parent.txt"), "utf8")).toBe("dirty parent\n");
		expect(fs.existsSync(path.join(dir, "child.txt"))).toBe(false);
		expect(git(dir, "diff", "--name-only", "HEAD", `refs/octocode/${id}`)).toBe("child.txt");
	}, 30_000);

	it("lands the child's edits on its ref and merges them with /agents merge", async () => {
		const dir = repo();
		const s = setup(dir);
		const merge = { handler: (args: string, ctx: unknown) => s.commands.get("agents").handler(`merge ${args}`, ctx) };
		await merge.handler("", s.ctx);
		expect(s.ctx.ui.notes.at(-1)).toEqual({
			message: "Usage: /agents merge <id>. No isolated results to merge.",
			type: "warning",
		});

		const result = await s.run({ task: "edit a file", isolate: true });
		const id = result.details.id as string;
		expect(result.content[0].text).toContain(`/agents merge ${id}`);
		expect(fs.existsSync(path.join(dir, "child.txt"))).toBe(false);
		await merge.handler("", s.ctx);
		expect(s.ctx.ui.notes.at(-1)!.message).toBe(`Usage: /agents merge <id>. Unmerged: ${id}`);

		await merge.handler(id, s.ctx);
		expect(s.ctx.ui.notes.at(-1)!.type).toBe("info");
		expect(fs.readFileSync(path.join(dir, "child.txt"), "utf8")).toBe("from the child\n");
		await merge.handler("bad id!", s.ctx);
		expect(s.ctx.ui.notes.at(-1)!.type).toBe("error");

		// Background isolated runs report the outcome in their message: child.txt is already merged, so nothing changed.
		await s.run({ task: "edit in background", isolate: true, background: true });
		await vi.waitFor(() => expect(s.sent.at(-1)?.message.content).toMatch(/reported done[\s\S]*changed no files/));
		await expect(s.run({ task: "fail isolated", isolate: true })).rejects.toThrow(
			/Subagent failed \(startup\): exited with code 3/,
		);
		await s.emit("session_start", {}, s.ctx);
	}, 60_000);

	describe("leaves no worktree behind on a cancel path", () => {
		/** What the repository's isolated-worktree folder holds: an owner record and a folder per live worktree. */
		const leftovers = (dir: string): string[] => {
			const folder = worktreesDir(dir);
			return fs.existsSync(folder) ? fs.readdirSync(folder) : [];
		};

		it("removes the worktree of a foreground run the user stops mid-run", async () => {
			const dir = repo();
			const s = setup(dir);
			const controller = new AbortController();
			const updates: Array<{ details: { toolCalls: number } }> = [];
			const running = s.run({ task: "slow isolated", isolate: true }, controller.signal, (update) =>
				updates.push(update as never),
			);
			// The child is running its command, so the abort stops a live process rather than the launch.
			await vi.waitFor(() => expect(updates.some((update) => update.details.toolCalls > 0)).toBe(true));
			expect(leftovers(dir).length).toBeGreaterThan(0);
			controller.abort();
			await expect(running).rejects.toThrow(/Subagent cancelled/);
			expect(leftovers(dir)).toEqual([]);
			expect(git(dir, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
		}, 30_000);

		it("removes the worktree when the turn is already aborted at launch", async () => {
			const dir = repo();
			const s = setup(dir);
			const controller = new AbortController();
			controller.abort();
			await expect(s.run({ task: "slow isolated", isolate: true }, controller.signal)).rejects.toThrow();
			expect(leftovers(dir)).toEqual([]);
			expect(git(dir, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
		}, 30_000);

		it("removes the worktree of a background run that /agents kill stops", async () => {
			const dir = repo();
			const s = setup(dir);
			const started = await s.run({ task: "slow isolated", isolate: true, background: true });
			const id = started.details.id as string;
			await vi.waitFor(() => expect(leftovers(dir).length).toBeGreaterThan(0));
			await s.commands.get("agents").handler(`kill ${id}`, s.ctx);
			await vi.waitFor(() => expect(s.sent.at(-1)?.message.content).toContain("cancelled by the user"));
			expect(s.sent.at(-1)?.message.content).toContain(id);
			expect(leftovers(dir)).toEqual([]);
		}, 30_000);
	});
});

describe("isolated subagents share the leading prompt", () => {
	it("passes the main checkout as the prompt root and names the worktree in the task", async () => {
		const dir = repo();
		const s = setup(dir);
		const a = reportOf((await s.run({ task: "report one", isolate: true })).content[0].text);
		const b = reportOf((await s.run({ task: "report two", isolate: true })).content[0].text);
		// The real cwd (tools, permissions) is each worktree; only the prompt text names the main checkout.
		expect(a.cwd).not.toBe(b.cwd);
		// The child's cwd is the resolved path of its worktree (a symlinked temp directory differs in its prefix).
		expect(a.cwd.endsWith(a.worktreeRoot)).toBe(true);
		expect(a.worktreeRoot).not.toBe(dir);
		expect(a.promptRoot).toBe(dir);
		expect(b.promptRoot).toBe(dir);
		expect(a.task).toContain(a.worktreeRoot);
		expect(a.task).toContain(dir);
		const plain = reportOf((await s.run({ task: "report plain" })).content[0].text);
		expect(plain.promptRoot).toBeUndefined();
		expect(plain.task).not.toContain(a.worktreeRoot);
	}, 30_000);
});

describe("trust for isolated subagents", () => {
	it("never hands trust down by environment, and a session nobody can ask creates no worktree", async () => {
		const trusted = repo();
		const s = setup(trusted);
		const facts = reportOf((await s.run({ task: "report", isolate: true })).content[0].text);
		expect(facts).toMatchObject({ workspace: trusted });

		const undecided = repo();
		fs.mkdirSync(path.join(undecided, ".claude"));
		fs.writeFileSync(
			path.join(undecided, ".claude", "settings.json"),
			'{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"node"}]}]}}',
		);
		git(undecided, "add", "-A");
		git(undecided, "commit", "-q", "-m", "hooks");
		const u = setup(undecided);
		const child = reportOf((await u.run({ task: "report", isolate: true })).content[0].text);
		expect(child).toMatchObject({ workspace: undecided });

		// No UI to ask and no `--trust`: the worktree is refused before it is created.
		const headless = setup(repo(), false);
		await expect(headless.run({ task: "report", isolate: true })).rejects.toThrow(/--trust/u);
	}, 30_000);
});

describe("a start that fails after the child joined its step's group", () => {
	it("leaves the group, foreground and background alike", async () => {
		const join = vi.spyOn(ReportGroups.prototype, "join");
		const leave = vi.spyOn(ReportGroups.prototype, "leave");
		try {
			// No UI to ask and no `--trust`: the worktree is refused inside the start, after the claim joined the group.
			const headless = setup(repo(), false);
			await expect(headless.run({ task: "report", isolate: true })).rejects.toThrow(/--trust/u);
			await expect(headless.run({ task: "report", isolate: true, background: true })).rejects.toThrow(/--trust/u);
			const joined = join.mock.calls.map(([id]) => id);
			expect(joined).toHaveLength(2);
			for (const id of joined) expect(leave.mock.calls.map(([left]) => left)).toContain(id);
		} finally {
			join.mockRestore();
			leave.mockRestore();
		}
	}, 30_000);
});

describe("orphaned worktrees at session start", () => {
	it("saves what it can under the actual ref name and warns about a worktree it had to keep", async () => {
		const dir = repo();
		const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
		git(dir, "update-ref", "refs/octocode/orphan-7", "HEAD");
		const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
		const yes = async () => true;
		const [saved, stuck] = [
			await createWorktree(dir, "orphan-7", undefined, false, undefined, yes),
			await createWorktree(dir, "stuck-7", undefined, false, undefined, yes),
		];
		for (const worktree of [saved, stuck]) {
			fs.writeFileSync(path.join(worktree.path, `${worktree.agentId}.txt`), "work\n");
			const meta = `${worktree.path}.json`;
			fs.writeFileSync(meta, JSON.stringify({ ...JSON.parse(fs.readFileSync(meta, "utf8")), owners: [{ pid: dead }] }));
		}
		fs.writeFileSync(path.join(git(stuck.path, "rev-parse", "--absolute-git-dir"), "index.lock"), "");
		const s = setup(dir);
		await s.emit("session_start", {}, s.ctx);
		await vi.waitFor(() => expect(s.ctx.ui.notes.some((note) => note.type === "warning")).toBe(true));
		const note = s.ctx.ui.notes.find((entry) => entry.type === "warning")!.message;
		expect(note).toContain("orphan-7 (changes on refs/octocode/orphan-7-2)");
		expect(note).toContain(`Kept orphaned subagent worktree stuck-7`);
		expect(note).toContain(stuck.path);
		expect(fs.existsSync(path.join(stuck.path, "stuck-7.txt"))).toBe(true);
	}, 30_000);
});
