import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	archiveHistory,
	agentRuns,
	agents,
	commands,
	history,
	openDatabase,
	processSamples,
	purge,
	sessions,
	shellHistory,
	timers,
	workspaces,
	type AgentDb,
} from "../src/api.ts";
import { tmp } from "./helpers.ts";
import { appendArchive, archiveSource, type ArchiveRecord } from "../src/history-archive.ts";

let agent: AgentDb;
beforeEach(() => {
	const dir = tmp();
	agent = openDatabase({
		file: path.join(dir, "agent.db"),
		mirrorFile: path.join(dir, "transcripts.db"),
		archiveDir: path.join(dir, "archive"),
		privateParent: false,
	});
	workspaces.register(agent.db, { id: "ws", name: "test", root: "/test", binding: "1:1" });
});
afterEach(() => agent.close());

describe("database retention boundaries", () => {
	it("retains registered active runs while deleting ended and unregistered old runs", () => {
		const join = (id: string, at: number) => {
			agents.insert(
				agent.db,
				"team",
				{ id: "ws" },
				{
					id,
					role: "main",
					pid: process.pid,
					status: "working",
					joinedAt: at,
					updatedAt: at,
					toolCalls: 0,
					input: 0,
					cacheRead: 0,
					output: 0,
					cost: 0,
					unpriced: false,
				},
				{ sessionId: id, activationId: `${id}-${at}` },
			);
		};
		join("live", 1);
		join("reused", 1);
		agents.remove(agent.db, "reused", "stopped", 2);
		join("reused", 3);
		agentRuns.begin(agent.db, { workspaceId: "ws", agentId: "orphan" }, 1);
		expect(agentRuns.purgeBefore(agent.db, 10)).toBe(2);
		expect(agentRuns.latest(agent.db, "live")?.endedAt).toBeUndefined();
		expect(agentRuns.latest(agent.db, "live")).toBeDefined();
		expect(agentRuns.latest(agent.db, "reused")).toMatchObject({ startedAt: 3, endedAt: undefined });
		expect(agentRuns.latest(agent.db, "orphan")).toBeUndefined();
	});

	it("retains old active timers whose next wake is still inside or beyond the retention window", () => {
		const add = (dueAt: number, at = 1) =>
			timers.insert(agent.db, { workspaceId: "ws", sessionId: "s", note: "wake", kind: "once", dueAt, at });
		const stale = add(5);
		const boundary = add(10);
		const pending = add(20);
		const recent = add(5, 10);
		expect(timers.purgeBefore(agent.db, 10)).toBe(1);
		expect(timers.get(agent.db, stale.id)).toBeUndefined();
		for (const timer of [boundary, pending, recent]) expect(timers.get(agent.db, timer.id)).toBeDefined();
	});

	it("removes shell command history from an all-data purge and reports its rows", () => {
		shellHistory.record(agent.db, "/test", "private command", 1);
		shellHistory.record(agent.db, "/elsewhere", "other command", 2);
		const counts = purge.all(agent.db, agent.mirror.db);
		expect(counts.shell_history).toBe(2);
		expect(shellHistory.recent(agent.db, 10)).toEqual([]);
	});

	it("purges process samples while preserving those of kept sessions", () => {
		sessions.start(agent.db, "kept", 1, null, null);
		for (const [index, sessionId] of ["kept", "removed", null].entries())
			processSamples.record(agent.db, {
				at: index,
				pid: index + 1,
				started: "1",
				ppid: 0,
				role: "main",
				title: "test",
				id: String(index),
				sessionId,
				agentId: null,
				ownerPid: null,
				ownerStarted: null,
				cwd: null,
				rss: 0,
				heapUsed: 0,
				ended: true,
				children: [],
			});
		expect(purge.all(agent.db, agent.mirror.db, { keepSessions: ["kept"] }).process_samples).toBe(2);
		expect(processSamples.since(agent.db, 0).map((sample) => sample.sessionId)).toEqual(["kept"]);
	});

	it("does not delete a command receipt updated after its archive snapshot was read", () => {
		commands.insertAccepted(
			agent.db,
			{ id: "c", session: "s", repo: "ws", action: "prompt", input: "{}" },
			1,
			"queued",
		);
		const snapshot = history.rowsBefore(agent.db, "workspace_commands", 10, 10);
		commands.setStatus(agent.db, "ws", "s", "c", "completed", "finished");
		expect(agent.transaction(() => history.deleteRows(agent.db, "workspace_commands", snapshot))).toBe(0);
		expect(commands.byId(agent.db, "ws", "s", "c")).toMatchObject({ status: "completed", message: "finished" });
		const current = history.rowsBefore(agent.db, "workspace_commands", 10, 10);
		expect(agent.transaction(() => history.deleteRows(agent.db, "workspace_commands", current))).toBe(1);
	});

	it("retains a changed receipt for the next archive pass without holding the database lock during archive IO", () => {
		const at = Date.UTC(2026, 0, 1);
		commands.insertAccepted(
			agent.db,
			{ id: "c", session: "s", repo: "ws", action: "prompt", input: "{}" },
			at,
			"queued",
		);
		const transaction = agent.transaction;
		let updated = false;
		const spy = vi.spyOn(agent, "transaction").mockImplementation((work) => {
			if (!updated) {
				updated = true;
				// A peer's final status commits after the archive snapshot, before its delete transaction.
				commands.setStatus(agent.db, "ws", "s", "c", "completed", "finished");
			}
			return transaction(work);
		});
		try {
			expect(archiveHistory(agent, at + 20 * 24 * 3600 * 1000)).toMatchObject({ archived: 1, deleted: 0 });
		} finally {
			spy.mockRestore();
		}
		expect(archiveHistory(agent, at + 20 * 24 * 3600 * 1000)).toMatchObject({ archived: 1, deleted: 1 });
		const file = path.join(agent.archiveDir, "workspace-commands-2026-01.jsonl.gz");
		const archived = gunzipSync(fs.readFileSync(file))
			.toString("utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(archived.map((record) => record.row.status)).toEqual(["accepted", "completed"]);
	});

	it("retains a newer archived receipt when an older archiver appends its snapshot afterwards", () => {
		const at = Date.UTC(2026, 0, 1);
		commands.insertAccepted(
			agent.db,
			{ id: "c", session: "s", repo: "ws", action: "prompt", input: "{}" },
			at,
			"queued",
		);
		const stale = history.rowsBefore(agent.db, "workspace_commands", at + 1, 10)[0];
		commands.setStatus(agent.db, "ws", "s", "c", "completed", "finished");
		const now = at + 20 * 24 * 3600 * 1000;
		expect(archiveHistory(agent, now)).toMatchObject({ archived: 1, deleted: 1 });
		const record: ArchiveRecord = {
			db: archiveSource(agent),
			id: JSON.stringify(["ws", "s", "c"]),
			at,
			row: stale as ArchiveRecord["row"],
		};
		for (let retry = 0; retry < 2; retry++)
			appendArchive(agent.archiveDir, "workspace-commands", [record], now, Infinity);
		const file = path.join(agent.archiveDir, "workspace-commands-2026-01.jsonl.gz");
		const archived = gunzipSync(fs.readFileSync(file))
			.toString("utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(archived.map((row) => row.row.status)).toEqual(["completed", "accepted"]);
		expect(commands.byId(agent.db, "ws", "s", "c")).toBeUndefined();
	});
});
