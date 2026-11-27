import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentRunChildren, agentRuns, openDatabase, type AgentDb } from "../src/api.ts";
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
	agent.db.prepare("INSERT INTO workspaces(id,name,root,binding) VALUES ('w','fixture','/owned-fixture','1:1')").run();
});
afterEach(() => agent.close());

const start = (agentId: string, parentSessionId: string) =>
	agentRuns.begin(agent.db, { workspaceId: "w", agentId, parentSessionId }, 1);

describe("agentRunChildren.countBySession", () => {
	it("counts direct child runs per session in one result, omitting sessions with none", () => {
		start("a1", "s1");
		start("a2", "s1");
		start("a3", "s2");
		expect(agentRunChildren.countBySession(agent.db, ["s1", "s2", "s3"])).toEqual(
			new Map([
				["s1", 2],
				["s2", 1],
			]),
		);
	});

	it("handles an empty list and more ids than one query holds", () => {
		start("a1", "s1");
		expect(agentRunChildren.countBySession(agent.db, []).size).toBe(0);
		const ids = Array.from({ length: 1200 }, (_, i) => `x${i}`);
		ids.push("s1");
		expect(agentRunChildren.countBySession(agent.db, ids)).toEqual(new Map([["s1", 1]]));
	});
});
