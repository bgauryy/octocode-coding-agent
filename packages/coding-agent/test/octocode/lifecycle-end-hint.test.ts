import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentDb, agentEvents, agents, closeSharedAgentDb } from "../../../db/src/api.ts";
import { openDatabase } from "../../../db/src/db.ts";
import { SCHEMA_PLAN } from "../../../db/src/migrations.ts";
import { loadSqlite } from "../../../db/src/sqlite.ts";
import { openAgentDb } from "../../src/storage/database.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { sameProcess } from "../../src/octocode/shared/process.ts";
import { USER_SENDER } from "../../src/octocode/shared/messages.ts";
import { emptyUsage } from "../../src/octocode/shared/util.ts";
import type { AgentRuns, Run } from "../../src/octocode/subagents/claim.ts";
import { stopBackground } from "../../src/octocode/subagents/command.ts";
import type { Report } from "../../src/octocode/subagents/handoff/pending.ts";
import { runForeground, startBackground } from "../../src/octocode/subagents/run-execution.ts";
import { runDetails } from "../../src/octocode/subagents/tracking.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { ReportGroups } from "../../src/octocode/subagents/report-groups.ts";

const { DatabaseSync } = loadSqlite();
let root: string;
let db: AgentDb;
let store: TeamStore;
const member = (id: string, extra: Partial<Member> = {}): Member => ({
	id,
	role: "general",
	pid: process.pid,
	status: "working",
	joinedAt: 1000,
	updatedAt: 1000,
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
	...extra,
});
const deleteReasons = () =>
	Object.fromEntries(
		agentEvents
			.list(db.db, registeredWorkspace(root, db).id)
			.filter((event) => event.type === "delete")
			.map((event) => [event.name, event.data.reason]),
	);
const columns = (file: string, table: string) => {
	const raw = new DatabaseSync(file, { readOnly: true });
	try {
		return (raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name);
	} finally {
		raw.close();
	}
};

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-hint-")));
	vi.stubEnv("OCTOCODE_HOME", path.join(root, "home"));
	vi.stubEnv("OCTOCODE_AGENT_DB", path.join(root, "agent.db"));
	db = openAgentDb();
	store = TeamStore.open(root, db.file);
	store.lifecycle = { activationId: "start", sessionId: "session" };
});
afterEach(() => {
	store.close();
	db.close();
	closeSharedAgentDb();
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

describe("the end_hint migration", () => {
	const open = (file: string, plan?: typeof SCHEMA_PLAN) =>
		openDatabase(
			{
				file,
				mirrorFile: `${file}.transcripts`,
				archiveDir: path.join(path.dirname(file), "archive"),
				privateParent: false,
			},
			plan,
		);

	it("is the first step, additive, and a migrated file has the shape of a new one", () => {
		// The pinned history is append-only: steps 5 (`backlog.closed`), 6 (the widened `timers`), 7 (`backlog.rank`), 8 (`cache_write`), 9 (`shell_history`) and 10 (the transcript mirror's own file) came after these.
		expect(SCHEMA_PLAN.version).toBe(10);
		expect(SCHEMA_PLAN.migrations).toEqual([
			expect.objectContaining({ to: 2, additive: true }),
			expect.objectContaining({ to: 3, additive: true }),
			expect.objectContaining({ to: 4, additive: true }),
			expect.objectContaining({ to: 5, additive: true }),
			expect.objectContaining({ to: 6, additive: true }),
			expect.objectContaining({ to: 7, additive: true }),
			expect.objectContaining({ to: 8, additive: true }),
			expect.objectContaining({ to: 9, additive: true }),
			expect.objectContaining({ to: 10, additive: false }),
		]);
		const old = path.join(root, "old.db");
		const first = open(old, { version: 1, migrations: [] });
		// A version 1 file as the previous Octocode wrote it: no end_hint column.
		for (const column of ["end_hint", "cwd", "branch", "process_title"])
			first.db.exec(`ALTER TABLE agents DROP COLUMN ${column}`);
		// Step 8 adds `cache_write` to `agents` (and to `agent_runs`, dropped below).
		first.db.exec("ALTER TABLE agents DROP COLUMN cache_write");
		first.db.exec("DROP TABLE agent_runs");
		first.db.exec("DROP TABLE timers");
		// Step 5 adds `backlog.closed` and recreates its audit triggers; a version 1 file has neither.
		for (const name of ["insert", "update", "delete"]) first.db.exec(`DROP TRIGGER backlog_audits_${name}`);
		first.db.exec("ALTER TABLE backlog DROP COLUMN closed");
		// Step 7 adds `backlog.rank`.
		first.db.exec("ALTER TABLE backlog DROP COLUMN rank");
		first.db.prepare("INSERT INTO meta (key, value) VALUES ('keep', 'me')").run();
		first.close();
		expect(columns(old, "agents")).not.toContain("end_hint");
		open(old).close();
		expect(columns(old, "agents")).toContain("end_hint");
		expect(fs.existsSync(`${old}.v1.bak`)).toBe(true);
		const fresh = path.join(root, "fresh.db");
		open(fresh).close();
		expect(columns(old, "agents")).toEqual(columns(fresh, "agents"));
		const raw = new DatabaseSync(old, { readOnly: true });
		expect(raw.prepare("SELECT value FROM meta WHERE key = 'keep'").get()).toEqual({ value: "me" });
		expect(raw.prepare("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_PLAN.version });
		raw.close();
	});

	it("is refused by an Octocode from before the transcript mirror moved out (step 10 is not additive)", () => {
		const file = path.join(root, "both.db");
		open(file).close();
		expect(() => open(file, { version: 9, migrations: SCHEMA_PLAN.migrations.slice(0, 8) })).toThrow(
			/needs an Octocode that supports schema version 10/,
		);
		// No floor row: the floor is the file's own version, which an Octocode at 9 cannot read.
		const raw = new DatabaseSync(file, { readOnly: true });
		expect(raw.prepare("SELECT value FROM meta WHERE key = 'schema_readable_from'").get()).toBeUndefined();
		raw.close();
	});
});

describe("cache writes per agent", () => {
	it("are stored on the live row and carried to the run the retiring writer ends", () => {
		const kid = member("writer", { role: "main", cacheRead: 5, cacheWrite: 7 });
		store.join(kid);
		expect(store.list(1000).find((each) => each.id === "writer")).toMatchObject({ cacheRead: 5, cacheWrite: 7 });
		store.save({ ...kid, cacheWrite: 11 });
		expect(store.list(1000).find((each) => each.id === "writer")?.cacheWrite).toBe(11);
		store.remove("writer", Date.now(), kid, "completed");
		const [run] = store.presence.runs({ agentId: "writer" });
		expect(run).toMatchObject({ cacheRead: 5, cacheWrite: 11 });
	});

	it("read as 0 for a member recorded without them", () => {
		store.join(member("legacy"));
		expect(store.list(1000).find((each) => each.id === "legacy")?.cacheWrite).toBe(0);
	});
});

describe("the reason a retired row gets", () => {
	it("is the leaver's own, else the parent's hint, else the retiring writer's fallback", () => {
		const names = ["a-explicit", "b-hinted", "c-plain"].map((id) => member(id));
		for (const one of names) store.join(one);
		store.presence.hint("a-explicit", "stopped-parent");
		store.presence.hint("b-hinted", "stopped-user");
		store.remove("a-explicit", 2000, names[0], "completed");
		store.remove("b-hinted", 2000, names[1]);
		store.remove("c-plain", 2000, names[2]);
		expect(deleteReasons()).toEqual({ "a-explicit": "completed", "b-hinted": "stopped-user", "c-plain": "left" });
	});

	it("keeps the first hint, and writes none for a row that is gone", () => {
		const one = member("first-hint");
		store.join(one);
		expect(store.presence.hint("first-hint", "stopped-user")).toBe(true);
		expect(store.presence.hint("first-hint", "failed")).toBe(false);
		store.remove("first-hint", 2000, one);
		expect(store.presence.hint("first-hint", "failed")).toBe(false);
		expect(deleteReasons()).toEqual({ "first-hint": "stopped-user" });
	});

	it("survives heartbeats", () => {
		const one = member("beating");
		store.join(one);
		store.presence.hint("beating", "failed");
		store.save({ ...one, updatedAt: 3000, toolCalls: 4 });
		expect(db.db.prepare("SELECT end_hint FROM agents WHERE id = 'beating'").get()).toEqual({ end_hint: "failed" });
	});

	it("a nonpersistent row takes the hint without an event", () => {
		db.transaction(() => agents.insert(db.db, root, registeredWorkspace(root, db), member("plain")));
		expect(db.transaction(() => agents.setEndHint(db.db, "plain", "failed"))).toBe(true);
		db.transaction(() => agents.remove(db.db, "plain"));
		expect(deleteReasons()).toEqual({});
	});
});

describe("kill -9 after a hint", () => {
	it("the reaper writes the parent's cause, not `crashed`; without a hint it still writes `crashed`", async () => {
		const children = ["hinted", "unhinted"].map((name) => ({
			name,
			proc: spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }),
		}));
		try {
			for (const { name, proc } of children) {
				expect(proc.pid).toBeGreaterThan(0);
				store.join(member(name, { pid: proc.pid! }));
			}
			// The parent decides to stop one child, writes the hint, and the child is then killed hard, without leaving.
			expect(store.presence.hint("hinted", "stopped-parent")).toBe(true);
			const exits = children.map(({ proc }) => new Promise<void>((resolve) => proc.once("exit", () => resolve())));
			for (const { proc } of children) proc.kill("SIGKILL");
			await Promise.all(exits);
			for (const { proc } of children) expect(sameProcess(proc.pid!, undefined)).toBe(false);
			// Another Octocode process sweeps the dead rows.
			const peer = TeamStore.open(root, db.file);
			try {
				peer.sweep(Date.now());
			} finally {
				peer.close();
			}
			expect(deleteReasons()).toEqual({ hinted: "stopped-parent", unhinted: "crashed" });
		} finally {
			for (const { proc } of children) proc.kill("SIGKILL");
		}
	});
});

describe("the parent's side", () => {
	const hints: Array<[string, string]> = [];
	const reports: Report[] = [];
	const runs = (): AgentRuns =>
		({
			background: new Map(),
			foreground: new Map(),
			changed: () => undefined,
			session: 1,
			read: { track: () => undefined, consume: () => false },
			team: {
				audit: {
					hint: (id: string, hint: string) => hints.push([id, hint]),
					begin: () => undefined,
					finish: () => undefined,
				},
				editLog: () => undefined,
			},
			reports: { add: (report: Report) => reports.push(report), reportingChanged: () => undefined },
			groups: new ReportGroups(),
		}) as unknown as AgentRuns;
	const runOf = (id: string) => ({ identity: { id, role: "general", goal: "Check" }, route: {} }) as Run;
	const neverEnds = (signal: AbortSignal) =>
		new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
	beforeEach(() => {
		hints.length = 0;
		reports.length = 0;
	});

	it.each([
		[USER_SENDER, "stopped-user"],
		["general-parent", "stopped-parent"],
	])("a background run stopped by %s is hinted %s before its child is signalled", async (by, hint) => {
		const context = runs();
		const run = runOf("stopped-one");
		startBackground(context, run, runDetails(run), "Check", neverEnds, async () => "", "parent");
		expect(hints).toEqual([]);
		expect(stopBackground(context.background, "stopped-one", by)).toBeUndefined();
		// Written inside the abort call, so before anything reacts to it.
		expect(hints).toEqual([["stopped-one", hint]]);
		await vi.waitFor(() => expect(reports).toHaveLength(1));
		expect(hints).toEqual([["stopped-one", hint]]);
	});

	it("a foreground run the user aborts with Esc is hinted stopped-user", async () => {
		const context = runs();
		const run = runOf("esc-one");
		const esc = new AbortController();
		const running = runForeground(
			context,
			run,
			runDetails(run),
			neverEnds,
			async () => "",
			"",
			esc.signal,
			() => undefined,
		);
		esc.abort();
		await expect(running).rejects.toThrow();
		expect(hints).toEqual([["esc-one", "stopped-user"]]);
	});

	it("a run whose child exits with an error is hinted failed, in the background and the foreground", async () => {
		const failing = async () => ({ text: "", error: "provider error", usage: emptyUsage() });
		const background = runOf("failed-bg");
		startBackground(runs(), background, runDetails(background), "Check", failing, async () => "", "parent");
		await vi.waitFor(() => expect(hints).toEqual([["failed-bg", "failed"]]));
		const foreground = runOf("failed-fg");
		await runForeground(
			runs(),
			foreground,
			runDetails(foreground),
			failing,
			async () => "",
			"",
			undefined,
			() => undefined,
		);
		expect(hints).toContainEqual(["failed-fg", "failed"]);
	});

	it("a run that completes is not hinted, and a launch that throws on its own is hinted failed", async () => {
		const done = runOf("done-one");
		startBackground(
			runs(),
			done,
			runDetails(done),
			"Check",
			async () => ({ text: "ok", outcome: "done" as const, usage: emptyUsage() }),
			async () => "",
			"parent",
		);
		const crashed = runOf("crash-one");
		startBackground(
			runs(),
			crashed,
			runDetails(crashed),
			"Check",
			async () => {
				throw new Error("spawn failed");
			},
			async () => "",
			"parent",
		);
		await vi.waitFor(() => expect(reports).toHaveLength(2));
		expect(hints).toEqual([["crash-one", "failed"]]);
	});
});
