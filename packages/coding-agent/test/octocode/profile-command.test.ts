import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	ProfileAgents,
	ProfileInsights,
	ProfileRequests,
	ProfileTimeline,
} from "@octocodeai/octocode-contracts/profiler";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentDb, closeSharedAgentDb, sessions } from "../../../db/src/api.ts";
import { runProfileCommand } from "../../src/cli/profile-command.ts";
import { openAgentDb } from "../../src/storage/database.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";

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

async function run(...args: string[]): Promise<{ code: number; out: string; err: string }> {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runProfileCommand(args, {
		cwd: root,
		env,
		out: (text) => out.push(text),
		err: (text) => err.push(text),
	});
	return { code, out: out.join("\n"), err: err.join("\n") };
}

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

describe("octocode profile", () => {
	it("prints the latest session of the folder as a table of agents", async () => {
		const { code, out } = await run();
		expect(code).toBe(0);
		expect(out).toContain("Session sess-main: 2 agents, $0.750");
		const lines = out.split("\n");
		expect(lines[1]).toMatch(/^AGENT\s+ROLE\s+MODEL\s+REQ\s+HIT\s+WRITTEN\s+COST$/);
		expect(lines[2]).toMatch(/^steady-main\s+main\s+claude-sonnet-4-5\s+2\s+2%\s+90k\s+\$0\.500$/);
		expect(lines[3]).toMatch(/^ {2}quick-finch\s+researcher\s+claude-sonnet-4-5\s+1\s+0%\s+12k\s+\$0\.250$/);
	});

	it("prints the contract objects with --json, for a session named by a prefix", async () => {
		const { code, out } = await run("--json", "--session", "sess-ma");
		expect(code).toBe(0);
		const agents = JSON.parse(out) as ProfileAgents;
		expect(agents.sessionId).toBe("sess-main");
		expect(agents.agents.map((agent) => [agent.id, agent.parentId, agent.requests])).toEqual([
			["steady-main", undefined, 2],
			["quick-finch", "steady-main", 1],
		]);
	});

	it("lists findings with --insights, as a table and as JSON", async () => {
		const table = await run("--insights");
		expect(table.out).toMatch(/SEV\s+KIND\s+AGENT\s+COST\s+FINDING/);
		expect(table.out).toMatch(/cache-rewrite\s+steady-main/);
		expect(table.out).toMatch(/cache-cold-start\s+quick-finch/);
		const json = JSON.parse((await run("--insights", "--json")).out) as ProfileInsights;
		expect(json.findings.map((finding) => finding.kind)).toEqual(
			expect.arrayContaining(["cache-rewrite", "cache-cold-start"]),
		);
	});

	it("shows an agent's requests, and one request's layers with --request", async () => {
		const list = await run("--agent", "steady-main");
		expect(list.out).toMatch(/^steady-main: 2 requests/);
		expect(list.out).toMatch(/#\s+AT\s+PROMPT\s+HIT\s+WRITTEN\s+COST\s+MISS/);
		const one = await run("--agent", "steady-main", "--request", "1");
		expect(one.code).toBe(0);
		expect(one.out).toMatch(/^#1 {2}10:00:06 {2}claude-sonnet-4-5/);
		expect(one.out).toMatch(/STATE\s+KIND\s+LAYER\s+TOKENS/);
		expect(one.out).toMatch(/changed/);
		const json = JSON.parse((await run("--agent", "steady-main", "--request", "1", "--json")).out) as ProfileRequests;
		expect(json.requests).toHaveLength(1);
		expect(json.requests[0].layers.length).toBeGreaterThan(0);
	});

	it("lists the timeline, with the message between the agents", async () => {
		const table = await run("--timeline");
		expect(table.out).toMatch(/AT\s+AGENT\s+KIND\s+TOOK\s+WHAT/);
		expect(table.out).toMatch(/steady-main\s+message/);
		const json = JSON.parse((await run("--timeline", "--json")).out) as ProfileTimeline;
		expect(json.messages.map((message) => message.preview)).toEqual(["start with the db layer"]);
	});

	it("writes Chrome Trace JSON with --trace", async () => {
		const file = path.join(root, "out", "session.trace.json");
		const { code, out } = await run("--trace", file);
		expect(code).toBe(0);
		expect(out).toContain(`Wrote Chrome Trace JSON to ${file}`);
		const trace = JSON.parse(fs.readFileSync(file, "utf8")) as { traceEvents: Array<{ ph: string }> };
		expect(trace.traceEvents.some((event) => event.ph === "X")).toBe(true);
	});

	it("changes nothing in the database or the session files", async () => {
		const files = ["main.jsonl", "kid.jsonl"].map((name) => fs.readFileSync(path.join(root, name), "utf8"));
		const before = fs.readFileSync(db.file).length;
		await run("--insights");
		await run("--agent", "quick-finch", "--detail");
		expect(["main.jsonl", "kid.jsonl"].map((name) => fs.readFileSync(path.join(root, name), "utf8"))).toEqual(files);
		expect(sessions.catalog(db.db)).toHaveLength(3);
		expect(fs.readFileSync(db.file).length).toBe(before);
	});

	it("refuses what it cannot answer with a message and exit code 1", async () => {
		expect((await run("--agent", "ghost")).err).toMatch(/No agent ghost/);
		expect((await run("--agent", "steady-main", "--request", "9")).err).toMatch(/no request 9/);
		expect((await run("--session", "nope")).err).toMatch(/No session nope/);
		expect((await run("--request", "1")).err).toMatch(/need --agent/);
		expect((await run("--insights", "--timeline")).err).toMatch(/Choose one/);
		expect((await run("--bogus")).err).toMatch(/Unknown option --bogus/);
		expect((await run("--bogus")).code).toBe(1);
	});

	it("says so when the folder has no stored session", async () => {
		const empty = await runProfileCommand([], {
			cwd: path.join(root, "empty"),
			env,
			out: () => undefined,
			err: (text) => {
				expect(text).toMatch(/No stored session in/);
			},
		});
		expect(empty).toBe(1);
	});
});
