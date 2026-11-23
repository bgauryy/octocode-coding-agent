import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../src/core/features/index.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../src/core/slash-commands.ts";
import { realmCommand } from "../../src/octocode/realm/command.ts";
import { buildRealms, findRealm, type RealmFolder, type RealmSession } from "../../src/octocode/realm/model.ts";
import { realmSession } from "../../src/octocode/realm/sessions.ts";
import type { SessionExtra } from "../../src/octocode/sessions/store.ts";
import { worktreesDir } from "../../src/octocode/worktree-paths/own-worktree.ts";
import { GIT_TEST_ENV, makeRepo, sh, type TestRepo } from "./worktree-fixture.ts";

const saved = { ...process.env };
let repo: TestRepo;
let home: string;
let notices: Array<{ text: string; level: string }>;
let stderr: string;
const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const output = () => notices.map((notice) => notice.text).join("\n");

function member(id: string, extra: Partial<Member> = {}): Member {
	return {
		id,
		role: "implementer",
		pid: 4000,
		status: "working",
		model: "opus-5-5",
		joinedAt: NOW - 12 * 60_000,
		updatedAt: NOW - 60_000,
		toolCalls: 3,
		input: 30_000,
		cacheRead: 0,
		output: 4_000,
		cost: 0.4,
		unpriced: false,
		...extra,
	};
}

const session = (id: string, cwd: string, extra: Partial<RealmSession> = {}): RealmSession => ({
	id,
	cwd,
	modified: NOW - 5 * 60_000,
	live: false,
	current: false,
	file: `/sessions/${id}.jsonl`,
	...extra,
});

interface ContextOptions {
	hasUI?: boolean;
	idle?: boolean;
	select?: (title: string, options: string[]) => Promise<string | undefined>;
	pickSession?: NonNullable<CommandContext["ui"]["pickSession"]>;
}

function contextAt(cwd: string, options: ContextOptions = {}) {
	const newSession = vi.fn(async () => ({ cancelled: false }));
	const switchSession = vi.fn(async () => ({ cancelled: false }));
	const select = vi.fn(options.select ?? (async () => undefined));
	const confirm = vi.fn(async () => true);
	const ctx = {
		cwd,
		hasUI: options.hasUI ?? false,
		ui: {
			notify: (text: string, level = "info") => void notices.push({ text, level }),
			select,
			confirm,
			...(options.pickSession ? { pickSession: options.pickSession } : {}),
		},
		isIdle: () => options.idle ?? true,
		newSession,
		switchSession,
	} as unknown as CommandContext;
	return { ctx, newSession, switchSession, select, confirm };
}

const worktreeFolder = (name: string) => path.join(repo.root, ".octocode", "agent", "worktrees", name);
const addWorktree = (name: string) =>
	sh(repo.root, "worktree", "add", "-q", "-b", `worktree-${name}`, worktreeFolder(name));

beforeEach(() => {
	Object.assign(process.env, GIT_TEST_ENV);
	home = mkdtempSync(path.join(tmpdir(), "octocode-realm-home-"));
	process.env.OCTOCODE_HOME = home;
	notices = [];
	stderr = "";
	vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
		stderr += String(chunk);
		return true;
	});
	repo = makeRepo();
});
afterEach(() => {
	vi.restoreAllMocks();
	process.env = { ...saved };
	repo.cleanup();
	rmSync(home, { recursive: true, force: true });
});

describe("/realm listing", () => {
	it("lists the checkout, a worktree, a gone worktree and a live session in no realm", async () => {
		addWorktree("hotfix");
		addWorktree("old");
		rmSync(worktreeFolder("old"), { recursive: true });
		repo.write("a.txt", "changed\n");
		const members = [
			member("calm-prawn", { role: "main", checkout: repo.root, cwd: repo.root }),
			member("busy-eel", { parentId: "calm-prawn", checkout: repo.root, cwd: worktreeFolder("hotfix") }),
			member("lost-owl", { role: "main", status: "idle" }),
		];
		const sessions = [
			session("s-main-1", repo.root, { live: true, current: true, name: "fixing things" }),
			session("s-hot-1", worktreeFolder("hotfix"), { live: true }),
			session("s-hot-2", worktreeFolder("hotfix")),
			session("s-far-1", "/somewhere/else", { live: true }),
		];
		const { ctx } = contextAt(repo.root);
		await realmCommand({ members: () => members, sessions: async () => sessions, now: () => NOW }).handler("", ctx);

		const text = output();
		expect(text).toContain("main · this repository's main checkout · branch main · 1 changed");
		expect(text).toContain("1 changed · 1 agent (1 working) · 1 live session");
		expect(text).toMatch(
			/hotfix · worktree · branch worktree-hotfix · clean · 1 agent \(1 working\) · 1 live session ·/,
		);
		expect(text).toContain("✗ broken  old · worktree (gone)");
		expect(text).toContain("git worktree prune");
		expect(text).toContain("current");
		// Section (c): the agent with no folder and the live session whose folder is in no realm.
		expect(text).toContain("Other live agents and sessions in this repository");
		expect(text).toContain("lost-owl");
		expect(text).toContain("/somewhere/else");
		// The legend names only the badge states shown.
		expect(text).toContain("✓ ready  ✗ broken");
		expect(text).not.toContain("∅ off");
	});

	it("prints text without a UI and opens no picker", async () => {
		const { ctx, select } = contextAt(repo.root, { hasUI: false });
		await realmCommand({ members: () => [], sessions: async () => [], now: () => NOW }).handler("", ctx);
		expect(select).not.toHaveBeenCalled();
		expect(stderr).toContain("Realms of repo:");
		expect(stderr).toContain("main · this repository's main checkout");
	});

	it("still lists realms when the session list fails, and says why", async () => {
		const { ctx } = contextAt(repo.root);
		const sessions = async (): Promise<RealmSession[]> => {
			throw new Error("database is locked");
		};
		await realmCommand({ members: () => [], sessions, now: () => NOW }).handler("", ctx);
		expect(output()).toContain("main · this repository's main checkout");
		expect(output()).toContain("Sessions are not shown: database is locked");
	});

	it("shows one realm with its agents (model, status, time, tokens) and sessions", async () => {
		addWorktree("hotfix");
		const members = [member("busy-eel", { checkout: repo.root, cwd: worktreeFolder("hotfix") })];
		const sessions = [session("s-hot-2", worktreeFolder("hotfix"), { name: "old fix" })];
		const { ctx } = contextAt(repo.root);
		await realmCommand({ members: () => members, sessions: async () => sessions, now: () => NOW }).handler(
			"hotfix",
			ctx,
		);
		const text = output();
		expect(text).toContain("Realm hotfix — ✓ ready");
		expect(text).toContain("busy-eel · implementer · working · opus-5-5 · 12m here · 34k tokens · ≈$0.40 · pid 4000");
		expect(text).toContain("old fix · 5m ago");
		expect(text).toContain("last activity: 1m ago");
		expect(text).toContain("/realm hotfix switch moves this session here");
	});

	it("names the realms when the name is unknown", async () => {
		const { ctx } = contextAt(repo.root);
		await realmCommand({ members: () => [], sessions: async () => [], now: () => NOW }).handler("nope", ctx);
		expect(notices[0]).toMatchObject({ level: "warning" });
		expect(output()).toContain("No realm named nope. Realms: main");
	});

	it("is a built-in one-word command", () => {
		const realm = BUILTIN_SLASH_COMMANDS.find((command) => command.name === "realm");
		expect(realm?.requiresNative).toBe(true);
		expect(realm?.description.length).toBeLessThanOrEqual(50);
	});
});

describe("member placement", () => {
	const folder = (name: string, extra: Partial<RealmFolder> = {}): RealmFolder => ({
		path: `/repo/${name}`,
		kind: "worktree",
		gone: false,
		...extra,
	});
	const main = folder("", { path: "/repo", kind: "checkout" });

	it("puts an agent where its folder is, the innermost worktree first, and an isolated child in its private one", () => {
		const nested = folder(".octocode/agent/worktrees/a");
		const isolated = folder("agent-x", { path: "/home/octocode/worktrees/k/agent-x", kind: "isolated" });
		const view = buildRealms({
			main: "/repo",
			folders: [main, nested, isolated],
			members: [
				member("in-main", { checkout: "/repo", cwd: "/repo/src" }),
				member("in-a", { checkout: "/repo", cwd: "/repo/.octocode/agent/worktrees/a/src" }),
				// An isolated child's checkout is its coordinator's; only its cwd names the private worktree.
				member("child", { parentId: "in-main", checkout: "/repo", cwd: "/home/octocode/worktrees/k/agent-x" }),
				// An older row with a checkout and no cwd.
				member("old-row", { checkout: "/repo/.octocode/agent/worktrees/a" }),
				member("nowhere"),
			],
			sessions: [],
			here: "/repo",
		});
		const ids = (name: string) => findRealm(view, name)?.agents.map((agent) => agent.id);
		expect(ids("main")).toEqual(["in-main"]);
		expect(ids("a")).toEqual(["in-a", "old-row"]);
		expect(ids("agent-x")).toEqual(["child"]);
		expect(view.otherAgents.map((agent) => agent.id)).toEqual(["nowhere"]);
	});

	it("gives an agent working in a folder git no longer lists a realm of its own, marked gone", () => {
		const view = buildRealms({
			main: "/repo",
			folders: [main],
			members: [member("orphan", { checkout: "/vanished/tree", cwd: "/vanished/tree" })],
			sessions: [],
			here: "/repo",
		});
		const realm = findRealm(view, "tree");
		expect(realm?.folder.gone).toBe(true);
		expect(realm?.agents.map((agent) => agent.id)).toEqual(["orphan"]);
	});

	it("keeps names unique and resolves a unique prefix", () => {
		const view = buildRealms({
			main: "/repo",
			folders: [
				main,
				folder(".octocode/agent/worktrees/main"),
				folder("x/lint", { kind: "linked" }),
				folder("y/lint", { kind: "linked" }),
			],
			members: [],
			sessions: [],
			here: "/repo",
		});
		expect(view.realms.map((realm) => realm.name)).toEqual(["main", "main-2", "lint", "lint-2"]);
		expect(findRealm(view, "main-2")?.folder.path).toBe("/repo/.octocode/agent/worktrees/main");
		expect(findRealm(view, "lint")?.name).toBe("lint");
		expect(findRealm(view, "li")).toBeUndefined();
	});

	it("lists an isolated agent worktree as its own kind", async () => {
		const dir = worktreesDir(repo.root);
		mkdirSync(dir, { recursive: true });
		sh(repo.root, "worktree", "add", "-q", "--detach", path.join(dir, "agent-x"), "HEAD");
		const members = [member("agent-x", { parentId: "boss", checkout: repo.root, cwd: path.join(dir, "agent-x") })];
		const { ctx } = contextAt(repo.root);
		await realmCommand({ members: () => members, sessions: async () => [], now: () => NOW }).handler("", ctx);
		expect(output()).toMatch(/agent-x · isolated agent worktree · detached · clean · 1 agent \(1 working\)/);
	});
});

describe("/realm switch and resume", () => {
	const deps = (sessions: RealmSession[] = []) => ({
		members: () => [],
		sessions: async () => sessions,
		now: () => NOW,
	});

	it("switch hands the worktree to switchToWorktree", async () => {
		addWorktree("hotfix");
		const { ctx, newSession } = contextAt(repo.root);
		await realmCommand(deps()).handler("hotfix switch", ctx);
		expect(newSession).toHaveBeenCalledTimes(1);
		expect((newSession.mock.calls[0] as unknown[])[0]).toMatchObject({ cwd: worktreeFolder("hotfix") });
	});

	it("switch main from a worktree starts a session in the main checkout", async () => {
		addWorktree("hotfix");
		const { ctx, newSession } = contextAt(worktreeFolder("hotfix"));
		await realmCommand(deps()).handler("main switch", ctx);
		expect((newSession.mock.calls[0] as unknown[])[0]).toMatchObject({ cwd: repo.root });
	});

	it("refuses while a turn runs and starts nothing", async () => {
		addWorktree("hotfix");
		const { ctx, newSession } = contextAt(repo.root, { idle: false });
		await realmCommand(deps()).handler("hotfix switch", ctx);
		expect(newSession).not.toHaveBeenCalled();
		expect(notices.at(-1)).toMatchObject({ level: "warning" });
		expect(output()).toContain("A turn is running");
	});

	it("explains why a gone, isolated or linked realm cannot be entered", async () => {
		addWorktree("old");
		rmSync(worktreeFolder("old"), { recursive: true });
		const other = path.join(path.dirname(repo.root), "elsewhere");
		sh(repo.root, "worktree", "add", "-q", "-b", "side", other);
		const { ctx, newSession } = contextAt(repo.root);
		const command = realmCommand(deps());
		await command.handler("old switch", ctx);
		await command.handler("elsewhere switch", ctx);
		await command.handler("main switch", ctx);
		expect(newSession).not.toHaveBeenCalled();
		expect(output()).toContain("Cannot switch to old. Its folder is gone");
		expect(output()).toContain("Cannot switch to elsewhere. It was not made by /worktree new");
		expect(output()).toContain("Cannot switch to main. This session is already here.");
		rmSync(other, { recursive: true, force: true });
	});

	it("the page offers switch for an enterable realm and runs it", async () => {
		addWorktree("hotfix");
		const choices: string[][] = [];
		const select = async (_title: string, options: string[]) => {
			choices.push(options);
			return (
				options.find((option) => option.startsWith("Switch")) ?? options.find((option) => option.includes("hotfix"))
			);
		};
		const { ctx, newSession } = contextAt(repo.root, { hasUI: true, select });
		await realmCommand(deps()).handler("", ctx);
		expect(choices[0]).toHaveLength(2);
		expect(choices[1]).toEqual(["Switch this session to hotfix", "Back"]);
		expect(newSession).toHaveBeenCalledTimes(1);
		expect(stderr).toBe("");
	});

	it("resume opens the session picker scoped to the realm's sessions and switches to the pick", async () => {
		addWorktree("hotfix");
		const sessions = [session("s-hot-1", worktreeFolder("hotfix")), session("s-main-1", repo.root)];
		const pickSession = vi.fn(async (options: { onlySessions?: ReadonlySet<string> }) => ({
			id: "s-hot-1",
			path: "/sessions/s-hot-1.jsonl",
			onlyKeys: [...(options.onlySessions ?? [])],
		}));
		const { ctx, switchSession } = contextAt(repo.root, {
			hasUI: true,
			pickSession: pickSession as unknown as ContextOptions["pickSession"],
		});
		await realmCommand(deps(sessions)).handler("hotfix resume", ctx);
		expect([...((pickSession.mock.calls[0] as unknown[])[0] as { onlySessions: Set<string> }).onlySessions]).toEqual([
			"s-hot-1",
		]);
		expect(switchSession).toHaveBeenCalledWith("/sessions/s-hot-1.jsonl");
	});

	it("resume asks before taking a session another process has open", async () => {
		addWorktree("hotfix");
		const sessions = [session("s-hot-1", worktreeFolder("hotfix"), { live: true })];
		const pickSession = async () => ({ id: "s-hot-1", path: "/sessions/s-hot-1.jsonl" });
		const { ctx, switchSession, confirm } = contextAt(repo.root, {
			hasUI: true,
			pickSession: pickSession as unknown as ContextOptions["pickSession"],
		});
		confirm.mockResolvedValueOnce(false);
		await realmCommand(deps(sessions)).handler("hotfix resume", ctx);
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(switchSession).not.toHaveBeenCalled();
		expect(output()).toContain("Cancelled: nothing was resumed.");
	});

	it("resume without a UI lists the realm's session ids as text", async () => {
		addWorktree("hotfix");
		const sessions = [session("s-hot-1", worktreeFolder("hotfix"), { live: true, name: "fix" })];
		const { ctx, switchSession } = contextAt(repo.root);
		await realmCommand(deps(sessions)).handler("hotfix resume", ctx);
		expect(switchSession).not.toHaveBeenCalled();
		// Before: "Sessions started in hotfix (open one with /resume all <id>):" then "  live fix · s-hot-1".
		expect(stderr).toContain("Sessions started in hotfix:\n  live  fix · s-hot-1\n→ open one with /resume all <id>");
	});

	it("rejects an unknown action", async () => {
		const { ctx } = contextAt(repo.root);
		await realmCommand(deps()).handler("main destroy", ctx);
		expect(output()).toBe("Usage: /realm [<name> [switch|resume]]");
	});
});

describe("each live session's activity light in /realm", () => {
	const deps = (sessions: RealmSession[]) => ({ members: () => [], sessions: async () => sessions, now: () => NOW });
	const extra = (fields: Partial<SessionExtra>): SessionExtra => ({
		id: "s",
		workspace_id: null,
		branch: null,
		head: null,
		cost: 0,
		tokens: 0,
		files_changed: 0,
		pid: null,
		pid_started: null,
		unpriced: 0,
		dir: null,
		activity: null,
		...fields,
	});
	const info = { id: "s-hot-1", name: "fix", cwd: "", modified: new Date(NOW - 5 * 60_000), path: "/s/s-hot-1.jsonl" };

	it("reads the light another live process wrote, never this session's own or a gone process's", () => {
		const live = extra({ pid: process.pid, activity: "waiting" });
		expect(realmSession(info, live, "cur", "/w")).toMatchObject({ live: true, activity: "waiting", cwd: "/w" });
		expect(realmSession({ ...info, id: "cur" }, live, "cur", "/w")).not.toHaveProperty("activity");
		const gone = realmSession(info, extra({ pid: 2147483646, activity: "waiting" }), "cur", "/w");
		expect(gone).toMatchObject({ live: false });
		expect(gone).not.toHaveProperty("activity");
	});

	it("shows it beside the live mark in the realm page and in the resume list", async () => {
		addWorktree("hotfix");
		const sessions = [session("s-hot-1", worktreeFolder("hotfix"), { live: true, name: "fix", activity: "waiting" })];
		const page = contextAt(repo.root);
		await realmCommand(deps(sessions)).handler("hotfix", page.ctx);
		expect(output()).toContain("live (needs you) fix · 5m ago");
		const { ctx } = contextAt(repo.root);
		await realmCommand(deps(sessions)).handler("hotfix resume", ctx);
		expect(stderr).toContain("  live (needs you)  fix · s-hot-1");
	});
});
