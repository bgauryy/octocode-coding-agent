import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import type * as NativeConfig from "../../src/config.ts";
import { openBacklog } from "../../src/octocode/backlog/context.ts";
import { MAX_SUBAGENTS_ENV } from "../../src/octocode/subagents/claim.ts";
import type { AgentProfile } from "../../src/octocode/subagents/profiles.ts";
import { registerAgentTool } from "../../src/octocode/subagents/tool.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { fakeCachePolicy, fakeCtx, fakeHost, fakePermission, meteredBilling } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/**
 * One batch of `agent` calls on one item: the calls check and claim in the order the model made them, so the first one
 * starts and the rest are refused, whether or not a call is isolated (an isolated one first lists the saved refs).
 */

const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), "subagent-fake-host.cjs");
const savedArgv = process.argv[1];
const savedEnv = { ...process.env };
const READY = { goal: "Expected result", why: "Required work" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

beforeAll(() => {
	const root = tmp("octocode-batch-claim-");
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
		"OCTOCODE_PARENT_SESSION",
		"OCTOCODE_BACKLOG_ITEM",
		"OCTOCODE_SUBAGENT_LINGER_SECONDS",
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

afterEach(() => closeSharedAgentDb());

vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof NativeConfig>()),
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]] }),
}));

function repo(): string {
	const dir = fs.realpathSync(tmp("octocode-batch-claim-repo-"));
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.name", "Test");
	git(dir, "config", "user.email", "test@example.com");
	fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "init");
	return dir;
}

/** The `agent` tool of a main session in a fresh repository holding one todo item, B1. */
function agentTool() {
	const f = fakeHost();
	const team = new Team(f.api);
	const control = registerAgentTool(f.api, {
		profiles: () => new Map<string, AgentProfile>(),
		team,
		permission: fakePermission(),
		refused: () => new Map(),
	});
	const ctx = fakeCtx({ cwd: repo(), hasUI: true });
	Object.assign(ctx.ui, { confirm: async () => true });
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
	openBacklog(ctx, { isSubagent: false }).store.add({ ...READY, title: "part", state: "todo", createdBy: "user" });
	const agent = f.tools.get("agent");
	const run = (call: string, params: Record<string, unknown>) =>
		agent.execute(call, { goal: "batch part", item: "B1", background: true, ...params }, undefined, undefined, ctx);
	const shutdown = async () => {
		await control.settle();
		await control.stopAll();
		await f.fire("session_shutdown", { type: "session_shutdown" }, ctx);
		await team.stop();
	};
	return { run, shutdown };
}

/** Which calls of the batch started, by position. */
async function started(batch: Promise<unknown>[]): Promise<{ started: number[]; refusals: string[] }> {
	const results = await Promise.allSettled(batch);
	return {
		started: results.flatMap((result, index) => (result.status === "fulfilled" ? [index] : [])),
		refusals: results.flatMap((result) => (result.status === "rejected" ? [String(result.reason)] : [])),
	};
}

describe("one batch of calls on one item", () => {
	it("starts only the first of two isolated calls", async () => {
		const s = agentTool();
		try {
			const outcome = await started([
				s.run("call-1", { task: "edit a file", isolate: true }),
				s.run("call-2", { task: "edit a file", isolate: true }),
			]);
			expect(outcome.started).toEqual([0]);
			expect(outcome.refusals).toEqual([expect.stringMatching(/B1 is being worked on by/)]);
		} finally {
			await s.shutdown();
		}
	}, 60_000);

	it("starts an isolated first call, not the plain call after it", async () => {
		const s = agentTool();
		try {
			const outcome = await started([
				s.run("call-1", { task: "edit a file", isolate: true }),
				s.run("call-2", { task: "edit a file" }),
			]);
			expect(outcome.started).toEqual([0]);
			expect(outcome.refusals).toEqual([expect.stringMatching(/B1 is being worked on by/)]);
		} finally {
			await s.shutdown();
		}
	}, 60_000);
});
