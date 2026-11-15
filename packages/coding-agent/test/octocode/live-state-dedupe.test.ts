import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { liveStateLines } from "../../src/octocode/compaction/live-state.ts";
import { ongoingBrief } from "../../src/octocode/sessions/brief.ts";

const SESSION = "session-dedupe";
let dir: string;
let savedDb: string | undefined;
let savedHome: string | undefined;

beforeEach(() => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-live-dedupe-")));
	savedDb = process.env.OCTOCODE_AGENT_DB;
	savedHome = process.env.OCTOCODE_HOME;
	process.env.OCTOCODE_AGENT_DB = path.join(dir, "home", "octocode.db");
	process.env.OCTOCODE_HOME = path.join(dir, "octo-home");
	fs.mkdirSync(path.join(dir, "repo"), { recursive: true });
});
afterEach(() => {
	closeSharedAgentDb();
	if (savedDb === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = savedDb;
	if (savedHome === undefined) delete process.env.OCTOCODE_HOME;
	else process.env.OCTOCODE_HOME = savedHome;
	fs.rmSync(dir, { recursive: true, force: true });
});

const cwd = () => path.join(dir, "repo");
const ctx = () =>
	({ cwd: cwd(), sessionManager: { getSessionId: () => SESSION, getSessionFile: () => undefined } }) as never;

describe("ongoing backlog items after a compaction", () => {
	it("are named once across the Recovery live state and the session-state brief", () => {
		const agent = sharedAgentDb();
		const repo = registeredWorkspace(cwd(), agent).id;
		const store = new BacklogStore(() => agent, repo);
		store.add({
			title: "Dedupe unique title",
			goal: "the goal",
			why: "Required work",
			state: "todo",
			createdBy: "agent",
		});
		store.update("B1", { state: "ongoing" }, { id: SESSION });
		const context = [...liveStateLines(ctx(), [], 0), ...ongoingBrief(agent, repo, SESSION)].join("\n");
		expect(context.match(/Dedupe unique title/g)).toHaveLength(1);
		// The brief, read after the summary, is the copy kept; it carries the goal.
		expect(context).toContain("goal: the goal");
	});

	it("still lets the Recovery block deny an item the summary invented when the session holds none", () => {
		expect(liveStateLines(ctx(), [], 0)[0]).toContain("this session holds: none.");
	});
});
