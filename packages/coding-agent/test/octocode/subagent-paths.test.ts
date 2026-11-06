import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as NativeConfig from "../../src/config.ts";
import { processStartTime } from "../../src/octocode/shared/process.ts";
import { MAX_SUBAGENTS_ENV } from "../../src/octocode/subagents/claim.ts";
import { subagentProcessEnv } from "../../src/octocode/subagents/process/env.ts";
import type { AgentProfile } from "../../src/octocode/subagents/profiles.ts";
import { registerAgentTool } from "../../src/octocode/subagents/tool.ts";
import { heldChildMember } from "../../src/octocode/team/identity.ts";
import { PeerLeases } from "../../src/octocode/team/peer-leases.ts";
import { namedParent } from "../../src/octocode/team/session/parent.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { AGENT_ID_ENV, PARENT_ID_ENV, PARENT_PID_ENV } from "../../src/octocode/team/store/env.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { registerCollab } from "../../src/octocode/team/tools.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { fakeCachePolicy, fakeCtx, fakeHost, fakePermission } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const FIXTURE = path.join(import.meta.dirname, "subagent-fake-host.cjs");
const SOURCE_RESOLVER = path.join(import.meta.dirname, "..", "..", "scripts", "source-resolver.ts");
const WORKER = path.join(import.meta.dirname, "fixtures", "team-child-takeover-worker.ts");
const savedArgv = process.argv[1];
const savedEnv = { ...process.env };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

beforeAll(() => {
	const root = tmp("octocode-agent-paths-");
	for (const key of Object.keys(process.env)) if (key.startsWith("OCTOCODE_")) delete process.env[key];
	Object.assign(process.env, {
		OCTOCODE_HOME: path.join(root, "home"),
		OCTOCODE_AGENT_DB: path.join(root, "team", "team.sqlite"),
	});
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	fs.copyFileSync(FIXTURE, path.join(bin, "octocode"));
	process.argv[1] = path.join(bin, "octocode");
});

afterAll(() => {
	process.argv[1] = savedArgv!;
	process.env = savedEnv;
});

const member = (id: string, extra: Partial<Member> = {}): Member => ({
	id,
	role: "peer",
	pid: process.pid,
	status: "working",
	joinedAt: 1_000,
	updatedAt: Date.now(),
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
	...extra,
});

const profiles = new Map<string, AgentProfile>([
	["reviewer", { name: "reviewer", description: "reads", prompt: "Review only.", readOnly: true }],
]);

const open: TeamStore[] = [];
const teams: Team[] = [];
const processes: ChildProcess[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const team of teams.splice(0)) team.stop();
	// One database for the whole file: rows of this test do not leak into the next one's team.
	for (const store of open.splice(0)) {
		for (const id of store.names()) store.remove(id);
		store.close();
	}
	for (const child of processes.splice(0)) child.kill("SIGKILL");
});

function setup(cwd = fs.realpathSync(tmp("octocode-paths-cwd-"))) {
	const f = fakeHost();
	const team = new Team(f.api);
	teams.push(team);
	const control = registerAgentTool(f.api, () => profiles, team, fakePermission());
	const ctx = fakeCtx({ cwd, hasUI: true });
	Object.assign(ctx.ui, { confirm: async () => true });
	const model = { provider: "faux", id: "model", reasoning: true };
	Object.assign(ctx, {
		model,
		modelRegistry: {
			getAvailable: () => [model],
			find: () => model,
			getCachePolicy: fakeCachePolicy,
			getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
		},
	});
	team.start(ctx);
	team.join();
	const agent = f.tools.get("agent");
	const run = (params: Record<string, unknown>, signal?: AbortSignal) =>
		agent.execute("call-1", { goal: "check things", ...params }, signal, undefined, ctx);
	const store = TeamStore.open(cwd, process.env.OCTOCODE_AGENT_DB);
	open.push(store);
	/** The reservations in this checkout, as another process reads them. */
	const leases = () => store.leases().map((lease) => ({ path: lease.path, kind: lease.kind, owner: lease.owner }));
	const rows = () => store.names().filter((id) => id !== team.id);
	return { ...f, team, control, ctx, run, cwd, store, leases, rows };
}

const textOf = (result: { content: Array<{ text?: string }> }) => result.content[0]?.text ?? "";

describe("a task without paths", () => {
	it("reserves nothing, adds no row and says nothing about reservations", async () => {
		const s = setup();
		const reserve = vi.spyOn(s.team.childLeases, "reserve");
		const result = await s.run({ task: "report back" });
		expect(reserve).not.toHaveBeenCalled();
		expect(textOf(result)).not.toMatch(/[Rr]eserved/);
		expect(textOf(result)).not.toContain("Reserved for you");
		const slow = await s.run({ task: "slow background", background: true });
		// Mid-run: no lease, and no row the parent wrote (this stand-in child never joins).
		expect(s.leases()).toEqual([]);
		expect(s.rows()).toEqual([]);
		expect(textOf(slow)).not.toMatch(/[Rr]eserved/);
		await s.control.stopAll();
	});

	it("treats an empty list as none", async () => {
		const s = setup();
		const reserve = vi.spyOn(s.team.childLeases, "reserve");
		expect(textOf(await s.run({ task: "report back", paths: [] }))).not.toMatch(/[Rr]eserved/);
		expect(textOf(await s.run({ task: "report back", paths: ["  "] }))).not.toMatch(/[Rr]eserved/);
		expect(reserve).not.toHaveBeenCalled();
	});
});

describe("reserving at the start", () => {
	it("holds the paths for the child, against other agents and the parent, and tells both", async () => {
		const s = setup();
		const started = await s.run({
			task: "slow background",
			goal: "rewrite the parser",
			background: true,
			paths: ["a.ts", "src/"],
		});
		const id = started.details.id as string;
		expect(textOf(started)).toContain("Reserved until it reports: a.ts, src/.");
		expect(s.leases()).toEqual([
			{ path: "a.ts", kind: "file", owner: id },
			{ path: "src", kind: "tree", owner: id },
		]);
		// The parent's process holds the child's row until the child joins; another process does not take it for abandoned.
		expect(s.store.conflict(path.join(s.cwd, "src/x.ts"), "someone")?.owner).toBe(id);
		s.store.sweep();
		expect(s.rows()).toEqual([id]);
		expect(s.team.members().find((each) => each.id === id)).toMatchObject({
			goal: "rewrite the parser",
			parentId: s.team.id,
			locks: ["a.ts", "src/"],
		});
		expect(s.team.reservation(path.join(s.cwd, "a.ts"), "a.ts")).toContain(`reserved by ${id} (rewrite the parser`);
		await s.control.stopAll();
	});

	it("names the paths in the child's assignment", async () => {
		const s = setup();
		const result = await s.run({ task: "echo whole task", paths: ["a.ts", "src/"] });
		expect(textOf(result)).toContain(
			"Reserved for you until you report, so other agents cannot edit them: `a.ts`, `src/`; they need no `coordinate` lock or unlock.",
		);
	});

	it("folds a repeated path and one a named tree covers", async () => {
		const s = setup();
		const started = await s.run({
			task: "slow background",
			background: true,
			paths: ["src/a.ts", "src/", "b.ts", "./b.ts", "src"],
		});
		expect(textOf(started)).toContain("Reserved until it reports: src/, b.ts.");
		expect(s.leases().map((lease) => `${lease.kind}:${lease.path}`)).toEqual(["tree:src", "file:b.ts"]);
		await s.control.stopAll();
	});

	it("renews what it holds for a child with its own heartbeat", async () => {
		const s = setup();
		await s.run({ task: "slow background", background: true, paths: ["a.ts"] });
		const expiry = () => s.store.leases()[0]?.expiresAt ?? 0;
		const before = expiry();
		s.team.childLeases.renew(s.store, Date.now() + 60_000);
		expect(expiry()).toBeGreaterThan(before);
		const renew = vi.spyOn(s.team.childLeases, "renew");
		s.team.join();
		expect(renew).toHaveBeenCalledTimes(1);
		await s.control.stopAll();
	});
});

describe("a conflict at the start", () => {
	it("starts nothing and names the holder and its goal; a free path and a task without paths still run", async () => {
		const s = setup();
		s.store.save(member("peer-one", { goal: "fix the auth flow" }));
		expect(s.store.lock("peer-one", [{ path: "a.ts", kind: "file", reason: "token refresh" }])).toMatchObject({
			ok: true,
		});
		const refused = s.run({ task: "report back", paths: ["a.ts", "b.ts"] });
		await expect(refused).rejects.toThrow(/No subagent started/);
		await expect(s.run({ task: "report back", paths: ["a.ts"] })).rejects.toThrow(
			/a\.ts is covered by peer-one, working on "fix the auth flow" \(a\.ts: token refresh; locked/,
		);
		expect(s.control.running()).toEqual([]);
		// All or none: the free path was not reserved.
		expect(s.leases().map((lease) => lease.path)).toEqual(["a.ts"]);
		expect(textOf(await s.run({ task: "report back", paths: ["b.ts"] }))).toContain("Reserved until it reports: b.ts.");
		expect((await s.run({ task: "report back" })).details.status).toBe("done");
	});

	it("queues a sibling started after it, tree against file, naming the first child (B204; it used to refuse)", async () => {
		const s = setup();
		const first = await s.run({ task: "slow background", goal: "rewrite src", background: true, paths: ["src/"] });
		const id = first.details.id as string;
		const queued = await s.run({ task: "report back", background: true, paths: ["src/a.ts"] });
		expect(textOf(queued)).toContain(`waiting for ${id} to report before it reserves src/a.ts`);
		expect(queued.details.queued).toBe(true);
		expect(s.leases().map((lease) => lease.owner)).toEqual([id]);
		await s.control.stopAll();
	});

	it("gives the slot and the name back when the conflict appears only at the claim", async () => {
		process.env[MAX_SUBAGENTS_ENV] = "1";
		try {
			const s = setup();
			s.store.save(member("peer-one", { goal: "fix auth" }));
			s.store.lock("peer-one", [{ path: "a.ts", kind: "file", reason: "r" }]);
			vi.spyOn(s.team.childLeases, "conflicts").mockReturnValue([]);
			await expect(s.run({ task: "report back", paths: ["a.ts"] })).rejects.toThrow(/covered by peer-one/);
			expect(s.control.running()).toEqual([]);
			expect(s.rows()).toEqual(["peer-one"]);
			await expect(s.run({ task: "report back" })).resolves.toMatchObject({ details: { status: "done" } });
		} finally {
			delete process.env[MAX_SUBAGENTS_ENV];
		}
	});

	it("tells a parent holding the path itself to unlock", async () => {
		const s = setup();
		s.team.lock(["a.ts"], "mine");
		await expect(s.run({ task: "report back", paths: ["a.ts"] })).rejects.toThrow(
			new RegExp(`covered by ${s.team.id}[^]*unlock if the holder is you`),
		);
		s.team.unlock(["a.ts"]);
		expect(textOf(await s.run({ task: "report back", paths: ["a.ts"] }))).toContain("Reserved until it reports");
	});

	it("refuses a path an agent outside the team holds, tree requests included", async () => {
		const s = setup();
		const conflict = vi.spyOn(PeerLeases.prototype, "conflict").mockImplementation((_file, kind) =>
			kind === "tree"
				? {
						id: 1,
						path: "src/a.ts",
						kind: "file",
						owner: "s1",
						reason: "auth",
						acquiredAt: Date.now(),
						expiresAt: Date.now() + 60_000,
						name: "cc",
						vendor: "claude",
					}
				: undefined,
		);
		await expect(s.run({ task: "report back", paths: ["src/"] })).rejects.toThrow(
			/src\/ is covered by cc \(src\/a\.ts: claude agent: auth; locked/,
		);
		expect(s.control.running()).toEqual([]);
		expect(conflict).toHaveBeenCalled();
	});

	it("names the holder's goal in a coordinate lock refusal too", async () => {
		const s = setup();
		registerCollab(s.api, s.team, { stopAgent: (id, by) => s.control.stop(id, by) });
		s.store.save(member("peer-one", { goal: "fix the auth flow" }));
		s.store.lock("peer-one", [{ path: "a.ts", kind: "file", reason: "token refresh" }]);
		await expect(
			s.tools.get("coordinate").execute("c", { action: "lock", paths: ["a.ts"] }, undefined, undefined, s.ctx),
		).rejects.toThrow(/covered by peer-one, working on "fix the auth flow"/);
	});
});

describe("releasing when the run ends", () => {
	const reservedThen = async (s: ReturnType<typeof setup>, end: () => unknown) => {
		await vi.waitFor(() => expect(s.leases()).toHaveLength(1));
		await end();
		expect(s.leases()).toEqual([]);
		expect(s.rows()).toEqual([]);
	};

	it("at a foreground report", async () => {
		const s = setup();
		const result = await s.run({ task: "report back", paths: ["a.ts"] });
		expect(result.details.status).toBe("done");
		expect(s.leases()).toEqual([]);
		expect(s.rows()).toEqual([]);
		// The path is free for the next child at once.
		expect((await s.run({ task: "report back", paths: ["a.ts"] })).details.status).toBe("done");
	});

	it("at a background report", async () => {
		const s = setup();
		await s.run({ task: "report back", background: true, paths: ["a.ts"] });
		await s.control.settle();
		expect(s.leases()).toEqual([]);
		expect(s.rows()).toEqual([]);
	});

	it("when a child fails, foreground or background", async () => {
		const s = setup();
		expect((await s.run({ task: "auth error", paths: ["a.ts"] })).isError).toBe(true);
		expect(s.leases()).toEqual([]);
		await expect(s.run({ task: "fail", paths: ["a.ts"] })).rejects.toThrow(/boom/);
		expect(s.leases()).toEqual([]);
		await s.run({ task: "fail", background: true, paths: ["a.ts"] });
		await s.control.settle();
		expect(s.leases()).toEqual([]);
		expect(s.rows()).toEqual([]);
	});

	it("when a child crashes before its first turn", async () => {
		const s = setup();
		await expect(s.run({ task: "startup crash", paths: ["a.ts"] })).rejects.toThrow(/startup/);
		expect(s.leases()).toEqual([]);
		expect(s.rows()).toEqual([]);
	});

	it("when setup fails after the claim", async () => {
		const s = setup();
		const { events } = s.api;
		Object.assign(s.api, {
			events: {
				...events,
				emit: () => {
					throw new Error("event bus broke");
				},
			},
		});
		await expect(s.run({ task: "report back", paths: ["a.ts"] })).rejects.toThrow("event bus broke");
		Object.assign(s.api, { events });
		expect(s.leases()).toEqual([]);
		expect(s.rows()).toEqual([]);
	});

	it("when the user aborts a foreground child", async () => {
		const s = setup();
		const abort = new AbortController();
		const running = s.run({ task: "slow foreground", paths: ["a.ts"] }, abort.signal);
		await reservedThen(s, async () => {
			abort.abort();
			await expect(running).rejects.toThrow();
		});
	});

	it("when a background child is stopped", async () => {
		const s = setup();
		const { details } = await s.run({ task: "slow background", background: true, paths: ["a.ts"] });
		await reservedThen(s, async () => {
			expect(s.control.stop(details.id, "the parent")).toBeUndefined();
			await s.control.settle();
		});
	});

	it("at session shutdown", async () => {
		const s = setup();
		await s.run({ task: "slow at shutdown", background: true, paths: ["a.ts"] });
		await reservedThen(s, () => s.emit("session_shutdown", {}, s.ctx));
	});

	it("when the session ends with a child still closing", () => {
		const s = setup();
		expect(s.team.childLeases.reserve({ id: "kid-one", role: "general", goal: "g" }, ["a.ts"])).toMatchObject({
			ok: true,
		});
		expect(s.leases()).toHaveLength(1);
		s.team.stop();
		expect(s.leases()).toEqual([]);
		expect(s.store.names()).not.toContain("kid-one");
		// A release that arrives after that has nothing left to do.
		expect(() => s.team.childLeases.release("kid-one")).not.toThrow();
	});

	it("drops a child's leases, not its row, when the row names the child's own process", () => {
		const s = setup();
		s.team.childLeases.reserve({ id: "kid-one", role: "general", goal: "g" }, ["a.ts"]);
		const started = processStartTime(process.ppid);
		expect(
			s.store.join(member("kid-one", { pid: process.ppid, ...(started ? { started } : {}) }), {
				pid: process.pid,
				...(processStartTime(process.pid) ? { started: processStartTime(process.pid)! } : {}),
			}),
		).toBe(true);
		s.team.childLeases.release("kid-one");
		expect(s.leases()).toEqual([]);
		expect(s.store.names()).toContain("kid-one");
	});

	it("goes with the parent's process when it dies before the child joins", () => {
		const s = setup();
		const dead = 2 ** 22 + 4242;
		const row = heldChildMember(
			member("gone-parent", { pid: dead }),
			{ id: "kid-two", role: "general", goal: "g" },
			Date.now(),
		);
		s.store.lock("kid-two", [{ path: "a.ts", kind: "file", reason: "g" }], Date.now(), row);
		expect(s.store.conflict(path.join(s.cwd, "a.ts"), "someone")).toBeUndefined();
		expect(s.leases()).toEqual([]);
	});
});

describe("not reserving", () => {
	it("an isolated child: it has its own worktree, so a held path neither refuses it nor is reserved", async () => {
		const cwd = fs.realpathSync(tmp("octocode-paths-repo-"));
		git(cwd, "init", "-q", "-b", "main");
		git(cwd, "config", "user.name", "Test");
		git(cwd, "config", "user.email", "test@example.com");
		fs.writeFileSync(path.join(cwd, "a.txt"), "one\n");
		git(cwd, "add", "-A");
		git(cwd, "commit", "-q", "-m", "init");
		const s = setup(cwd);
		s.store.save(member("peer-one", { goal: "fix auth" }));
		s.store.lock("peer-one", [{ path: "a.txt", kind: "file", reason: "r" }]);
		const reserve = vi.spyOn(s.team.childLeases, "reserve");
		const result = await s.run({ task: "report back", isolate: true, paths: ["a.txt", "b.txt"] });
		expect(result.details.status).toBe("done");
		expect(textOf(result)).toContain("paths not reserved: an isolated child edits its own worktree");
		expect(reserve).not.toHaveBeenCalled();
		expect(s.leases()).toEqual([{ path: "a.txt", kind: "file", owner: "peer-one" }]);
	});

	it("a read-only profile: its gate already refuses source writes", async () => {
		const s = setup();
		s.store.save(member("peer-one", { goal: "fix auth" }));
		s.store.lock("peer-one", [{ path: "a.ts", kind: "file", reason: "r" }]);
		const result = await s.run({ task: "report back", profile: "reviewer", paths: ["a.ts"] });
		expect(result.details.status).toBe("done");
		expect(textOf(result)).toContain("paths not reserved: profile reviewer is read-only");
		expect(s.leases().map((lease) => lease.owner)).toEqual(["peer-one"]);
	});
});

describe("failing open", () => {
	it("starts the child and says why when the database cannot take the reservation", async () => {
		const s = setup();
		vi.spyOn(s.team.childLeases, "conflicts").mockImplementation(() => {
			throw new Error("database is locked");
		});
		vi.spyOn(s.team.childLeases, "reserve").mockImplementation(() => {
			throw new Error("database is locked");
		});
		const result = await s.run({ task: "report back", paths: ["a.ts"] });
		expect(result.details.status).toBe("done");
		expect(textOf(result)).toContain("paths not reserved: database is locked");
		expect(s.leases()).toEqual([]);
	});

	it("starts the child without the team when its database is unusable", async () => {
		const s = setup();
		vi.spyOn(s.team, "join").mockImplementation(() => {
			throw new Error("Team database unavailable: locked");
		});
		const result = await s.run({ task: "report back", paths: ["a.ts"] });
		expect(result.details.status).toBe("done");
		expect(textOf(result)).toContain("paths not reserved: it runs without the team");
	});
});

describe("the child's process taking its row over", () => {
	it("reads the parent's process back from the environment a child gets", () => {
		const env = subagentProcessEnv(undefined, {}, { id: "kid-one" });
		const started = processStartTime(process.pid);
		expect(namedParent(env)).toEqual({ pid: process.pid, ...(started ? { started } : {}) });
		expect(namedParent({})).toBeUndefined();
	});

	it("keeps the reservation, in another real process, and it ends when that process leaves", async () => {
		const s = setup();
		s.team.childLeases.reserve({ id: "kid-real", role: "general", goal: "edit a" }, ["a.ts"]);
		const env = subagentProcessEnv(undefined, process.env, { id: "kid-real", parentId: s.team.id, goal: "edit a" });
		const child = spawn(
			process.execPath,
			["--import", SOURCE_RESOLVER, WORKER, s.cwd, process.env.OCTOCODE_AGENT_DB!],
			{ env, stdio: ["pipe", "pipe", "inherit"] },
		);
		processes.push(child);
		const said = await new Promise<string>((resolve, reject) => {
			child.stdout.on("data", (chunk: Buffer) => resolve(chunk.toString()));
			child.once("exit", (code) => reject(new Error(`worker exited with ${code}`)));
		});
		expect(said.trim()).toBe(`joined ${child.pid}`);
		const row = s.team.members().find((each) => each.id === "kid-real");
		expect(row).toMatchObject({ pid: child.pid, goal: "edit a", locks: ["a.ts"] });
		expect(s.leases()).toEqual([{ path: "a.ts", kind: "file", owner: "kid-real" }]);
		// Its run ended: the parent drops the leases whoever holds the row now.
		s.team.childLeases.release("kid-real");
		expect(s.leases()).toEqual([]);
	});

	it("lets the child's guard pass its own reservation and refuses a name another process holds", () => {
		const s = setup();
		const started = processStartTime(process.ppid);
		const parent = { pid: process.ppid, ...(started ? { started } : {}) };
		const row = heldChildMember(
			member("the-parent", parent),
			{ id: "kid-one", role: "general", goal: "g" },
			Date.now(),
		);
		s.store.lock("kid-one", [{ path: "a.ts", kind: "file", reason: "g" }], Date.now(), row);
		const f = fakeHost();
		const child = new Team(f.api, {
			...process.env,
			[AGENT_ID_ENV]: "kid-one",
			[PARENT_ID_ENV]: "the-parent",
			[PARENT_PID_ENV]: [parent.pid, parent.started].filter(Boolean).join(" "),
		});
		teams.push(child);
		child.start(s.ctx);
		expect(child.id).toBe("kid-one");
		expect(child.reservation(path.join(s.cwd, "a.ts"), "a.ts")).toBeUndefined();
		expect(s.leases()).toEqual([{ path: "a.ts", kind: "file", owner: "kid-one" }]);
		expect(s.team.reservation(path.join(s.cwd, "a.ts"), "a.ts")).toContain("reserved by kid-one");
		// Leaving (a headless child's run settled) frees it.
		child.leave();
		expect(s.leases()).toEqual([]);

		// Without the parent named, the row is another running process's name: refused, as today.
		s.store.lock("kid-two", [{ path: "b.ts", kind: "file", reason: "g" }], Date.now(), {
			...row,
			id: "kid-two",
		});
		const stranger = new Team(fakeHost().api, { ...process.env, [AGENT_ID_ENV]: "kid-two" });
		teams.push(stranger);
		expect(() => stranger.start(s.ctx)).toThrow(/held by another running agent/);
		// A child that could not join still owns what its parent reserved under its name.
		expect(stranger.reservation(path.join(s.cwd, "b.ts"), "b.ts")).toBeUndefined();
	});
});

describe("a child that stays reachable", () => {
	beforeEach(() => {
		process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS = "60";
	});
	afterEach(() => {
		delete process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS;
	});

	it("holds nothing while parked, and a follow-up takes the paths again until it reports", async () => {
		const s = setup();
		const { details } = await s.run({ task: "linger once", background: true, paths: ["a.ts"] });
		await s.control.settle();
		expect(s.leases()).toEqual([]);
		// Parked: another agent can take the path meanwhile.
		const reserve = vi.spyOn(s.team.childLeases, "reserve");
		const sent = await s.team.send(details.id, "linger again", { replyRequired: false });
		expect(sent).toMatchObject({ resumed: expect.stringMatching(/report\.$/) });
		expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ id: details.id }), ["a.ts"]);
		await s.control.settle();
		expect(s.leases()).toEqual([]);
		expect(s.rows()).toEqual([]);
		await s.control.stopAll();
	});

	it("still resumes when another agent took the path meanwhile, and the receipt names it", async () => {
		const s = setup();
		const { details } = await s.run({ task: "linger once", background: true, paths: ["a.ts"] });
		await s.control.settle();
		s.store.save(member("peer-one", { goal: "fix auth" }));
		s.store.lock("peer-one", [{ path: "a.ts", kind: "file", reason: "r" }]);
		const sent = await s.team.send(details.id, "linger again", { replyRequired: false });
		expect(sent).toMatchObject({
			resumed: expect.stringMatching(/not taken again:\n- a\.ts is covered by peer-one, working on "fix auth"/),
		});
		await s.control.settle();
		expect(s.leases().map((lease) => lease.owner)).toEqual(["peer-one"]);
		await s.control.stopAll();
	});
});

vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof NativeConfig>()),
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]] }),
}));
