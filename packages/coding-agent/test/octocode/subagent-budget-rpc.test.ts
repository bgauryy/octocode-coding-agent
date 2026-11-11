import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type * as NativeConfig from "../../src/config.ts";
import { finalMessage, MAX_REQUESTS_ENV } from "../../src/octocode/subagents/budget.ts";
import { runSubagent } from "../../src/octocode/subagents/process.ts";
import { buildAgentArgs, childSessionFile } from "../../src/octocode/subagents/process/session.ts";
import { tmp } from "./helpers.ts";

// The child is the scripted stand-in: run the current script (`process.argv[1]`, set below) with node.
vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof NativeConfig>()),
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]] }),
}));

const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), "subagent-fake-host.cjs");
const savedArgv = process.argv[1];
const savedEnv = { ...process.env };

beforeAll(() => {
	const root = tmp("octocode-agent-budget-");
	for (const key of Object.keys(process.env)) if (key.startsWith("OCTOCODE_")) delete process.env[key];
	Object.assign(process.env, {
		OCTOCODE_HOME: path.join(root, "home"),
		OCTOCODE_AGENT_DB: path.join(root, "team.sqlite"),
	});
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	fs.copyFileSync(FIXTURE, path.join(bin, "octocode"));
	process.argv[1] = path.join(bin, "octocode");
});

afterAll(() => {
	process.argv[1] = savedArgv!;
	process.env = savedEnv;
});

afterEach(() => {
	delete process.env.OCTOCODE_FAKE_LOG;
	delete process.env[MAX_REQUESTS_ENV];
});

function childLog(): () => string[] {
	const file = path.join(tmp(), "child.log");
	process.env.OCTOCODE_FAKE_LOG = file;
	return () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n") : []);
}

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

describe("a subagent child over its request budget", () => {
	it("does no model work for cancelled launches or unreadable accounting history", async () => {
		process.env[MAX_REQUESTS_ENV] = "3";
		const workspace = tmp();
		const session = { dir: path.join(workspace, "session"), id: "a-invalid-budget" };
		const args = buildAgentArgs(undefined, undefined, session);
		const spawned = vi.fn();
		const launch = (signal?: AbortSignal) =>
			runSubagent({
				task: "budget loop 40",
				args,
				cwd: workspace,
				identity: { id: session.id },
				signal,
				onProgress: () => undefined,
				onSpawn: spawned,
			});
		await expect(launch(AbortSignal.abort())).rejects.toThrow("Subagent cancelled");
		expect(fs.existsSync(session.dir)).toBe(false);
		fs.writeFileSync(session.dir, "not a directory");
		await expect(launch()).rejects.toThrow(/ENOTDIR/);
		fs.rmSync(session.dir);
		fs.mkdirSync(session.dir);
		const transcript = path.join(session.dir, `history_${session.id}.jsonl`);
		const broken = `${JSON.stringify({ type: "session", id: session.id })}\n{"type":"message"`;
		fs.writeFileSync(transcript, broken);
		await expect(launch()).rejects.toThrow(/repair the invalid transcript record/);
		expect(fs.readFileSync(transcript, "utf8")).toBe(broken);
		expect(spawned).not.toHaveBeenCalled();
	});

	it("counts across resumed processes, including an inherited transcript, and a resume past the limit gets a new allowance", async () => {
		process.env[MAX_REQUESTS_ENV] = "3";
		const lines = childLog();
		const workspace = tmp();
		const session = { dir: path.join(workspace, "session"), id: "a-resumed-budget" };
		const args = buildAgentArgs(undefined, undefined, session);
		const first = await runSubagent({
			task: "budget loop 0",
			args,
			cwd: workspace,
			identity: { id: session.id },
			onProgress: () => undefined,
		});
		expect(first.outcome).toBe("done");
		const progress: number[] = [];
		const resumed = await runSubagent({
			task: "budget loop 40",
			args,
			cwd: workspace,
			identity: { id: session.id, parentSession: "forked-parent", scratch: path.join(workspace, "new-parent") },
			onProgress: (update) => {
				if (update.requests !== undefined) progress.push(update.requests);
			},
		});
		// One saved reply, under the soft limit: this run shares the first run's budget and stops at its hard limit. The fifth
		// reply is the last request, which still asked for tools (this child ignores the tool choice) and so ended the run.
		expect(resumed.budget).toEqual({ requests: 5, limit: 3 });
		expect(progress).toEqual([1, 2, 3, 4, 5]);
		expect(resumed.usage.totalTokens).toBe(600);
		expect(
			lines()
				.filter((line) => line.startsWith("prompt "))
				.at(-1),
		).not.toContain("Your coordinator continued you");
		// Past the hard limit (six saved replies): a whole allowance from there, where it used to return without running.
		const spawned = vi.fn();
		const continued: number[] = [];
		const again = await runSubagent({
			task: "budget loop 40",
			args,
			cwd: workspace,
			identity: { id: session.id },
			onProgress: (update) => {
				if (update.requests !== undefined) continued.push(update.requests);
			},
			onSpawn: spawned,
		});
		expect(again.budget).toEqual({ requests: 11, limit: 9 });
		expect(continued).toEqual([1, 2, 3, 4, 5, 6]);
		expect(spawned).toHaveBeenCalledTimes(1);
		expect(
			lines()
				.filter((line) => line.startsWith("prompt "))
				.at(-1),
		).toContain(
			"Your coordinator continued you after 6 model requests; the run is stopped at 11. Do this task and report before that:",
		);
		// A peer's relayed message is no grant: past the hard limit it runs nothing, and the report says how to continue.
		const transcript = fs.readFileSync(childSessionFile(session)!, "utf8");
		const notSpawned = vi.fn();
		const exhausted = await runSubagent({
			task: "budget loop 40",
			args,
			cwd: workspace,
			identity: { id: session.id, peerResumed: true },
			onProgress: () => undefined,
			onSpawn: notSpawned,
		});
		expect(exhausted.budget).toEqual({ requests: 12, limit: 3 });
		expect(exhausted.usage.totalTokens).toBe(0);
		expect(exhausted.text).toContain(`\`resume: ${session.id}\``);
		expect(notSpawned).not.toHaveBeenCalled();
		expect(fs.readFileSync(childSessionFile(session)!, "utf8")).toBe(transcript);
		const fresh = { dir: session.dir, id: "a-new-budget" };
		expect(
			(
				await runSubagent({
					task: "budget loop 2",
					args: buildAgentArgs(undefined, undefined, fresh),
					cwd: workspace,
					identity: { id: fresh.id },
					onProgress: () => undefined,
				})
			).outcome,
		).toBe("done");
	});

	it("counts prior failed replies and all branches, excludes compactions, and preserves a final answer at the hard limit", async () => {
		process.env[MAX_REQUESTS_ENV] = "3";
		const workspace = tmp();
		const session = { dir: path.join(workspace, "session"), id: "a-history-budget" };
		fs.mkdirSync(session.dir);
		fs.writeFileSync(
			path.join(session.dir, `2026-01-01T00-00-00-000Z_${session.id}.jsonl`),
			[
				{ type: "session", id: session.id },
				{ type: "message", id: "old-branch", message: { role: "assistant", stopReason: "toolUse" } },
				{ type: "message", id: "failed", message: { role: "assistant", stopReason: "error" } },
				{
					type: "message",
					id: "current-branch",
					parentId: "old-branch",
					message: { role: "assistant", stopReason: "stop" },
				},
				{ type: "compaction", summary: "summary", usage: { totalTokens: 9000 } },
				{ type: "message", message: { role: "toolResult" } },
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n") + "\n",
		);
		const args = buildAgentArgs(undefined, undefined, session);
		const outcome = await runSubagent({
			task: "budget loop 1",
			args,
			cwd: workspace,
			identity: { id: session.id },
			onProgress: () => undefined,
		});
		expect(outcome.outcome).toBe("done");
		expect(outcome.budget).toBeUndefined();
		expect(outcome.usage.totalTokens).toBe(240);
		// The three saved replies, then two: a resume at the soft limit counts all of them and starts its allowance there.
		const stopped = await runSubagent({
			task: "budget loop 40",
			args,
			cwd: workspace,
			identity: { id: session.id },
			onProgress: () => undefined,
		});
		expect(stopped.budget).toEqual({ requests: 10, limit: 8 });
		process.env[MAX_REQUESTS_ENV] = "0";
		expect(
			(
				await runSubagent({
					task: "budget loop 6",
					args,
					cwd: workspace,
					identity: { id: session.id },
					onProgress: () => undefined,
				})
			).outcome,
		).toBe("done");
	});

	it("is steered once at the soft limit, stopped at the hard limit and reports partial; its process is gone", async () => {
		process.env[MAX_REQUESTS_ENV] = "3";
		const lines = childLog();
		let pid = 0;
		const progress: Array<number | undefined> = [];
		const outcome = await runSubagent({
			task: "budget loop 40",
			args: [],
			cwd: tmp(),
			identity: { id: "a-budget" },
			onProgress: (update) => progress.push(update.requests),
			onSpawn: (spawned) => {
				pid = spawned;
			},
		});
		const log = lines();
		const steers = log.filter((line) => line.startsWith("steer "));
		// The soft limit's steer, then the hard limit's last request without tools.
		expect(steers).toHaveLength(2);
		expect(steers[1]).toBe(`steer ${finalMessage(5)}`);
		// No parent in this identity: the child cannot be answered, so it is told to say so in its report.
		expect(steers[0]).toBe(
			"steer You have used 3 of 3 model requests; the run stops at 5. Finish the check in progress.",
		);
		expect(log).toContain(
			"Your coordinator waits for your report and reads messages only with it, so it cannot answer during this run; if you need its decision or it should know now, finish with a `blocked` report that says so. Say in your report what is left and how many more requests that needs.",
		);
		expect(log).toContain("abort");
		expect(log.indexOf(steers[0])).toBeLessThan(log.indexOf("abort"));
		expect(outcome.outcome).toBe("partial");
		expect(outcome.outcomeSource).toBe("first");
		expect(outcome.error).toBeUndefined();
		expect(outcome.budget).toEqual({ requests: 5, limit: 3 });
		expect(outcome.text.split("\n")[0]).toMatch(/^partial: stopped at the model request budget \(5 requests; limit 3/);
		expect(outcome.text).toContain("step ");
		expect(progress.filter((requests) => requests !== undefined).slice(0, 5)).toEqual([1, 2, 3, 4, 5]);
		expect(pid).toBeGreaterThan(0);
		expect(alive(pid)).toBe(false);
		expect(log.filter((line) => line.startsWith("pid ")).length).toBe(1);
	});

	it("takes the soft limit from the profile before the environment", async () => {
		process.env[MAX_REQUESTS_ENV] = "100";
		const lines = childLog();
		const outcome = await runSubagent({
			task: "budget loop 40",
			args: [],
			cwd: tmp(),
			profile: { name: "limited", description: "", prompt: "", maxRequests: 2 },
			identity: { id: "a-profile" },
			onProgress: () => undefined,
		});
		expect(outcome.budget).toEqual({ requests: 3, limit: 2 });
		expect(lines().filter((line) => line.startsWith("steer "))).toEqual([
			expect.stringContaining("steer You have used 2 of 2 model requests"),
			`steer ${finalMessage(3)}`,
		]);
	});

	it("leaves a child alone when the budget is off, however many requests it makes", async () => {
		process.env[MAX_REQUESTS_ENV] = "0";
		const lines = childLog();
		const outcome = await runSubagent({
			task: "budget loop 12",
			args: [],
			cwd: tmp(),
			identity: { id: "a-off" },
			onProgress: () => undefined,
		});
		expect(lines().some((line) => line.startsWith("steer ") || line === "abort")).toBe(false);
		expect(outcome.budget).toBeUndefined();
		expect(outcome.outcome).toBe("done");
		expect(outcome.text).toBe("done: finished the loop");
	});

	it("does not stop a child that finishes within the hard limit", async () => {
		process.env[MAX_REQUESTS_ENV] = "5";
		const lines = childLog();
		const outcome = await runSubagent({
			task: "budget loop 6",
			args: [],
			cwd: tmp(),
			identity: { id: "a-fits" },
			onProgress: () => undefined,
		});
		expect(lines().filter((line) => line.startsWith("steer "))).toHaveLength(1);
		expect(lines()).not.toContain("abort");
		expect(outcome.outcome).toBe("done");
	});
});
