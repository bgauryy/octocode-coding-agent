import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentEvents, archiveHistory, openDatabase, workspaces, type AgentDb } from "../src/api.ts";
import { tmp } from "./helpers.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 5, 1);
let agent: AgentDb;
beforeEach(() => {
	const dir = tmp();
	agent = openDatabase({
		file: path.join(dir, "agent.db"),
		mirrorFile: path.join(dir, "transcripts.db"),
		archiveDir: path.join(dir, "archive"),
		privateParent: false,
	});
	for (const id of ["ws", "other"]) workspaces.register(agent.db, { id, name: id, root: `/${id}`, binding: "1:1" });
});
afterEach(() => agent.close());

const add = (workspace: string, id: string, ageDays: number, sessionId: string | null = "s") =>
	agentEvents.append(agent.db, workspace, {
		id,
		time: new Date(NOW - ageDays * DAY).toISOString(),
		name: "agent",
		parentId: null,
		sessionId,
		type: "update",
		data: {},
		version: 1,
	});
const ids = (workspace: string) =>
	agentEvents
		.list(agent.db, workspace)
		.map((row) => row.id)
		.sort();

describe("agent event retention", () => {
	it("drops events past the keep window and keeps recent ones and each workspace's newest", () => {
		add("ws", "old-1", 90);
		add("ws", "old-2", 60);
		add("ws", "recent", 3);
		add("ws", "newest-old", 45);
		add("other", "other-old", 40, null);
		const head = agentEvents.head(agent.db);
		const result = archiveHistory(agent, NOW, { archiveAfterDays: 14, keepDays: 30 });
		expect(result.deleted).toBe(2);
		// Older rows of both workspaces go, even those of a session that still has files; the newest per workspace stays.
		expect(ids("ws")).toEqual(["newest-old", "recent"]);
		expect(ids("other")).toEqual(["other-old"]);
		expect(agentEvents.head(agent.db)).toBe(head);
	});

	it("keeps the sequence cursor valid after everything old is purged", () => {
		add("ws", "old", 90);
		archiveHistory(agent, NOW, { archiveAfterDays: 14, keepDays: 30 });
		const head = agentEvents.head(agent.db);
		expect(head).toBeGreaterThan(0);
		add("ws", "fresh", 0);
		expect(agentEvents.head(agent.db)).toBe(head + 1);
	});

	it("keeps the create event of an agent still in the team", () => {
		agent.db
			.prepare(
				"INSERT INTO agents(id, team, workspace_id, role, pid, status, joined_at, seen_at, registration_id) VALUES ('live','team','ws','main',1,'idle',1,1,'reg-live')",
			)
			.run();
		add("ws", "reg-live", 90);
		add("ws", "gone", 90);
		add("ws", "newest", 80);
		archiveHistory(agent, NOW, { archiveAfterDays: 14, keepDays: 30 });
		expect(ids("ws")).toEqual(["newest", "reg-live"]);
	});

	it("keeps every event when the keep window is off", () => {
		add("ws", "old", 400);
		add("ws", "older", 500);
		expect(archiveHistory(agent, NOW, { archiveAfterDays: 14, keepDays: 0 }).deleted).toBe(0);
		expect(ids("ws")).toEqual(["older", "old"].sort());
	});

	it("purges in batches", () => {
		for (let i = 0; i < 12; i++) add("ws", `old-${i}`, 90);
		add("ws", "newest", 2);
		expect(agentEvents.purgeBefore(agent.db, NOW - 30 * DAY, 5)).toBe(5);
		expect(agentEvents.purgeBefore(agent.db, NOW - 30 * DAY, 5)).toBe(5);
		expect(agentEvents.purgeBefore(agent.db, NOW - 30 * DAY, 5)).toBe(2);
		expect(ids("ws")).toEqual(["newest"]);
	});
});
