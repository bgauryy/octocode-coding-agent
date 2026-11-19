import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentDb, agentEvents, agents, closeSharedAgentDb } from "../../../db/src/api.ts";
import { openAgentDb } from "../../src/storage/database.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { settleReason } from "../../src/octocode/team/session/end-reason.ts";
import { endWithParent } from "../../src/octocode/team/session/parent.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";

let root: string;
let db: AgentDb;
let store: TeamStore;
const member = (id = "amber-otter", extra: Partial<Member> = {}): Member => ({
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
const deletes = () =>
	agentEvents
		.list(db.db, registeredWorkspace(root, db).id)
		.filter((event) => event.type === "delete")
		.reverse();

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-end-")));
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

describe("the delete event's end record", () => {
	it("carries the leaver's reason and the last heartbeat's final stats", () => {
		const me = member("amber-otter", { started: "Wed Nov  4 10:00:00 2026" });
		expect(store.join(me)).toBe(true);
		store.save({
			...me,
			updatedAt: 5000,
			toolCalls: 7,
			input: 100,
			cacheRead: 40,
			output: 20,
			cost: 0.25,
			unpriced: true,
			status: "idle",
		});
		expect(store.remove(me.id, 6000, me, "completed")).toBe(true);
		const [end] = deletes();
		expect(end).toMatchObject({
			name: "amber-otter",
			version: 1,
			data: {
				agentId: "amber-otter",
				reason: "completed",
				startedAt: "Wed Nov  4 10:00:00 2026",
				joinedAt: 1000,
				seenAt: 5000,
				status: "idle",
				toolCalls: 7,
				input: 100,
				cacheRead: 40,
				output: 20,
				cost: 0.25,
				unpriced: true,
				pid: process.pid,
			},
		});
		expect(end?.data).not.toHaveProperty("detail");
	});

	it("falls back to `left` when the leaver names no reason, and to `crashed` when a peer reaps the row", () => {
		const a = member("amber-otter");
		const b = member("brisk-lynx", { pid: 2 ** 22 + 12345 });
		store.join(a);
		store.join(b);
		store.remove(a.id, 2000, a);
		store.sweep(3000);
		const reasons = Object.fromEntries(deletes().map((event) => [event.name, event.data.reason]));
		expect(reasons).toEqual({ "amber-otter": "left", "brisk-lynx": "crashed" });
	});

	it("names the reaping process and the verdict in a reaped member's delete event", () => {
		const gone = 2 ** 22 + 12345;
		store.join(member("brisk-lynx", { pid: gone }));
		store.sweep(3000);
		const end = deletes().find((event) => event.name === "brisk-lynx");
		expect(end?.data.reason).toBe("crashed");
		expect(end?.data.detail).toContain(`reaped by pid ${process.pid}`);
		expect(end?.data.detail).toContain(`pid ${gone} not running`);
	});

	it("keeps a reason for every value of the vocabulary", () => {
		for (const reason of agentEvents.END_REASONS) {
			const me = member(`agent-${reason}`);
			store.join(me);
			store.remove(me.id, 2000, me, reason);
		}
		expect(deletes().map((event) => event.data.reason)).toEqual([...agentEvents.END_REASONS]);
	});

	it("does not write the event of a nonpersistent registration", () => {
		db.transaction(() => agents.insert(db.db, root, registeredWorkspace(root, db), member()));
		db.transaction(() => agents.remove(db.db, "amber-otter", "completed"));
		expect(deletes()).toEqual([]);
	});
});

describe("who names the reason", () => {
	it("a run's settle names completed or failed, and says nothing for an abort", () => {
		expect(settleReason("completed")).toBe("completed");
		expect(settleReason("truncated")).toBe("completed");
		expect(settleReason("failed")).toBe("failed");
		expect(settleReason("aborted")).toBeUndefined();
		expect(settleReason(undefined)).toBeUndefined();
	});

	it("a child whose parent is gone leaves as parent-gone", () => {
		const leave = vi.fn();
		// terminateSelf would end this process, so the process-ending call is replaced for the test.
		const exit = vi.spyOn(process, "kill").mockImplementation(() => true);
		try {
			endWithParent(leave);
		} finally {
			exit.mockRestore();
		}
		expect(leave).toHaveBeenCalledWith("parent-gone");
	});
});
