import { registeredWorkspace } from "../../src/config/workspace-database.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentEvents, agents, compactions, type AgentDb, closeSharedAgentDb } from "../../../db/src/api.ts";
import { openAgentDb } from "../../src/config/database.ts";
import { archiveFolder } from "../../src/octocode/shared/archive.ts";
import { projectAgents } from "../../src/octocode/archive/projection.ts";
import { registerArchiveLifecycle } from "../../src/octocode/archive/lifecycle.ts";
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
	it("projects only the newest 50 and binds to the first database", () => {
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
		projectAgents(db, root);
		const file = path.join(root, ".octa/code/agents.txt");
		const content = fs.readFileSync(file, "utf8");
		const rows = content
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(rows).toHaveLength(50);
		expect(rows[0].id).toBe("event-54");
		expect(agentEvents.list(db.db, registeredWorkspace(root, db).id, Number.MAX_SAFE_INTEGER, 100)).toHaveLength(55);
		const other = openAgentDb(path.join(root, "other.db"));
		expect(() => projectAgents(other, root)).toThrow("another database");
		expect(fs.readFileSync(file, "utf8")).toBe(content);
		other.close();
		fs.unlinkSync(file);
		projectAgents(db, root);
		expect(fs.readFileSync(file, "utf8")).toBe(content);
		fs.writeFileSync(file, JSON.stringify({ ...rows[0], time: "bad" }) + "\n");
		expect(() => projectAgents(db, root)).toThrow("another database or format");
	});
	it("takes no lock when the view is current, and reports a held lock as ELOCKED for a quiet retry", () => {
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
		projectAgents(db, root);
		const file = path.join(root, ".octa/code/agents.txt");
		const content = fs.readFileSync(file, "utf8");
		// Another process holds the view's lock: a commit that changed no event does not wait for it or fail.
		fs.mkdirSync(`${file}.lock`);
		expect(() => projectAgents(db, root)).not.toThrow();
		// A new event needs the lock: the error is ELOCKED, which the lifecycle retries instead of warning.
		event("second");
		expect(() => projectAgents(db, root)).toThrow(expect.objectContaining({ code: "ELOCKED" }));
		expect(fs.readFileSync(file, "utf8")).toBe(content);
		fs.rmdirSync(`${file}.lock`);
		projectAgents(db, root);
		expect(fs.readFileSync(file, "utf8")).toContain('"id":"second"');
	});
	it("refuses symlink and empty projections without overwriting them", () => {
		fs.mkdirSync(path.join(root, ".octa/code"), { recursive: true });
		const file = path.join(root, ".octa/code/agents.txt");
		fs.writeFileSync(file, "");
		expect(() => projectAgents(db, root)).toThrow("Invalid");
		fs.unlinkSync(file);
		const target = path.join(root, "outside");
		fs.writeFileSync(target, "unchanged");
		fs.symlinkSync(target, file);
		expect(() => projectAgents(db, root)).toThrow("symlink");
		expect(fs.readFileSync(target, "utf8")).toBe("unchanged");
	});
	it("does not export a live listener's old events into a replacement checkout", () => {
		const project = path.join(root, "checkout");
		fs.mkdirSync(project);
		const original = registeredWorkspace(project, db);
		fs.renameSync(project, path.join(root, "retired"));
		fs.mkdirSync(project);
		const replacement = registeredWorkspace(project, db);
		expect(replacement.id).not.toBe(original.id);
		expect(() => projectAgents(db, project, original)).toThrow(/path changed/);
		expect(fs.existsSync(path.join(project, ".octa/code/agents.txt"))).toBe(false);
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
	expect(compactions.get(db.db, "write-failed", entry.id)).toMatchObject({
		summary: entry.summary,
		detailState: "missing",
	});
	expect(agentEvents.list(db.db, registeredWorkspace(root, db).id)[0]).toMatchObject({
		type: "compaction",
		name: "amber-otter",
	});
	Object.assign(ctx.sessionManager, { getSessionFile: () => undefined });
	await fake.fire("session_compact", { compactionEntry: { ...entry, id: "not-persisted" } }, ctx);
	expect(compactions.get(db.db, "write-failed", "not-persisted")).toBeUndefined();
	close();
});
