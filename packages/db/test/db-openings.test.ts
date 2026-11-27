import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, openings, purge, type AgentDb } from "../src/api.ts";
import { tmp } from "./helpers.ts";

let agent: AgentDb;
beforeEach(() => {
	const dir = tmp();
	agent = openDatabase({
		file: path.join(dir, "agent.db"),
		mirrorFile: path.join(dir, "transcripts.db"),
		archiveDir: path.join(dir, "archive"),
		privateParent: false,
	});
});
afterEach(() => agent.close());

describe("openings", () => {
	it("records, looks up and forgets who opened a thing", () => {
		openings.record(agent.db, "worktree", "/x/wt", "agent-1", "s1", 5);
		expect(openings.lookup(agent.db, "worktree", ["/x/wt", "/none"]).get("/x/wt")).toEqual({
			opener: "agent-1",
			sessionId: "s1",
			openedAt: 5,
		});
		openings.forget(agent.db, "worktree", "/x/wt");
		expect(openings.lookup(agent.db, "worktree", ["/x/wt"]).size).toBe(0);
	});

	it("is emptied by purge.all", () => {
		openings.record(agent.db, "worktree", "/x/wt", "agent-1", "s1", 1);
		openings.record(agent.db, "tmux", "%3", "agent-2", undefined, 2);
		const counts = purge.all(agent.db, agent.mirror.db);
		expect(counts.worktree_openings).toBe(2);
		expect(openings.lookup(agent.db, "worktree", ["/x/wt"]).size).toBe(0);
		expect(openings.lookup(agent.db, "tmux", ["%3"]).size).toBe(0);
	});
});
