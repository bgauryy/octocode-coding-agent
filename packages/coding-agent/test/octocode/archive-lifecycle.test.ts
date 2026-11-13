import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentEvents, agents, compactions, type AgentDb, closeSharedAgentDb } from "../../../db/src/api.ts";
import { openAgentDb, sharedAgentDb } from "../../src/storage/database.ts";
import { archiveFolder } from "../../src/octocode/history/archive.ts";
import { projectAgents } from "../../src/octocode/archive/projection.ts";
import { registerArchiveLifecycle } from "../../src/octocode/archive/lifecycle.ts";
import { HistoryRepair } from "../../src/octocode/archive/repair.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";

let root: string;
let db: AgentDb;
const member = (id = "amber-otter"): Member => ({
	id,
	role: "main",
	pid: process.pid,
	status: "idle",
	joinedAt: 1,
	updatedAt: 1,
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
});

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "archive-lifecycle-")));
	vi.stubEnv("OCTOCODE_HOME", path.join(root, "home"));
	vi.stubEnv("OCTOCODE_AGENT_DB", path.join(root, "agent.db"));
	db = openAgentDb();
});
afterEach(() => {
	db.close();
	closeSharedAgentDb();
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

describe("durable agent lifecycle", () => {
	it("commits identity and events together, separates name reuse and excludes heartbeats", () => {
		const store = TeamStore.open(root, db.file);
		store.lifecycle = { activationId: "start-a", sessionId: "session-a" };
		const me = member();
		expect(store.join(me)).toBe(true);
		store.save({ ...me, updatedAt: 2, toolCalls: 7 });
		expect(agentEvents.list(db.db, registeredWorkspace(root, db).id).map((event) => event.type)).toEqual(["create"]);
		store.save({ ...me, updatedAt: 3, goal: "new assignment" });
		store.remove(me.id);
		store.lifecycle = { activationId: "start-b", sessionId: "session-b" };
		store.join(me);
		const events = agentEvents.list(db.db, registeredWorkspace(root, db).id);
		expect(events.map((event) => event.type)).toEqual(["create", "delete", "update", "create"]);
		expect(events[0].data.registrationId).not.toBe(events[3].data.registrationId);
		expect(events[1].data.registrationId).toBe(events[3].data.registrationId);
		expect(events[0].sessionId).toBe("session-b");
		expect(() =>
			db.transaction(() => {
				agents.remove(db.db, me.id);
				throw new Error("rollback");
			}),
		).toThrow("rollback");
		expect(agentEvents.list(db.db, registeredWorkspace(root, db).id)).toEqual(events);
		expect(agents.ids(db.db)).toContain(me.id);
		store.close();
	});
	it("does not audit nonpersistent presence even when another owner removes it", () => {
		db.transaction(() => agents.insert(db.db, root, registeredWorkspace(root, db), member()));
		db.transaction(() => agents.remove(db.db, member().id, "reaped"));
		expect(agentEvents.list(db.db, registeredWorkspace(root, db).id)).toEqual([]);
	});

	it("keeps the original parent registration when a parent name is reused", () => {
		const context = { activationId: "activation", sessionId: "parent-session" };
		db.transaction(() => agents.insert(db.db, root, registeredWorkspace(root, db), member("parent"), context));
		const parentRegistration = agentEvents.list(db.db, registeredWorkspace(root, db).id)[0].id;
		db.transaction(() =>
			agents.insert(
				db.db,
				root,
				registeredWorkspace(root, db),
				{ ...member("child"), parentId: "parent" },
				{ ...context, sessionId: "child-session" },
			),
		);
		db.transaction(() => {
			agents.remove(db.db, "parent");
			agents.insert(db.db, root, registeredWorkspace(root, db), member("parent"), context);
		});
		db.transaction(() => agents.remove(db.db, "child", "reaped"));
		expect(agentEvents.list(db.db, registeredWorkspace(root, db).id)[0]).toMatchObject({
			type: "delete",
			sessionId: "child-session",
			data: { agentId: "child", parentRegistrationId: parentRegistration },
		});
	});
	it("projects only the newest 50 and binds to the first database", async () => {
		for (let i = 0; i < 55; i++)
			db.transaction(() =>
				agentEvents.append(db.db, registeredWorkspace(root, db).id, {
					id: `event-${i}`,
					time: new Date(i).toISOString(),
					name: null,
					parentId: null,
					sessionId: "session",
					type: "init",
					data: { agentId: null },
					version: 1,
				}),
			);
		await projectAgents(db, root);
		const file = path.join(root, ".octocode/code/agents.txt");
		const content = fs.readFileSync(file, "utf8");
		const rows = content
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(rows).toHaveLength(50);
		expect(rows[0].id).toBe("event-54");
		expect(agentEvents.list(db.db, registeredWorkspace(root, db).id, Number.MAX_SAFE_INTEGER, 100)).toHaveLength(55);
		const other = openAgentDb(path.join(root, "other.db"));
		await expect(projectAgents(other, root)).rejects.toThrow("another database");
		expect(fs.readFileSync(file, "utf8")).toBe(content);
		other.close();
		fs.unlinkSync(file);
		await projectAgents(db, root);
		expect(fs.readFileSync(file, "utf8")).toBe(content);
		fs.writeFileSync(file, JSON.stringify({ ...rows[0], time: "bad" }) + "\n");
		await expect(projectAgents(db, root)).rejects.toThrow("another database or format");
	});
	it("takes no lock when the view is current, and reports a held lock as ELOCKED for a quiet retry", async () => {
		const event = (id: string) =>
			db.transaction(() =>
				agentEvents.append(db.db, registeredWorkspace(root, db).id, {
					id,
					time: new Date(0).toISOString(),
					name: null,
					parentId: null,
					sessionId: "session",
					type: "init",
					data: { agentId: null },
					version: 1,
				}),
			);
		event("first");
		await projectAgents(db, root);
		const file = path.join(root, ".octocode/code/agents.txt");
		const content = fs.readFileSync(file, "utf8");
		// Another process holds the view's lock: a commit that changed no event does not wait for it or fail.
		fs.mkdirSync(`${file}.lock`);
		await expect(projectAgents(db, root)).resolves.toBeUndefined();
		// A new event needs the lock: the error is ELOCKED, which the lifecycle retries instead of warning.
		event("second");
		await expect(projectAgents(db, root)).rejects.toThrow(expect.objectContaining({ code: "ELOCKED" }));
		expect(fs.readFileSync(file, "utf8")).toBe(content);
		fs.rmdirSync(`${file}.lock`);
		await projectAgents(db, root);
		expect(fs.readFileSync(file, "utf8")).toContain('"id":"second"');
	});
	it("refuses symlink and empty projections without overwriting them", async () => {
		fs.mkdirSync(path.join(root, ".octocode/code"), { recursive: true });
		const file = path.join(root, ".octocode/code/agents.txt");
		fs.writeFileSync(file, "");
		await expect(projectAgents(db, root)).rejects.toThrow("Invalid");
		fs.unlinkSync(file);
		const target = path.join(root, "outside");
		fs.writeFileSync(target, "unchanged");
		fs.symlinkSync(target, file);
		await expect(projectAgents(db, root)).rejects.toThrow("symlink");
		expect(fs.readFileSync(target, "utf8")).toBe("unchanged");
	});
	it("does not export a live listener's old events into a replacement checkout", async () => {
		const project = path.join(root, "checkout");
		fs.mkdirSync(project);
		const original = registeredWorkspace(project, db);
		fs.renameSync(project, path.join(root, "retired"));
		fs.mkdirSync(project);
		const replacement = registeredWorkspace(project, db);
		expect(replacement.id).not.toBe(original.id);
		await expect(projectAgents(db, project, original)).rejects.toThrow(/path changed/);
		expect(fs.existsSync(path.join(project, ".octocode/code/agents.txt"))).toBe(false);
	});

	it("records every activation, deduplicates dispatch retries and skips no-session", async () => {
		const fake = fakeHost();
		const close = registerArchiveLifecycle(fake.api, {
			canProject: () => true,
			agentId: () => undefined,
			parentId: () => undefined,
		});
		const ctx = fakeCtx({ cwd: root });
		Object.assign(ctx.sessionManager, {
			getSessionFile: () => path.join(root, "not-created.jsonl"),
			getSessionId: () => "session",
		});
		const event = { type: "session_start", reason: "startup" };
		await fake.fire("session_start", event, ctx);
		await fake.fire("session_start", event, ctx);
		await fake.fire("session_start", { ...event, reason: "resume" }, ctx);
		expect(agentEvents.list(db.db, registeredWorkspace(root, db).id).map((row) => row.data.reason)).toEqual([
			"resume",
			"startup",
		]);
		Object.assign(ctx.sessionManager, { getSessionFile: () => undefined });
		await fake.fire("session_start", { ...event, reason: "new" }, ctx);
		expect(agentEvents.list(db.db, registeredWorkspace(root, db).id)).toHaveLength(2);
		close();
	});

	it("projects after the commits of one turn, once, not inside the committing call", async () => {
		const fake = fakeHost();
		let projections = 0;
		const close = registerArchiveLifecycle(fake.api, {
			canProject: () => {
				projections += 1;
				return true;
			},
			agentId: () => undefined,
			parentId: () => undefined,
		});
		const ctx = fakeCtx({ cwd: root });
		Object.assign(ctx.sessionManager, {
			getSessionFile: () => path.join(root, "not-created.jsonl"),
			getSessionId: () => "session",
		});
		await fake.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
		await new Promise((resolve) => setImmediate(resolve));
		const settled = projections;
		const shared = sharedAgentDb();
		const workspace = registeredWorkspace(root, shared).id;
		for (let n = 0; n < 5; n++)
			shared.transaction(() =>
				agentEvents.append(shared.db, workspace, {
					id: `burst-${n}`,
					time: new Date().toISOString(),
					name: null,
					parentId: null,
					sessionId: "session",
					type: "init",
					version: 1,
					data: { agentId: null, activationId: `burst-${n}`, reason: "startup", parentSession: null },
				}),
			);
		expect(projections).toBe(settled);
		await new Promise((resolve) => setImmediate(resolve));
		expect(projections).toBe(settled + 1);
		// A projection still queued when the session ends runs then, not never.
		shared.transaction(() =>
			agentEvents.append(shared.db, workspace, {
				id: "at-close",
				time: new Date().toISOString(),
				name: null,
				parentId: null,
				sessionId: "session",
				type: "init",
				version: 1,
				data: { agentId: null, activationId: "at-close", reason: "startup", parentSession: null },
			}),
		);
		close();
		expect(projections).toBe(settled + 2);
		shared.transaction(() => undefined);
		await new Promise((resolve) => setImmediate(resolve));
		expect(projections).toBe(settled + 2);
	});

	it("writes the view off the committing thread: no synchronous file write, one follow-up with the newest events", async () => {
		const fake = fakeHost();
		const close = registerArchiveLifecycle(fake.api, {
			canProject: () => true,
			agentId: () => undefined,
			parentId: () => undefined,
		});
		const ctx = fakeCtx({ cwd: root });
		Object.assign(ctx.sessionManager, {
			getSessionFile: () => path.join(root, "not-created.jsonl"),
			getSessionId: () => "session",
		});
		await fake.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
		const file = path.join(root, ".octocode/code/agents.txt");
		const syncWrites = [vi.spyOn(fs, "renameSync"), vi.spyOn(fs, "writeFileSync"), vi.spyOn(fs, "mkdirSync")];
		const shared = sharedAgentDb();
		const workspace = registeredWorkspace(root, shared).id;
		// Commits in successive turns: the second and third arrive while the first projection is writing.
		for (const id of ["one", "two", "three"]) {
			shared.transaction(() =>
				agentEvents.append(shared.db, workspace, {
					id,
					time: new Date().toISOString(),
					name: null,
					parentId: null,
					sessionId: "session",
					type: "init",
					version: 1,
					data: { agentId: null, activationId: id, reason: "startup", parentSession: null },
				}),
			);
			await new Promise((resolve) => setImmediate(resolve));
		}
		await vi.waitFor(() => expect(fs.readFileSync(file, "utf8")).toContain('"id":"three"'), { timeout: 5000 });
		const lines = fs.readFileSync(file, "utf8").trim().split("\n");
		expect(lines.map((line) => JSON.parse(line).id).slice(0, 3)).toEqual(["three", "two", "one"]);
		// No lock collided with this process's own projection: none is left behind, and nothing was written synchronously.
		expect(fs.existsSync(`${file}.lock`)).toBe(false);
		for (const spy of syncWrites)
			expect(spy.mock.calls.filter(([target]) => String(target).includes("agents.txt"))).toEqual([]);
		for (const spy of syncWrites) spy.mockRestore();
		close();
	});
});

it("retains a committed full summary when its detail folder cannot be written", async () => {
	const fake = fakeHost();
	const close = registerArchiveLifecycle(fake.api, {
		canProject: () => true,
		agentId: () => "amber-otter",
		parentId: () => undefined,
	});
	const ctx = fakeCtx({ cwd: root });
	Object.assign(ctx.sessionManager, {
		getSessionFile: () => path.join(root, "session.jsonl"),
		getSessionId: () => "write-failed",
	});
	const folder = archiveFolder("write-failed");
	fs.mkdirSync(path.dirname(folder), { recursive: true });
	fs.writeFileSync(folder, "not a directory");
	const entry = {
		type: "compaction",
		id: "full-summary",
		parentId: null,
		timestamp: new Date().toISOString(),
		summary: "The complete durable summary " + "retained text ".repeat(1000),
		firstKeptEntryId: "kept",
		tokensBefore: 1000,
	};
	await fake.fire("session_compact", { compactionEntry: entry }, ctx);
	expect(compactions.get(db.mirror.db, "write-failed", entry.id)).toMatchObject({
		summary: entry.summary,
		detailState: "missing",
	});
	expect(agentEvents.list(db.db, registeredWorkspace(root, db).id)[0]).toMatchObject({
		type: "compaction",
		name: "amber-otter",
	});
	Object.assign(ctx.sessionManager, { getSessionFile: () => undefined });
	await fake.fire("session_compact", { compactionEntry: { ...entry, id: "not-persisted" } }, ctx);
	expect(compactions.get(db.mirror.db, "write-failed", "not-persisted")).toBeUndefined();
	close();
});

it("keeps the next start reading only appended lines after a compaction of this session", async () => {
	const fake = fakeHost();
	const close = registerArchiveLifecycle(fake.api, {
		canProject: () => false,
		agentId: () => undefined,
		parentId: () => undefined,
	});
	const file = path.join(root, "long.jsonl");
	const timestamp = "2026-01-01T00:00:00Z";
	const entry = (id: string) => ({
		type: "compaction",
		id,
		parentId: null,
		timestamp,
		summary: `summary ${id}`,
		firstKeptEntryId: "kept",
		tokensBefore: 100,
	});
	const append = (...lines: unknown[]) =>
		fs.appendFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
	// The archive segment the compaction hook writes before this one runs.
	const segment = (id: string, n: number) => {
		const folder = archiveFolder("long", process.env, root);
		fs.mkdirSync(folder, { recursive: true });
		fs.writeFileSync(path.join(folder, `${n}-x-${id}.md`), "detail");
	};
	const ctx = fakeCtx({ cwd: root });
	Object.assign(ctx.sessionManager, { getSessionFile: () => file, getSessionId: () => "long" });
	segment("one", 1);
	append({ type: "session", version: 3, id: "long", cwd: root, timestamp }, entry("one"));
	const transcript = vi.spyOn(HistoryRepair.prototype, "transcript");
	await fake.fire("session_start", { type: "session_start", reason: "resume" }, ctx);
	const end = fs.statSync(file).size;
	// A turn and a live compaction of this session.
	segment("two", 2);
	append({ type: "message", id: "m1", text: "x".repeat(1000) }, entry("two"));
	await fake.fire("session_compact", { compactionEntry: entry("two") }, ctx);
	await fake.fire("session_start", { type: "session_start", reason: "resume" }, ctx);
	expect(transcript.mock.calls.map(([, from]) => from)).toEqual([0, end]);
	expect(compactions.forSession(db.mirror.db, "long").map((row) => row.entryId)).toEqual(["one", "two"]);
	close();
});
