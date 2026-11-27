import { openWorkspaceDb, registeredWorkspace, workspaceDb } from "../../src/storage/workspace-database.ts";
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
let machine: AgentDb;
/** The workspace file of `root` (the machine file while workspace files are off). */
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
	machine = openAgentDb();
	db = openWorkspaceDb(machine, root).agent;
});
afterEach(() => {
	if (db !== machine) db.close();
	machine.close();
	closeSharedAgentDb();
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

/**
 * Yields to the event loop until `done()` holds, advancing a faked `setTimeout` clock by one projection retry (250 ms)
 * each round; fails after 10 s of real time. A projection is file work: its end is awaited, never a fixed number of turns.
 */
async function until(done: () => boolean, what: string): Promise<void> {
	const deadline = performance.now() + 10_000;
	while (!done()) {
		if (performance.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(250);
		await new Promise((resolve) => setImmediate(resolve));
	}
}

/** Commits an `init` event of `cwd`'s workspace to `agent`. */
function appendInit(agent: AgentDb, cwd: string, id: string): void {
	agent.transaction(() =>
		agentEvents.append(agent.db, registeredWorkspace(cwd, agent).id, {
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
}

describe("durable agent lifecycle", () => {
	it("commits identity and events together, separates name reuse and excludes heartbeats", () => {
		const store = TeamStore.open(root, machine.file);
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
		const file = path.join(root, ".octocode/agent/agents.txt");
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
		// The note names the file to remove, not only its name: the user can act on it from anywhere.
		await expect(projectAgents(other, root)).rejects.toThrow(`remove ${file} to rebind it`);
		expect(fs.readFileSync(file, "utf8")).toBe(content);
		other.close();
		fs.unlinkSync(file);
		await projectAgents(db, root);
		expect(fs.readFileSync(file, "utf8")).toBe(content);
		fs.writeFileSync(file, JSON.stringify({ ...rows[0], time: "bad" }) + "\n");
		await expect(projectAgents(db, root)).rejects.toThrow("another database or format");
		fs.writeFileSync(file, "\n");
		await expect(projectAgents(db, root)).rejects.toThrow(`remove ${file} to rebuild it`);
		// A line that is not JSON is a file that is not a view: refused the same way, not reported as a parse error.
		fs.writeFileSync(file, "not json\n");
		await expect(projectAgents(db, root)).rejects.toThrow(`Invalid agents.txt; remove ${file} to rebuild it.`);
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
		const file = path.join(root, ".octocode/agent/agents.txt");
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
		fs.mkdirSync(path.join(root, ".octocode/agent"), { recursive: true });
		const file = path.join(root, ".octocode/agent/agents.txt");
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
		// Its own checkout boundary: the workspace of `root` does not absorb it.
		fs.mkdirSync(path.join(project, ".git"), { recursive: true });
		const original = registeredWorkspace(project, db);
		fs.renameSync(project, path.join(root, "retired"));
		fs.mkdirSync(path.join(project, ".git"), { recursive: true });
		const replacement = registeredWorkspace(project, db);
		expect(replacement.id).not.toBe(original.id);
		await expect(projectAgents(db, project, original)).rejects.toThrow(/path changed/);
		expect(fs.existsSync(path.join(project, ".octocode/agent/agents.txt"))).toBe(false);
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

	it("projects the view in a top-level session but not in a subagent process", async () => {
		const view = path.join(root, ".octocode", "agent", "agents.txt");
		const commit = async (subagent: boolean) => {
			vi.stubEnv("OCTOCODE_SUBAGENT", subagent ? "1" : "");
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
			await new Promise((resolve) => setTimeout(resolve, 50));
			close();
		};
		await commit(true);
		expect(fs.existsSync(view)).toBe(false);
		await commit(false);
		expect(fs.existsSync(view)).toBe(true);
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
		const { agent: shared, workspace: identity } = workspaceDb(root);
		const workspace = identity.id;
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
		const file = path.join(root, ".octocode/agent/agents.txt");
		const syncWrites = [vi.spyOn(fs, "renameSync"), vi.spyOn(fs, "writeFileSync"), vi.spyOn(fs, "mkdirSync")];
		const { agent: shared, workspace: identity } = workspaceDb(root);
		const workspace = identity.id;
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

	it("rebuilds on the next commit when a foreign view is removed while its contents are being checked", async () => {
		const view = path.join(root, ".octocode", "agent", "agents.txt");
		fs.mkdirSync(path.dirname(view), { recursive: true });
		fs.writeFileSync(view, "foreign data");
		const read = fs.promises.readFile.bind(fs.promises);
		const reads = vi.spyOn(fs.promises, "readFile").mockImplementation(async (...args) => {
			const contents = await read(...args);
			if (String(args[0]) === view && fs.existsSync(`${view}.lock`) && contents === "foreign data") fs.unlinkSync(view);
			return contents;
		});
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
		try {
			await fake.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
			await until(() => ctx.ui.notes.some((note) => note.message.includes("Invalid agents.txt")), "the warning");
			appendInit(workspaceDb(root).agent, root, "after-removal");
			await until(
				() =>
					fs.existsSync(view) &&
					fs.readFileSync(view, "utf8").includes('"id":"after-removal"') &&
					!fs.existsSync(`${view}.lock`),
				"the replacement view",
			);
		} finally {
			reads.mockRestore();
			close();
		}
	});

	it("warns once per problem, stops projecting into a foreign view until it changes, and recovers when it is removed", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const view = path.join(root, ".octocode", "agent", "agents.txt");
		fs.mkdirSync(path.dirname(view), { recursive: true });
		const foreignRow = {
			id: "old",
			time: new Date(0).toISOString(),
			name: null,
			parentId: null,
			sessionId: null,
			type: "init",
			version: 1,
			data: { storeKey: "another-database" },
		};
		fs.writeFileSync(view, `${JSON.stringify(foreignRow)}\n`);
		fs.mkdirSync(`${view}.lock`);
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
		const shared = workspaceDb(root).agent;
		const commit = (id: string) => appendInit(shared, root, id);
		const warnings = (pattern: RegExp) =>
			ctx.ui.notes.filter((note) => pattern.test(note.message) && note.type === "warning").length;
		// The lock library creates the view's lock directory with callback `fs.mkdir`: one call is one attempt. (A spy on
		// `fs.promises.mkdir` saw none, so the count stayed 0 and its assertions held whatever the lifecycle did.)
		const locks = vi.spyOn(fs, "mkdir");
		const lockAttempts = () => locks.mock.calls.filter(([target]) => String(target) === `${view}.lock`).length;
		// A projection asked for while the view is known to be foreign starts by reading the view's signature.
		const stats = vi.spyOn(fs.promises, "stat");
		const viewChecks = () => stats.mock.calls.filter(([target]) => String(target) === view).length;
		/** Commits `id` and waits until the projection it asks for has read the foreign view's signature. */
		const commitAndCheck = async (id: string) => {
			const checks = viewChecks();
			commit(id);
			await until(() => viewChecks() > checks, `the projection after commit ${id}`);
		};
		try {
			// The lock is held the whole time: the retries run out, and the warning comes once.
			await fake.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
			await until(() => warnings(/lock/i) > 0, "the held-lock warning");
			expect(warnings(/lock/i)).toBe(1);
			// One retry budget: every attempt from the first to the warning. A later commit gets a fresh one.
			const budget = lockAttempts();
			commit("held");
			await until(() => lockAttempts() >= 2 * budget, "the second retry budget to run out");
			expect(warnings(/lock/i)).toBe(1);
			// Only retry waits need a fake clock. A real lock's heartbeat and the filesystem must share elapsed time.
			vi.useRealTimers();
			// The lock frees: the foreign view is the next problem, reported once however often the problems alternate.
			fs.rmdirSync(`${view}.lock`);
			commit("foreign");
			await until(() => warnings(/another database/) > 0, "the foreign-view warning");
			expect(warnings(/another database/)).toBe(1);
			fs.mkdirSync(`${view}.lock`);
			for (const id of ["a", "b", "c"]) await commitAndCheck(id);
			// A permanent problem is not tried again: the held lock is never met, nothing warns more.
			expect(warnings(/lock/i)).toBe(1);
			expect(warnings(/another database/)).toBe(1);
			fs.rmdirSync(`${view}.lock`);
			const attempts = lockAttempts();
			await commitAndCheck("d");
			expect(lockAttempts()).toBe(attempts);
			expect(fs.readFileSync(view, "utf8")).toContain("another-database");
			// Removing the foreign file lets the next commit project.
			fs.rmSync(view);
			commit("e");
			await until(
				() =>
					fs.existsSync(view) && fs.readFileSync(view, "utf8").includes('"id":"e"') && !fs.existsSync(`${view}.lock`),
				"the view to be rebuilt",
			);
			expect(fs.readFileSync(view, "utf8")).toContain('"id":"e"');
			// Projections run one at a time, so every earlier one has ended: the only lock taken since is the rebuild's.
			expect(lockAttempts()).toBe(attempts + 1);
			expect(ctx.ui.notes.filter((note) => note.type === "warning")).toHaveLength(2);
		} finally {
			locks.mockRestore();
			stats.mockRestore();
			vi.useRealTimers();
			close();
		}
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

describe("archive warnings in a print run", () => {
	/** One `octocode -p` run as the archive sees it: a session without UI, whose warnings go to stderr. */
	async function printRun(project: string, sessionId: string, during?: () => Promise<void>): Promise<string[]> {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const fake = fakeHost();
		const close = registerArchiveLifecycle(fake.api, {
			canProject: () => true,
			agentId: () => undefined,
			parentId: () => undefined,
		});
		const ctx = fakeCtx({ cwd: project, hasUI: false });
		Object.assign(ctx.sessionManager, {
			getSessionFile: () => path.join(root, `${sessionId}.jsonl`),
			getSessionId: () => sessionId,
		});
		try {
			await fake.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
			await during?.();
			return stderr.mock.calls.map(([text]) => String(text)).filter((text) => text.startsWith("Archive persistence"));
		} finally {
			close();
			stderr.mockRestore();
		}
	}

	it("prints none in a new workspace or over a view the home's database wrote before it moved, and one for another database's view", async () => {
		const project = path.join(root, "project");
		// Its own checkout boundary: the workspace of `root` does not absorb it.
		fs.mkdirSync(path.join(project, ".git"), { recursive: true });
		// A normal home: without OCTOCODE_HOME or OCTOCODE_AGENT_DB the database is `~/.octocode/agent/workspaces.db`.
		const home = path.join(root, "user");
		vi.stubEnv("HOME", home);
		vi.stubEnv("OCTOCODE_HOME", undefined);
		vi.stubEnv("OCTOCODE_AGENT_DB", undefined);
		expect(sharedAgentDb().file).toBe(path.join(home, ".octocode", "agent", "workspaces.db"));
		const view = path.join(project, ".octocode", "agent", "agents.txt");
		const keys = () =>
			new Set(
				fs
					.readFileSync(view, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line).data.storeKey),
			);
		const viewFrom = async (file: string, id: string) => {
			fs.rmSync(view, { force: true });
			const other = openAgentDb(file);
			appendInit(other, project, id);
			await projectAgents(other, project);
			other.close();
		};

		expect(await printRun(project, "first")).toEqual([]);
		const own = keys();
		expect(own.size).toBe(1);
		expect(await printRun(project, "second")).toEqual([]);

		// Before agent state moved to the shared root, the home's database was `~/.octocode/octocodecode/agent/workspaces.db`:
		// every workspace a session used then holds a view bound to it. The next run rebinds it without a word.
		const former = path.join(home, ".octocode", "octocodecode", "agent", "workspaces.db");
		fs.mkdirSync(path.dirname(former), { recursive: true });
		await viewFrom(former, "before-the-move");
		expect(keys()).not.toEqual(own);
		expect(await printRun(project, "after-the-move")).toEqual([]);
		expect(keys()).toEqual(own);

		// Another database's view is refused and kept: one warning, however many commits the run makes.
		await viewFrom(path.join(root, "other.db"), "elsewhere");
		const foreign = fs.readFileSync(view, "utf8");
		const stats = vi.spyOn(fs.promises, "stat");
		const viewChecks = () => stats.mock.calls.filter(([target]) => String(target) === view).length;
		try {
			const warned = await printRun(project, "foreign", async () => {
				for (const id of ["one", "two"]) {
					const checks = viewChecks();
					appendInit(workspaceDb(project).agent, project, id);
					await until(() => viewChecks() > checks, `the projection after commit ${id}`);
				}
			});
			expect(warned).toEqual([
				`Archive persistence: agents.txt belongs to another database or format; remove ${view} to rebind it.\n`,
			]);
		} finally {
			stats.mockRestore();
		}
		expect(fs.readFileSync(view, "utf8")).toBe(foreign);
	});
});
