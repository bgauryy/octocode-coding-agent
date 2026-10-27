import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type * as NativeConfig from "../../src/config.ts";
import { MAX_REQUESTS_ENV } from "../../src/octocode/subagents/budget.ts";
import { runSubagent } from "../../src/octocode/subagents/process.ts";
import { tmp } from "./helpers.ts";

// The child is the scripted stand-in: run the current script (`process.argv[1]`, set below) with node.
vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof NativeConfig>()),
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]] }),
}));

const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), "subagent-fake-pi.cjs");
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
	fs.copyFileSync(FIXTURE, path.join(bin, "pi"));
	process.argv[1] = path.join(bin, "pi");
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
	it("is steered once at the soft limit, stopped at the hard limit and reports partial; its process is gone", async () => {
		process.env[MAX_REQUESTS_ENV] = "3";
		const lines = childLog();
		let pid = 0;
		const progress: Array<number | undefined> = [];
		const outcome = await runSubagent(
			"budget loop 40",
			[],
			tmp(),
			undefined,
			{ id: "a-budget" },
			undefined,
			(update) => progress.push(update.requests),
			(spawned) => {
				pid = spawned;
			},
		);
		const log = lines();
		const steers = log.filter((line) => line.startsWith("steer "));
		expect(steers).toEqual([
			"steer You have used 3 of 3 model requests. Finish now: report what is done, what is partial, and the next step.",
		]);
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
		const outcome = await runSubagent(
			"budget loop 40",
			[],
			tmp(),
			{ name: "limited", description: "", prompt: "", maxRequests: 2 },
			{ id: "a-profile" },
			undefined,
			() => undefined,
		);
		expect(outcome.budget).toEqual({ requests: 3, limit: 2 });
		expect(lines().filter((line) => line.startsWith("steer "))).toHaveLength(1);
	});

	it("leaves a child alone when the budget is off, however many requests it makes", async () => {
		process.env[MAX_REQUESTS_ENV] = "0";
		const lines = childLog();
		const outcome = await runSubagent(
			"budget loop 12",
			[],
			tmp(),
			undefined,
			{ id: "a-off" },
			undefined,
			() => undefined,
		);
		expect(lines().some((line) => line.startsWith("steer ") || line === "abort")).toBe(false);
		expect(outcome.budget).toBeUndefined();
		expect(outcome.outcome).toBe("done");
		expect(outcome.text).toBe("done: finished the loop");
	});

	it("does not stop a child that finishes within the hard limit", async () => {
		process.env[MAX_REQUESTS_ENV] = "5";
		const lines = childLog();
		const outcome = await runSubagent(
			"budget loop 6",
			[],
			tmp(),
			undefined,
			{ id: "a-fits" },
			undefined,
			() => undefined,
		);
		expect(lines().filter((line) => line.startsWith("steer "))).toHaveLength(1);
		expect(lines()).not.toContain("abort");
		expect(outcome.outcome).toBe("done");
	});
});
