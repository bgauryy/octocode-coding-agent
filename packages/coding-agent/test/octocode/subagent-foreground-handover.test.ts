import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type * as Config from "../../src/config.ts";
import type * as Registry from "../../src/octocode/jobs/registry.ts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MAX_SUBAGENTS_ENV, type SwarmLimits } from "../../src/octocode/subagents/claim.ts";
import { registerAgentTool } from "../../src/octocode/subagents/tool.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { fakeCachePolicy, fakeCtx, fakeHost, fakePermission, meteredBilling } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

// The foreground budget, shortened so a child that outlasts it needs no 15 s wait.
vi.mock("../../src/octocode/jobs/registry.ts", async (importOriginal) => ({
	...(await importOriginal<typeof Registry>()),
	TOOL_FOREGROUND_MS: 2500,
}));

// The child is the scripted stand-in, started the way the real one is.
vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof Config>()),
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]] }),
}));

const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), "subagent-fake-host.cjs");
const savedArgv = process.argv[1];
const savedEnv = { ...process.env };

beforeAll(() => {
	const root = tmp("octocode-agent-handover-");
	process.env.OCTOCODE_HOME = path.join(root, "home");
	process.env.OCTOCODE_AGENT_DB = path.join(root, "team", "team.sqlite");
	for (const key of [
		MAX_SUBAGENTS_ENV,
		"OCTOCODE_SUBAGENT",
		"OCTOCODE_AGENT_ID",
		"OCTOCODE_PARENT_ID",
		"OCTOCODE_AGENT_GOAL",
		"OCTOCODE_AGENT_SCRATCH",
		"OCTOCODE_TEAM_WORKSPACE",
	])
		delete process.env[key];
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	fs.copyFileSync(FIXTURE, path.join(bin, "octocode"));
	process.argv[1] = path.join(bin, "octocode");
});

afterAll(() => {
	process.argv[1] = savedArgv!;
	process.env = savedEnv;
});

function setup(limits?: SwarmLimits) {
	const f = fakeHost();
	const team = new Team(f.api);
	const control = registerAgentTool(f.api, {
		profiles: () => new Map(),
		team,
		permission: fakePermission(),
		refused: () => new Map(),
		limits,
	});
	const ctx = fakeCtx({ cwd: tmp("octocode-agent-cwd-"), hasUI: true });
	const models = [{ provider: "faux", id: "model", reasoning: true }];
	Object.assign(ctx, {
		model: models[0],
		modelRegistry: {
			...meteredBilling,
			getAvailable: () => models,
			find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
			getCachePolicy: fakeCachePolicy,
			getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
		},
	});
	team.start(ctx);
	const agent = f.tools.get("agent");
	const run = (params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: (update: unknown) => void) =>
		agent.execute("call-1", { goal: "check things", ...params }, signal, onUpdate, ctx);
	return { ...f, team, ctx, run, control };
}

let s: ReturnType<typeof setup>;
afterEach(async () => {
	delete process.env.OCTOCODE_FAKE_GATE;
	for (const id of s.control.running()) s.control.stop(id, "user");
	await s.control.settle();
});

const reports = () => s.sent.filter((entry) => entry.message.customType === "octocode-agent-result");

describe("a foreground agent task that outlasts the foreground budget", () => {
	it("returns its id while the child keeps running, then delivers the report as a background report", async () => {
		s = setup();
		const gate = path.join(tmp(), "gate");
		process.env.OCTOCODE_FAKE_GATE = gate;
		const began = Date.now();
		const reply = await s.run({ task: "gated foreground" });
		expect(Date.now() - began).toBeLessThan(10_000);
		const id = reply.details.id as string;
		expect(reply.details.status).toBe("background");
		expect(reply.isError).toBeUndefined();
		expect(reply.content[0].text).toContain(id);
		expect(reply.content[0].text).toMatch(/report arrives as a message/);
		// The child is the session's background run now: counted, stoppable by id, and no foreground entry remains.
		expect(s.control.background()).toBe(1);
		expect(s.control.running()).toEqual([id]);
		expect(reports()).toHaveLength(0);
		fs.writeFileSync(gate, "");
		await vi.waitFor(() => expect(reports()).toHaveLength(1));
		const { message } = reports()[0];
		expect(String(message.content)).toContain(`Background subagent ${id}`);
		expect(String(message.content)).toContain("finished after asking");
		expect(message.details).toMatchObject({ id, status: "done" });
		expect(s.control.background()).toBe(0);
		expect(s.control.running()).toEqual([]);
	}, 30_000);

	it("returns a quick foreground task's own result, with no background run", async () => {
		s = setup();
		const reply = await s.run({ task: "report from the foreground" });
		expect(reply.details.status).toBe("done");
		expect(reply.content[0].text).toMatch(/^Subagent \S+ (finished|reported)/);
		expect(s.control.background()).toBe(0);
		expect(reports()).toHaveLength(0);
	});

	it("lets the turn's Esc go without stopping a child that was handed over", async () => {
		s = setup();
		const gate = path.join(tmp(), "gate");
		process.env.OCTOCODE_FAKE_GATE = gate;
		const turn = new AbortController();
		const updates: unknown[] = [];
		const reply = await s.run({ task: "gated foreground" }, turn.signal, (update) => updates.push(update));
		const seen = updates.length;
		turn.abort();
		await new Promise((resolve) => setImmediate(resolve));
		expect(s.control.background()).toBe(1);
		expect(s.control.running()).toEqual([reply.details.id]);
		// The child outlives the Esc: it still answers when its gate opens, where a stopped one reports the stop.
		fs.writeFileSync(gate, "");
		await vi.waitFor(() => expect(reports()).toHaveLength(1));
		expect(reports()[0].message.details).toMatchObject({ id: reply.details.id, status: "done" });
		expect(String(reports()[0].message.content)).toContain("finished after asking");
		// Nothing is drawn on the finished call's row after the hand-over.
		expect(updates.length).toBe(seen);
	}, 30_000);

	it("stops a handed-over child by id and reports the stop once", async () => {
		s = setup();
		const reply = await s.run({ task: "slow one" });
		const id = reply.details.id as string;
		expect(s.control.stop(id, "user")).toBeUndefined();
		await s.control.settle();
		expect(reports()).toHaveLength(1);
		expect(reports()[0].message.details).toMatchObject({ id, status: "stopped" });
		expect(s.control.background()).toBe(0);
	}, 30_000);
});

describe("a foreground child handed over to the background", () => {
	const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
	const repo = (): string => {
		const dir = fs.realpathSync(tmp("octocode-handover-repo-"));
		git(dir, "init", "-q", "-b", "main");
		git(dir, "config", "user.name", "Test");
		git(dir, "config", "user.email", "test@example.com");
		fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
		git(dir, "add", "-A");
		git(dir, "commit", "-q", "-m", "init");
		return dir;
	};

	it("keeps its slot until it really ends: with a limit of one, the next start queues", async () => {
		s = setup({ maxSubagents: 1, lingerSeconds: 0 });
		try {
			const gate = path.join(tmp(), "gate");
			process.env.OCTOCODE_FAKE_GATE = gate;
			const first = await s.run({ task: "gated foreground" });
			expect(first.details.status).toBe("background");
			const second = await s.run({ task: "report from the foreground", background: true });
			expect(second.details.queued).toBe(true);
			// The handed-over child's report is its real outcome, and its end frees the slot for the queued one.
			fs.writeFileSync(gate, "");
			await vi.waitFor(() => expect(reports()).toHaveLength(2));
			const firstReport = reports().find((entry) => entry.message.details.id === first.details.id);
			expect(String(firstReport?.message.content)).toContain("finished after asking");
		} finally {
			delete process.env.OCTOCODE_FAKE_GATE;
		}
	}, 30_000);

	it("keeps an isolated child's worktree while it runs", async () => {
		s = setup();
		const dir = repo();
		Object.assign(s.ctx, { cwd: dir });
		Object.assign(s.ctx.ui, { confirm: async () => true });
		const gate = path.join(tmp(), "gate");
		process.env.OCTOCODE_FAKE_GATE = gate;
		const reply = await s.run({ task: "gated foreground", isolate: true });
		expect(reply.details.status).toBe("background");
		// The main checkout and the child's worktree.
		expect(git(dir, "worktree", "list").split("\n")).toHaveLength(2);
		fs.writeFileSync(gate, "");
		await vi.waitFor(() => expect(reports()).toHaveLength(1));
		expect(reports()[0].message.details).toMatchObject({ id: reply.details.id, status: "done" });
	}, 30_000);
});
