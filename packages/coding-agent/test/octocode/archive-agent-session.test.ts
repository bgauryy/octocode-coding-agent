import fs from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { agents, closeSharedAgentDb } from "../../../db/src/api.ts";
import { registerArchiveTool } from "../../src/octocode/archive/tool.ts";
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
	setCurrentSession("agent-session", cwd);
});
afterEach(() => {
	setCurrentSession(undefined);
	closeSharedAgentDb();
	vi.unstubAllEnvs();
});

function insert(id: string, sessionId?: string) {
	const agent = sharedAgentDb();
	agents.insert(
		agent.db,
		"session-test",
		{ id: registeredWorkspace(cwd, agent).id },
		{
			id,
			role: "implementer",
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
			...(sessionId ? { sessionId } : {}),
		},
	);
}

async function get(id: string): Promise<string> {
	const host = fakeHost();
	registerArchiveTool(host.api);
	const result = await host.tools
		.get("archive")
		.execute("agent-get", { reason: "Read one agent", op: "get", id }, undefined, undefined, fakeCtx({ cwd }));
	return result.content[0].text as string;
}

it("names the agent's session record, so the caller can read its transcript next", async () => {
	insert("worker", "0198-session-worker");
	insert("fresh");
	const worker = await get("agent:worker");
	expect(worker).toContain('"session": "session:0198-session-worker"');
	expect(worker).toContain('"role": "implementer"');
	const fresh = await get("agent:fresh");
	expect(fresh).toContain('"role": "implementer"');
	expect(fresh).not.toContain('"session":');
});
