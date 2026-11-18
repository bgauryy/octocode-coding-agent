import fs from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { agents, closeSharedAgentDb } from "../../../db/src/api.ts";
import { registerArchiveTool } from "../../src/octocode/native/tools/archive/tool.ts";
import { setCurrentSession } from "../../src/octocode/shared/home.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

let cwd: string;
beforeEach(() => {
	vi.stubEnv("OCTOCODE_HOME", tmp());
	cwd = tmp();
	fs.mkdirSync(`${cwd}/.git`);
	setCurrentSession("pagination", cwd);
});
afterEach(() => {
	setCurrentSession(undefined);
	closeSharedAgentDb();
	vi.unstubAllEnvs();
});

function insert(id: string) {
	const agent = sharedAgentDb();
	agents.insert(
		agent.db,
		"page-test",
		{ id: registeredWorkspace(cwd, agent).id },
		{
			id,
			role: "coordinator",
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
		},
	);
}

function list(cursor?: string) {
	const host = fakeHost();
	registerArchiveTool(host.api);
	return host.tools.get("archive").execute(
		"agent-page",
		{
			reason: "Inspect active agents across pages",
			op: "list",
			source: "agents",
			limit: 1,
			cursor,
		},
		undefined,
		undefined,
		fakeCtx({ cwd }),
	);
}

it("does not repeat an agent when another departs between pages", async () => {
	for (const name of ["a", "b", "c"]) insert(name);
	const first = await list();
	expect(first.content[0].text).toContain("agent:a");
	agents.remove(sharedAgentDb().db, "c");
	const second = await list(first.details.nextCursor);
	expect(second.content[0].text).toContain("agent:b");
	expect(second.content[0].text).not.toContain("agent:a");
	expect(second.details.nextCursor).toBeUndefined();
});

it("does not skip a surviving agent when a name is inserted before the cursor", async () => {
	for (const name of ["b", "c", "d"]) insert(name);
	const first = await list();
	expect(first.content[0].text).toContain("agent:b");
	insert("a");
	const second = await list(first.details.nextCursor);
	expect(second.content[0].text).toContain("agent:c");
	expect(second.content[0].text).not.toContain("agent:d");
	const third = await list(second.details.nextCursor);
	expect(third.content[0].text).toContain("agent:d");
	expect(third.details.nextCursor).toBeUndefined();
});

it("does not skip a surviving agent when a name is inserted after the cursor", async () => {
	for (const name of ["b", "c", "d"]) insert(name);
	const first = await list();
	insert("z");
	const second = await list(first.details.nextCursor);
	expect(second.content[0].text).toContain("agent:c");
});

it("accepts an older positional cursor and returns a stable continuation", async () => {
	for (const name of ["a", "b", "c"]) insert(name);
	const legacy = Buffer.from(JSON.stringify({ agents: { seq: 3 } })).toString("base64url");
	const second = await list(legacy);
	expect(second.content[0].text).toContain("agent:b");
	agents.remove(sharedAgentDb().db, "a");
	const third = await list(second.details.nextCursor);
	expect(third.content[0].text).toContain("agent:c");
	expect(third.details.nextCursor).toBeUndefined();
});
