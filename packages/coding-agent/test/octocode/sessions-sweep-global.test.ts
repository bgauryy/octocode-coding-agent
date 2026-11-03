import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { getSessionsDir } from "../../src/config.ts";
import { sharedAgentDb } from "../../src/config/database.ts";
import { registeredWorkspace } from "../../src/config/workspace-database.ts";
import { SessionIndex } from "../../src/octocode/sessions/store.ts";
import { applySweep, summarizeSweep } from "../../src/octocode/sessions/sweep-apply.ts";
import { planSweep, sweepSessions } from "../../src/octocode/sessions/sweep.ts";
import { setCurrentSession } from "../../src/octocode/shared/home.ts";
import { tmp } from "./helpers.ts";

const DAY = 24 * 3_600_000;
const DEAD_PID = 9_999_999;

let saved: { home?: string; db?: string; days?: string; sessionDays?: string; homeDir?: string };
let home: string;

beforeEach(() => {
	saved = {
		home: process.env.OCTOCODE_HOME,
		db: process.env.OCTOCODE_AGENT_DB,
		days: process.env.OCTOCODE_CLEANUP_DAYS,
		sessionDays: process.env.OCTOCODE_SESSION_RETENTION_DAYS,
	};
	home = tmp();
	process.env.OCTOCODE_HOME = home;
	delete process.env.OCTOCODE_AGENT_DB;
	delete process.env.OCTOCODE_CLEANUP_DAYS;
	delete process.env.OCTOCODE_SESSION_RETENTION_DAYS;
});

afterEach(() => {
	closeSharedAgentDb();
	setCurrentSession(undefined);
	for (const [key, value] of [
		["OCTOCODE_HOME", saved.home],
		["OCTOCODE_AGENT_DB", saved.db],
		["OCTOCODE_CLEANUP_DAYS", saved.days],
		["OCTOCODE_SESSION_RETENTION_DAYS", saved.sessionDays],
	] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

const age = (target: string, days: number) => {
	const at = new Date(Date.now() - days * DAY);
	const all = fs.statSync(target).isDirectory()
		? [target, ...fs.readdirSync(target, { recursive: true }).map((name) => path.join(target, String(name)))]
		: [target];
	for (const file of all) fs.lutimesSync(file, at, at);
};

function workspace() {
	const root = fs.realpathSync(tmp("octocode-ws-"));
	const identity = registeredWorkspace(root, sharedAgentDb());
	const state = path.join(identity.root, ".octa", "code");
	return { root: identity.root, id: identity.id, state };
}

function transcript(dir: string, id: string, daysOld: number): string {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${id}.jsonl`);
	fs.writeFileSync(
		file,
		`${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: dir })}\n`,
	);
	age(file, daysOld);
	return file;
}

const none = async () => new Set<string>();

describe("global sweep", () => {
	it("sweeps a stale workspace that is not the current one, the global root and a legacy folder, from any cwd", async () => {
		const index = new SessionIndex(sharedAgentDb());
		const ws = workspace();
		fs.mkdirSync(path.join(ws.state, "session-data", "stale-session", "output"), { recursive: true });
		age(path.join(ws.state, "session-data", "stale-session"), 40);
		fs.mkdirSync(path.join(ws.state, "session-data", "fresh-session", "output"), { recursive: true });
		const global = path.join(home, "agent", "sessions", "global-stale");
		fs.mkdirSync(path.join(global, "output"), { recursive: true });
		age(global, 40);
		const legacyFile = transcript(path.join(getSessionsDir(), "--tmp-old--"), "legacy-1", 120);
		const legacyFresh = transcript(path.join(getSessionsDir(), "--tmp-new--"), "legacy-2", 5);

		await sweepSessions(index, "someone-else", { force: true, listed: none });

		expect(fs.existsSync(path.join(ws.state, "session-data", "stale-session"))).toBe(false);
		expect(fs.existsSync(path.join(ws.state, "session-data", "fresh-session"))).toBe(true);
		expect(fs.existsSync(global)).toBe(false);
		expect(fs.existsSync(legacyFile)).toBe(false);
		expect(fs.existsSync(path.dirname(legacyFile))).toBe(false);
		expect(fs.existsSync(legacyFresh)).toBe(true);
	});

	it("expires a transcript past sessionDays with its session folder and database rows, never a younger one", async () => {
		const index = new SessionIndex(sharedAgentDb());
		const ws = workspace();
		const sessions = path.join(ws.state, "sessions");
		const old = transcript(sessions, "old-session", 100);
		const young = transcript(sessions, "young-session", 60);
		for (const id of ["old-session", "young-session"])
			fs.mkdirSync(path.join(ws.state, "session-data", id, "output"), { recursive: true });
		sharedAgentDb().db.prepare("INSERT INTO sessions (id, workspace_id) VALUES (?, ?)").run("old-session", ws.id);
		sharedAgentDb().db.prepare("INSERT INTO sessions (id, workspace_id) VALUES (?, ?)").run("young-session", ws.id);

		await sweepSessions(index, undefined, { force: true, listed: none });

		expect(fs.existsSync(old)).toBe(false);
		expect(fs.existsSync(path.join(ws.state, "session-data", "old-session"))).toBe(false);
		expect(index.get("old-session")).toBeUndefined();
		expect(fs.existsSync(young)).toBe(true);
		expect(fs.existsSync(path.join(ws.state, "session-data", "young-session"))).toBe(true);
		expect(index.get("young-session")).toBeDefined();
	});

	it("keeps the current session, a running session and a transcript in an unreadable directory", async () => {
		const index = new SessionIndex(sharedAgentDb());
		const ws = workspace();
		const sessions = path.join(ws.state, "sessions");
		const current = transcript(sessions, "current-session", 200);
		const live = transcript(sessions, "live-session", 200);
		sharedAgentDb().db.prepare("INSERT INTO sessions (id, pid) VALUES (?, ?)").run("live-session", process.pid);
		sharedAgentDb().db.prepare("INSERT INTO sessions (id, pid) VALUES (?, ?)").run("dead-session", DEAD_PID);
		const other = workspace();
		const hidden = transcript(path.join(other.state, "sessions"), "hidden-session", 200);
		const legacyDir = path.join(getSessionsDir(), "--blocked--");
		const blocked = transcript(legacyDir, "blocked-session", 200);
		try {
			fs.chmodSync(path.join(other.state, "sessions"), 0o000);
			fs.chmodSync(legacyDir, 0o000);
			await sweepSessions(index, "current-session", { force: true, listed: none });
		} finally {
			fs.chmodSync(path.join(other.state, "sessions"), 0o700);
			fs.chmodSync(legacyDir, 0o700);
		}
		expect(fs.existsSync(current)).toBe(true);
		expect(fs.existsSync(live)).toBe(true);
		expect(fs.existsSync(hidden)).toBe(true);
		expect(fs.existsSync(blocked)).toBe(true);
	});

	it("expires .octocode/tmp entries but never other .octocode topics, and follows no symlink", async () => {
		const index = new SessionIndex(sharedAgentDb());
		const ws = workspace();
		const tmpDir = path.join(ws.root, ".octocode", "tmp");
		const topic = path.join(ws.root, ".octocode", "reports");
		fs.mkdirSync(path.join(tmpDir, "old-run"), { recursive: true });
		fs.mkdirSync(path.join(tmpDir, "busy-run"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, "old-run", "a.txt"), "x");
		fs.writeFileSync(path.join(tmpDir, "busy-run", "a.txt"), "x");
		fs.mkdirSync(topic, { recursive: true });
		fs.writeFileSync(path.join(topic, "r.md"), "x");
		const outside = tmp("octocode-outside-");
		fs.writeFileSync(path.join(outside, "precious.txt"), "x");
		fs.symlinkSync(outside, path.join(tmpDir, "link"));
		age(path.join(tmpDir, "old-run"), 40);
		age(path.join(tmpDir, "link"), 40);
		age(topic, 400);
		// busy-run: an old folder with one fresh file deep inside stays.
		age(path.join(tmpDir, "busy-run"), 40);
		fs.writeFileSync(path.join(tmpDir, "busy-run", "a.txt"), "fresh");

		await sweepSessions(index, undefined, { force: true, listed: none });

		expect(fs.existsSync(path.join(tmpDir, "old-run"))).toBe(false);
		expect(fs.existsSync(path.join(tmpDir, "link"))).toBe(false);
		expect(fs.existsSync(path.join(outside, "precious.txt"))).toBe(true);
		expect(fs.existsSync(path.join(tmpDir, "busy-run"))).toBe(true);
		expect(fs.existsSync(path.join(topic, "r.md"))).toBe(true);
	});

	it("skips a workspace whose root no longer exists, and keeps everything with retention 0", async () => {
		const index = new SessionIndex(sharedAgentDb());
		const ws = workspace();
		const file = transcript(path.join(ws.state, "sessions"), "ancient", 500);
		fs.mkdirSync(path.join(ws.root, ".octocode", "tmp", "old"), { recursive: true });
		age(path.join(ws.root, ".octocode", "tmp", "old"), 500);
		process.env.OCTOCODE_CLEANUP_DAYS = "0";
		process.env.OCTOCODE_SESSION_RETENTION_DAYS = "0";
		await sweepSessions(index, undefined, { force: true, listed: none });
		expect(fs.existsSync(file)).toBe(true);
		expect(fs.existsSync(path.join(ws.root, ".octocode", "tmp", "old"))).toBe(true);

		delete process.env.OCTOCODE_CLEANUP_DAYS;
		delete process.env.OCTOCODE_SESSION_RETENTION_DAYS;
		const gone = workspace();
		fs.rmSync(gone.root, { recursive: true, force: true });
		const plan = await planSweep(index, undefined, { listed: none });
		expect(plan.skipped.some((skip) => skip.path === gone.root)).toBe(true);
	});

	it("planSweep lists candidates with reason and size and deletes nothing; applySweep then removes them", async () => {
		const index = new SessionIndex(sharedAgentDb());
		const ws = workspace();
		const file = transcript(path.join(ws.state, "sessions"), "expired", 150);
		const scratch = path.join(ws.root, ".octocode", "tmp", "run");
		fs.mkdirSync(scratch, { recursive: true });
		fs.writeFileSync(path.join(scratch, "big.bin"), Buffer.alloc(2048));
		age(scratch, 45);

		const plan = await planSweep(index, undefined, { listed: none });
		expect(fs.existsSync(file)).toBe(true);
		expect(fs.existsSync(scratch)).toBe(true);
		const byKind = Object.fromEntries(plan.candidates.map((candidate) => [candidate.kind, candidate]));
		expect(byKind.transcript).toMatchObject({ path: file, session: "expired" });
		expect(byKind.transcript?.reason).toContain("sessionDays 90");
		expect(byKind.scratch).toMatchObject({ path: scratch, bytes: 2048 });

		const result = await applySweep(index, plan);
		expect(result.failed).toEqual([]);
		expect(fs.existsSync(file)).toBe(false);
		expect(fs.existsSync(scratch)).toBe(false);
	});

	it("reports one summary line, and failures, instead of swallowing them", async () => {
		const index = new SessionIndex(sharedAgentDb());
		const ws = workspace();
		const scratch = path.join(ws.root, ".octocode", "tmp", "run");
		fs.mkdirSync(scratch, { recursive: true });
		fs.writeFileSync(path.join(scratch, "a"), "x");
		age(scratch, 45);
		const lines: string[] = [];
		await sweepSessions(index, undefined, { force: true, listed: none, report: (line) => lines.push(line) });
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^Octocode cleanup removed 1 items/);

		// A failing listing removes nothing and says why.
		fs.mkdirSync(scratch, { recursive: true });
		age(scratch, 45);
		const failed: string[] = [];
		await sweepSessions(index, undefined, {
			force: true,
			listed: async () => {
				throw new Error("unreadable");
			},
			report: (line) => failed.push(line),
		});
		expect(fs.existsSync(scratch)).toBe(true);
		expect(failed[0]).toContain("session listing failed (unreadable)");
	});

	it("claims the pass once globally, not per workspace", async () => {
		const index = new SessionIndex(sharedAgentDb());
		workspace();
		workspace();
		const first = path.join(home, "agent", "sessions", "g1");
		fs.mkdirSync(first, { recursive: true });
		age(first, 40);
		await sweepSessions(index, undefined, { listed: none });
		expect(fs.existsSync(first)).toBe(false);
		fs.mkdirSync(first, { recursive: true });
		age(first, 40);
		await sweepSessions(index, undefined, { listed: none });
		expect(fs.existsSync(first)).toBe(true);
	});
});

describe("applySweep after the plan", () => {
	function planned() {
		const index = new SessionIndex(sharedAgentDb());
		const ws = workspace();
		const file = transcript(path.join(ws.state, "sessions"), "resumed", 150);
		const folder = path.join(ws.state, "session-data", "resumed");
		fs.mkdirSync(path.join(folder, "checkpoints"), { recursive: true });
		age(folder, 150);
		sharedAgentDb().db.prepare("INSERT INTO sessions (id, workspace_id) VALUES (?, ?)").run("resumed", ws.id);
		return { index, ws, file, folder };
	}

	it("keeps every path and row of a session whose transcript was written after the plan", async () => {
		const { index, file, folder } = planned();
		const plan = await planSweep(index, undefined, { listed: none });
		expect(plan.candidates.some((candidate) => candidate.session === "resumed")).toBe(true);
		const later = new Date(Date.now() + 1000);
		fs.utimesSync(file, later, later);
		const result = await applySweep(index, plan);
		expect(result.skipped).toEqual([{ path: "session resumed", reason: "transcript written after the plan" }]);
		expect(result.failed).toEqual([]);
		expect(fs.existsSync(file)).toBe(true);
		expect(fs.existsSync(folder)).toBe(true);
		expect(index.get("resumed")).toBeDefined();
		expect(summarizeSweep(result)).toContain("1 changed since the plan and were kept");
	});

	it("keeps a planned session that became running or current after the plan", async () => {
		const { index, file, folder } = planned();
		const plan = await planSweep(index, undefined, { listed: none });
		sharedAgentDb().db.prepare("UPDATE sessions SET pid = ? WHERE id = ?").run(process.pid, "resumed");
		const running = await applySweep(index, plan);
		expect(running.skipped).toEqual([{ path: "session resumed", reason: "is running" }]);
		sharedAgentDb().db.prepare("UPDATE sessions SET pid = NULL WHERE id = ?").run("resumed");
		const current = await applySweep(index, plan, { current: "resumed" });
		expect(current.skipped).toEqual([{ path: "session resumed", reason: "became the current session" }]);
		expect(fs.existsSync(file)).toBe(true);
		expect(fs.existsSync(folder)).toBe(true);
		expect(index.get("resumed")).toBeDefined();
	});

	it("keeps a .octocode/tmp entry written after the plan, and removes its idle neighbour", async () => {
		const index = new SessionIndex(sharedAgentDb());
		const ws = workspace();
		const tmpDir = path.join(ws.root, ".octocode", "tmp");
		for (const name of ["idle", "revived"]) {
			fs.mkdirSync(path.join(tmpDir, name), { recursive: true });
			fs.writeFileSync(path.join(tmpDir, name, "a.txt"), "x");
			age(path.join(tmpDir, name), 45);
		}
		const plan = await planSweep(index, undefined, { listed: none });
		expect(plan.candidates.filter((candidate) => candidate.kind === "scratch")).toHaveLength(2);
		fs.writeFileSync(path.join(tmpDir, "revived", "a.txt"), "written after the plan");
		const result = await applySweep(index, plan);
		expect(result.skipped).toEqual([{ path: path.join(tmpDir, "revived"), reason: "written after the plan" }]);
		expect(fs.existsSync(path.join(tmpDir, "revived"))).toBe(true);
		expect(fs.existsSync(path.join(tmpDir, "idle"))).toBe(false);
	});
});
