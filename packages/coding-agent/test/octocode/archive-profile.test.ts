import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentDb, closeSharedAgentDb, sessions } from "../../../db/src/api.ts";
import { openAgentDb } from "../../src/storage/database.ts";
import { registerArchiveTool } from "../../src/octocode/archive/tool.ts";
import { setCurrentSession } from "../../src/octocode/shared/home.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

const T = Date.UTC(2026, 10, 8, 10, 0, 0);
let root: string;
let db: AgentDb;
let store: TeamStore;
let env: NodeJS.ProcessEnv;
let n = 0;

const line = (ms: number, body: Record<string, unknown>) =>
	JSON.stringify({
		id: `e${n}`,
		parentId: n++ ? `e${n - 2}` : null,
		timestamp: new Date(T + ms).toISOString(),
		...body,
	});
const system = (ms: number, environment: string) =>
	line(ms, { type: "message", message: { role: "system", content: "b".repeat(4000), sections: { environment } } });
const user = (ms: number, content: string) => line(ms, { type: "message", message: { role: "user", content } });
const reply = (ms: number, usage: Record<string, number>) =>
	line(ms, {
		type: "message",
		message: {
			role: "assistant",
			content: "x",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			timestamp: T + ms - 500,
			durationMs: 500,
			usage: { output: 1, input: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 }, ...usage },
		},
	});
const transcript = (name: string, lines: string[]): string => {
	n = 0;
	const file = path.join(root, `${name}.jsonl`);
	fs.writeFileSync(file, lines.join("\n") + "\n");
	return file;
};
const stored = (id: string, file: string, lastActive: number, cwd = root) =>
	sessions.saveCatalog(db.db, id, {
		title: null,
		titleSource: null,
		cwd,
		file,
		parentFile: null,
		createdAt: T,
		lastActive,
		messageCount: 1,
		firstPrompt: null,
		fileMtime: null,
	});
const member = (id: string, extra: Partial<Member> = {}): Member => ({
	id,
	role: "main",
	pid: process.pid,
	status: "working",
	joinedAt: Date.now(),
	updatedAt: Date.now(),
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
	...extra,
});

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octocode-profile-")));
	env = { ...process.env, OCTOCODE_HOME: path.join(root, "home"), OCTOCODE_AGENT_DB: path.join(root, "agent.db") };
	vi.stubEnv("OCTOCODE_HOME", env.OCTOCODE_HOME);
	vi.stubEnv("OCTOCODE_AGENT_DB", env.OCTOCODE_AGENT_DB);
	fs.mkdirSync(path.join(root, ".git"));
	db = openAgentDb();
	store = TeamStore.open(root, db.file);

	const mainFile = transcript("main", [
		line(0, { type: "session" }),
		system(1000, "date 1"),
		user(2000, "go"),
		reply(3000, { cacheWrite: 30_000 }),
		system(4000, "date 2"),
		user(5000, "next"),
		reply(6000, { cacheRead: 2000, cacheWrite: 60_000 }),
	]);
	const kidFile = transcript("kid", [
		line(0, { type: "session" }),
		system(1000, "date 1"),
		user(2000, "research"),
		reply(3000, { cacheWrite: 12_000 }),
	]);
	stored("sess-main", mainFile, T + 10_000);
	stored("sess-kid", kidFile, T + 5000);
	stored("sess-elsewhere", mainFile, T + 99_000, path.join(root, "other"));
	store.lifecycle = { activationId: "a1", sessionId: "sess-main" };
	store.join(member("steady-main"));
	store.lifecycle = { activationId: "a2", sessionId: "sess-kid" };
	store.join(member("quick-finch", { role: "researcher", parentId: "steady-main", goal: "find the callers" }));
	store.send("steady-main", ["quick-finch"], "start with the db layer", { replyRequired: false });
	// The child has left: its run, session row and transcript are all a profile of an ended session has.
	store.remove("quick-finch");
});
afterEach(() => {
	store.close();
	db.close();
	closeSharedAgentDb();
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

async function profile(params: Record<string, unknown>): Promise<string> {
	const fake = fakeHost();
	registerArchiveTool(fake.api);
	const out = await fake.tools
		.get("archive")
		.execute(
			"t1",
			{ reason: "inspect the cache", source: "profile", ...params },
			undefined,
			undefined,
			fakeCtx({ cwd: root }),
		);
	return out.content[0].text as string;
}

describe("archive tool, source profile", () => {
	it("lists agents and findings of the current session", async () => {
		setCurrentSession("sess-main");
		const text = await profile({});
		expect(text).toContain("Session sess-main: 2 agents, $0.750");
		expect(text).toMatch(/steady-main\s+main\s+claude-sonnet-4-5\s+2\s+2%\s+90k\s+\$0\.500/);
		expect(text).toMatch(/cache-rewrite\s+steady-main/);
		expect(text).toContain("agentId");
		setCurrentSession(undefined);
	});

	it("falls back to the latest session of the folder and honours sessionId and limit", async () => {
		setCurrentSession("not-stored");
		expect(await profile({})).toContain("Session sess-main:");
		const text = await profile({ sessionId: "sess-ki", limit: 1 });
		expect(text).toContain("Session sess-kid: 1 agent");
		setCurrentSession(undefined);
	});

	it("lists one agent's requests and one request's layers", async () => {
		setCurrentSession("sess-main");
		const list = await profile({ agentId: "steady-main" });
		expect(list).toMatch(/^steady-main: 2 requests/);
		const one = await profile({ agentId: "steady-main", line: 1 });
		expect(one).toMatch(/^#1 /);
		expect(one).toMatch(/STATE\s+KIND\s+LAYER\s+TOKENS/);
		const paged = await profile({ agentId: "steady-main", limit: 1 });
		expect(paged).toContain("Page 1 of 2; continue with page.");
		setCurrentSession(undefined);
	});

	it("names an unknown session, agent or request", async () => {
		await expect(profile({ sessionId: "nope" })).rejects.toThrow("No session nope.");
		await expect(profile({ sessionId: "sess-main", agentId: "ghost" })).rejects.toThrow("No agent ghost");
		await expect(profile({ sessionId: "sess-main", agentId: "steady-main", line: 9 })).rejects.toThrow(
			"has no request 9",
		);
	});
});
