import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Member } from "@octocodeai/octocode-contracts/team";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/features/index.ts";
import { registerWorktreeFooter, worktreeFooterText } from "../../src/octocode/worktrees/footer.ts";
import { GIT_TEST_ENV, makeRepo, sh, type TestRepo } from "./worktree-fixture.ts";

const saved = { ...process.env };
let repo: TestRepo;

const member = (id: string, checkout: string | undefined): Member => ({
	id,
	role: "main",
	pid: 4242,
	status: "idle",
	joinedAt: 1,
	updatedAt: 1,
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
	...(checkout ? { checkout } : {}),
});

beforeEach(() => {
	Object.assign(process.env, GIT_TEST_ENV);
	repo = makeRepo();
});
afterEach(() => {
	process.env = { ...saved };
	repo.cleanup();
});

describe("worktreeFooterText", () => {
	it("is empty in a repository with no other worktree", () => {
		expect(worktreeFooterText(undefined, "/r", [])).toBeUndefined();
		expect(worktreeFooterText(undefined, "/r", [member("a", "/r"), member("old", undefined)])).toBeUndefined();
	});

	it("names a linked worktree", () => {
		expect(worktreeFooterText("hotfix", "/r/.octocode/worktrees/hotfix", [])).toBe("worktree hotfix");
	});

	it("counts agents and the worktrees they are in, in any checkout", () => {
		const members = [member("me", "/r"), member("a", "/w/x"), member("b", "/w/x"), member("c", "/w/y")];
		expect(worktreeFooterText(undefined, "/r", members)).toBe("+3 agents in 2 worktrees");
		expect(worktreeFooterText("x", "/w/x", members)).toBe("worktree x · +2 agents in 2 worktrees");
		expect(worktreeFooterText(undefined, "/r", [member("a", "/w/x")])).toBe("+1 agent in 1 worktree");
	});
});

describe("registerWorktreeFooter", () => {
	function harness() {
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
		const api = { on: (name: string, handler: never) => void handlers.set(name, handler) } as unknown as ExtensionAPI;
		const statuses: Array<string | undefined> = [];
		const ctxAt = (cwd: string) =>
			({
				cwd,
				ui: { setStatus: (_key: string, value?: string) => void statuses.push(value) },
			}) as unknown as ExtensionContext;
		let listener: (() => void) | undefined;
		let stops = 0;
		const team = {
			view: { members: [] as Member[], traffic: [] },
			watch: (callback: () => void) => {
				listener = callback;
				callback();
				return () => void (stops++, (listener = undefined));
			},
		};
		registerWorktreeFooter(api, team);
		const start = (cwd: string) => handlers.get("session_start")?.({ type: "session_start" }, ctxAt(cwd));
		return {
			team,
			statuses,
			start,
			shutdown: () => handlers.get("session_shutdown")?.({}, ctxAt("/")),
			tick: () => listener?.(),
			stops: () => stops,
		};
	}

	it("shows nothing in a repository without linked worktrees", async () => {
		const h = harness();
		await h.start(repo.root);
		h.tick();
		expect(h.statuses).toEqual([]);
	});

	it("shows the folder name in a linked worktree", async () => {
		const folder = path.join(repo.root, ".octocode", "worktrees", "hotfix");
		sh(repo.root, "worktree", "add", "-q", "-b", "worktree-hotfix", folder);
		const h = harness();
		await h.start(folder);
		expect(h.statuses).toEqual(["worktree hotfix"]);
	});

	it("follows the team's ticks: writes only when the text changes, and clears it when the agents leave", async () => {
		const other = path.join(repo.root, ".octocode", "worktrees", "b");
		sh(repo.root, "worktree", "add", "-q", "-b", "worktree-b", other);
		const h = harness();
		await h.start(repo.root);
		h.team.view.members = [member("me", repo.root), member("x", other)];
		h.tick();
		h.tick();
		h.team.view.members = [member("me", repo.root)];
		h.tick();
		expect(h.statuses).toEqual(["+1 agent in 1 worktree", undefined]);
	});

	it("stops watching when the session ends or restarts", async () => {
		const h = harness();
		await h.start(repo.root);
		await h.start(repo.root);
		expect(h.stops()).toBe(1);
		await h.shutdown();
		expect(h.stops()).toBe(2);
	});

	it("shows nothing outside a repository", async () => {
		const h = harness();
		await h.start(path.dirname(repo.root));
		expect(h.statuses).toEqual([]);
	});
});
