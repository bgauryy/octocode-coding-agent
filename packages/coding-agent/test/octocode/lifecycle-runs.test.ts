import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentDb, agentRuns, archiveHistory } from "../../../db/src/api.ts";
import { openDatabase } from "../../../db/src/db.ts";
import { SCHEMA_PLAN } from "../../../db/src/migrations.ts";
import { loadSqlite } from "../../../db/src/sqlite.ts";
import { openAgentDb } from "../../src/config/database.ts";
import { processStartTime } from "../../src/octocode/shared/process.ts";
import { Team } from "../../src/octocode/team/session.ts";
import type { LifecycleEvent } from "../../src/octocode/team/lifecycle-bus.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { fakeCtx, fakeHost } from "./fake-host.ts";

const { DatabaseSync } = loadSqlite();
const SOURCE_RESOLVER = path.join(import.meta.dirname, "..", "..", "scripts", "source-resolver.ts");
const WORKER = path.join(import.meta.dirname, "lifecycle-child-worker.ts");
let root: string;
let db: AgentDb;
let store: TeamStore;
const savedTitle = process.title;
const member = (id: string, extra: Partial<Member> = {}): Member => ({
	id,
	role: "researcher",
	pid: process.pid,
	status: "working",
	joinedAt: Date.now(),
	updatedAt: Date.now(),
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
	...extra,
});
const DAY = 86_400_000;

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-runs-")));
	fs.mkdirSync(path.join(root, ".git"));
	fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/feature/audit\n");
	vi.stubEnv("OCTOCODE_HOME", path.join(root, "home"));
	vi.stubEnv("OCTOCODE_AGENT_DB", path.join(root, "agent.db"));
	db = openAgentDb();
	store = TeamStore.open(root, db.file);
	store.lifecycle = { activationId: "start", sessionId: "session-main" };
});
afterEach(() => {
	process.title = savedTitle;
	store.close();
	db.close();
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

describe("the agent_runs table", () => {
	it("migrates a version 2 file by adding the table and the place columns, keeping its rows", () => {
		const file = path.join(root, "v2.db");
		const open = (plan?: typeof SCHEMA_PLAN) =>
			openDatabase({ file, archiveDir: path.join(root, "archive"), privateParent: false }, plan);
		const old = open({ version: 2, migrations: SCHEMA_PLAN.migrations.slice(0, 1) });
		for (const column of ["cwd", "branch", "process_title"]) old.db.exec(`ALTER TABLE agents DROP COLUMN ${column}`);
		old.db.exec("DROP TABLE agent_runs");
		old.db.prepare("INSERT INTO meta (key, value) VALUES ('keep', 'me')").run();
		old.close();
		open().close();
		const raw = new DatabaseSync(file, { readOnly: true });
		expect(raw.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
		expect(raw.prepare("SELECT value FROM meta WHERE key = 'keep'").get()).toEqual({ value: "me" });
		expect(raw.prepare("SELECT value FROM meta WHERE key = 'schema_readable_from'").get()).toEqual({ value: "1" });
		expect((raw.prepare("PRAGMA table_info(agent_runs)").all() as { name: string }[]).map((c) => c.name)).toContain("run_id");
		expect((raw.prepare("PRAGMA table_info(agents)").all() as { name: string }[]).map((c) => c.name)).toEqual(
			expect.arrayContaining(["cwd", "branch", "process_title"]),
		);
		raw.close();
	});

	it("gives a main session a run at its join, with where it works", () => {
		process.title = "octocode-main-abcd1234";
		const main = member("steady-main", { role: "main" });
		expect(store.join(main)).toBe(true);
		const [run] = store.presence.runs({ agentId: "steady-main" });
		expect(run).toMatchObject({
			agentId: "steady-main",
			kind: "main",
			profile: "main",
			sessionId: "session-main",
			cwd: root,
			branch: "feature/audit",
			processTitle: "octocode-main-abcd1234",
			startedBy: "user",
			pid: process.pid,
		});
		expect(run.registrationId).toBe(run.runId);
		expect(run.endedAt).toBeUndefined();
		// The same facts are on the live row, which `coordinate list` shows.
		expect(store.list().find((each) => each.id === "steady-main")).toBeDefined();
	});

	it("links a child's own join to the run its parent opened, and the retiring writer ends it with the final numbers", () => {
		store.join(member("parent-main", { role: "main" }));
		store.presence.beginRun({ agentId: "kid", parentAgentId: "parent-main", profile: "implementer", goal: "fix it", startedBy: "agent" }, store.workspaceId);
		const [opened] = store.presence.runs({ agentId: "kid" });
		expect(opened).toMatchObject({ kind: "child", profile: "implementer", goal: "fix it", parentSessionId: "session-main" });
		expect(opened.registrationId).toBeUndefined();
		const kid = member("kid", { role: "implementer", parentId: "parent-main", toolCalls: 4, input: 9, cost: 1.25 });
		store.join(kid);
		const [linked] = store.presence.runs({ agentId: "kid" });
		expect(linked.runId).toBe(opened.runId);
		expect(linked.registrationId).toBeDefined();
		expect(store.presence.runs({ agentId: "kid" })).toHaveLength(1);
		store.edits.record("kid", "file", [path.join(root, "a.ts"), path.join(root, "b.ts")]);
		store.save({ ...kid, toolCalls: 6, input: 12, cost: 2 });
		store.remove("kid", Date.now(), kid, "completed");
		// The parent's word comes after the child left: outcome and report, the end stays as retired.
		expect(store.presence.finishRun("kid", { endReason: "failed", outcome: "done", reportPath: "/tmp/report.md" })).toBe(true);
		const [ended] = store.presence.runs({ agentId: "kid" });
		expect(ended).toMatchObject({
			endReason: "completed",
			toolCalls: 6,
			input: 12,
			cost: 2,
			outcome: "done",
			reportPath: "/tmp/report.md",
			filesChanged: { count: 2, paths: ["a.ts", "b.ts"] },
		});
		expect(ended.endedAt).toBeGreaterThan(0);
	});

	it("is completed by the parent when the child never joined, and a new run of a name closes an old one that never ended", () => {
		store.presence.beginRun({ agentId: "ghost", profile: "general", goal: "never starts" }, store.workspaceId);
		store.presence.finishRun("ghost", { endReason: "failed", endDetail: "Failed to start", outcome: "failed" });
		expect(store.presence.runs({ agentId: "ghost" })[0]).toMatchObject({ endReason: "failed", endDetail: "Failed to start", outcome: "failed" });
		store.presence.beginRun({ agentId: "twin", goal: "first" }, store.workspaceId);
		store.presence.beginRun({ agentId: "twin", goal: "second" }, store.workspaceId);
		const runs = store.presence.runs({ agentId: "twin" });
		expect(runs.map((run) => [run.goal, run.endReason])).toEqual([
			["second", undefined],
			["first", "crashed"],
		]);
	});

	it("is dropped with the history after retention.days, never before, and kept for good with no window", () => {
		const now = Date.now();
		const ws = store.workspaceId;
		const old = agentRuns.begin(db.db, { workspaceId: ws, agentId: "old-run" }, now - 40 * DAY);
		const recent = agentRuns.begin(db.db, { workspaceId: ws, agentId: "recent-run" }, now - 3 * DAY);
		agentRuns.finish(db.db, "old-run", { endReason: "failed" }, now - 39 * DAY);
		agentRuns.begin(db.db, { workspaceId: ws, agentId: "open-run" }, now - 31 * DAY);
		expect(old).not.toBe(recent);
		expect(archiveHistory(db, now, { archiveAfterDays: 14, keepDays: 0 }).deleted).toBe(0);
		expect(store.presence.runs({ limit: 10 })).toHaveLength(3);
		archiveHistory(db, now, { archiveAfterDays: 14, keepDays: 30 });
		expect(store.presence.runs({ limit: 10 }).map((run) => run.agentId)).toEqual(["recent-run"]);
	});
});

describe("resolving an agent by any name it goes by", () => {
	it("finds it by name, session, registration, process title, pid and backlog item, live and after its row is gone", () => {
		process.title = "octocode-researcher-lone-fox";
		const ws = store.workspaceId;
		store.presence.beginRun({ agentId: "lone-fox", profile: "researcher", goal: "look around", startedBy: "agent", backlog: { workspaceId: ws, seq: 7 } }, ws);
		const fox = member("lone-fox");
		store.join(fox);
		const registration = store.presence.runs({ agentId: "lone-fox" })[0].registrationId!;
		const refs = ["lone-fox", "session-main", registration, "octocode-researcher-lone-fox", String(process.pid), "B7"];
		for (const ref of refs)
			expect(store.presence.resolve(ref, ws), ref).toMatchObject({
				agentId: "lone-fox",
				live: true,
				role: "researcher",
				cwd: root,
				branch: "feature/audit",
				backlog: { seq: 7, ref: "B7" },
			});
		store.remove("lone-fox", Date.now(), fox, "stopped-user");
		for (const ref of [...refs, store.presence.runs({ agentId: "lone-fox" })[0].runId])
			expect(store.presence.resolve(ref, ws), ref).toMatchObject({
				agentId: "lone-fox",
				live: false,
				role: "researcher",
				cwd: root,
				run: { endReason: "stopped-user", goal: "look around" },
			});
		expect(store.presence.resolve("no-such-agent", ws)).toBeUndefined();
		expect(store.presence.resolve("B99", ws)).toBeUndefined();
	});

	it("answers a name reused since with its newest run, and a live agent before a past one", () => {
		const ws = store.workspaceId;
		const first = member("reused");
		store.join(first);
		store.remove("reused", Date.now(), first, "completed");
		const second = member("reused", { role: "general" });
		store.join(second);
		expect(store.presence.resolve("reused", ws)).toMatchObject({ live: true, run: { endReason: undefined } });
		store.remove("reused", Date.now(), second, "failed");
		expect(store.presence.resolve("reused", ws)).toMatchObject({ live: false, run: { endReason: "failed" } });
	});
});

describe("kill -9 of a parent", () => {
	it("ends its child as parent-gone with a complete run, and a peer hears the AgentOff of both", async () => {
		const parentProc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
		let child: ReturnType<typeof spawn> | undefined;
		const heard: LifecycleEvent[] = [];
		const fake = fakeHost();
		const peer = new Team(fake.api, { OCTOCODE_AGENT_DB: db.file });
		try {
			const started = processStartTime(parentProc.pid!);
			store.join(member("parent-main", { role: "main", pid: parentProc.pid!, ...(started ? { started } : {}) }));
			store.presence.beginRun({ agentId: "kid", parentAgentId: "parent-main", profile: "researcher", goal: "wait for me" }, store.workspaceId);
			child = spawn(process.execPath, ["--import", SOURCE_RESOLVER, WORKER, root, db.file, "kid", "parent-main"], {
				stdio: ["ignore", "pipe", "inherit"],
				env: { ...process.env, OCTOCODE_PARENT_PID: `${parentProc.pid} ${started ?? ""}`.trim() },
			});
			await new Promise<void>((resolve, reject) => {
				child!.stdout!.on("data", (chunk: Buffer) => String(chunk).includes("joined kid") && resolve());
				child!.once("exit", (code) => reject(new Error(`The child exited with ${code} before it joined.`)));
			});
			peer.start(fakeCtx({ cwd: root, hasUI: false }));
			peer.lifecycle.on((event) => heard.push(event));
			const exits = new Promise<void>((resolve) => parentProc.once("exit", () => resolve()));
			parentProc.kill("SIGKILL");
			await exits;
			// The child notices within seconds, leaves with `parent-gone` and exits.
			await vi.waitFor(() => expect(store.presence.runs({ agentId: "kid" })[0]?.endedAt).toBeGreaterThan(0), { timeout: 20_000, interval: 200 });
			const [run] = store.presence.runs({ agentId: "kid" });
			expect(run).toMatchObject({
				endReason: "parent-gone",
				profile: "researcher",
				goal: "wait for me",
				parentAgentId: "parent-main",
				toolCalls: 3,
				cost: 0.5,
			});
			expect(run.registrationId).toBeDefined();
			// Another process (here: this store) finds the dead parent and retires it.
			store.sweep(Date.now());
			expect(store.presence.runs({ agentId: "parent-main" })[0]).toMatchObject({ endReason: "crashed", kind: "main" });
			await vi.waitFor(
				() =>
					expect(heard.filter((event) => event.kind === "off").map((event) => [event.agent, event.reason, event.own])).toEqual(
						expect.arrayContaining([
							["kid", "parent-gone", false],
							["parent-main", "crashed", false],
						]),
					),
				{ timeout: 10_000, interval: 200 },
			);
			expect(heard.find((event) => event.agent === "kid" && event.kind === "off")?.data).toMatchObject({ runId: run.runId, cwd: root });
		} finally {
			peer.stop();
			child?.kill("SIGKILL");
			parentProc.kill("SIGKILL");
		}
	}, 60_000);
});
