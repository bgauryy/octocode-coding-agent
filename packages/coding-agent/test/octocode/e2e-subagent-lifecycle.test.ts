import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prompt, requestsOf as requestsOfScript, session } from "./e2e-a2a-helpers.ts";
import {
	alive,
	type Endpoint,
	killEverything,
	outputOfRuns,
	pidFrom,
	sandbox,
	script,
	type Step,
	startEndpoint,
	until,
} from "./e2e-real-process-harness.ts";

/**
 * The subagent lifecycle through real processes on the scripted model: a child that answers while its own background job
 * runs (B82), and the outcome words of its report. Resume, stop, the request budget and an isolated child's merge have
 * their own real-process suites (e2e-features, e2e-budget-conversation, e2e-all-tools); the subagent hooks run against a
 * real child in subagent-hooks-session.test.ts.
 */
let endpoint: Endpoint;

vi.setConfig({ testTimeout: 180_000 });

beforeAll(async () => {
	endpoint = await startEndpoint();
});
afterAll(async () => {
	await endpoint.close();
});
afterEach((context) => {
	if (context.task.result?.state === "fail") console.error(outputOfRuns());
	killEverything();
	endpoint.requests.length = 0;
});

const requestsOf = (steps: readonly Step[]) => {
	const source = script(steps).slice("B64SCRIPT:".length);
	return endpoint.requests.filter((request) => request.script === source);
};
const allText = (request: { messages: Array<{ text: string }> }) =>
	request.messages.map((message) => message.text).join("\n");

/** A parent that hands `child` to a foreground subagent, then reads its report. */
const parentOf = (child: readonly Step[]): Step[] => [
	{ tool: "agent", args: { type: "task", background: false, goal: "do the work", task: script(child) } },
	{ text: "read its report" },
];

describe("a subagent's run and report", () => {
	it("holds a child that answers while its own background job runs, and gives it the job's completion before it reports", async () => {
		const box = sandbox(endpoint);
		const child: Step[] = [
			{ tool: "bash", args: { command: "sleep 1; echo e2e-job-marker", background: true, reason: "the suite" } },
			{ text: "I'll wait for the completion message." },
			{ text: "done: the job printed its marker" },
		];
		const parent = parentOf(child);
		const { code } = await box.start(["-p", script(parent)]).exited;
		expect(code).toBe(0);

		const childRequests = requestsOf(child);
		expect(childRequests).toHaveLength(3);
		const afterHold = allText(childRequests[2] ?? { messages: [] });
		expect(afterHold).toContain("e2e-job-marker");
		expect(afterHold).not.toMatch(/stopped[^\n]*run end/i);
		const report = requestsOf(parent).at(-1)!.toolResults.join("\n");
		expect(report).toMatch(/reported done/);
		// The answer to the job's completion follows the earlier answer as its own section, not glued to it.
		expect(report).not.toContain("message.done:");
		expect(report).toMatch(/Follow-up to the report above[^\n]*\n[\s\S]*done: the job printed its marker/);
	});

	for (const outcome of ["partial", "blocked", "failed"] as const)
		it(`hands a ${outcome} report to the parent with its outcome word`, async () => {
			const box = sandbox(endpoint);
			const child: Step[] = [{ text: `${outcome}: stopped at step two; the build needs a decision` }];
			const parent = parentOf(child);
			const { code } = await box.start(["-p", script(parent)]).exited;
			expect(code).toBe(0);
			const report = requestsOf(parent).at(-1)!.toolResults.join("\n");
			expect(report).toContain(`${outcome}: stopped at step two`);
			expect(report).toMatch(new RegExp(`\\b${outcome}\\b`));
		});
});

const background = (goal: string, task: string, extra: Record<string, unknown> = {}): Step => ({
	tool: "agent",
	args: { type: "task", background: true, goal, task, ...extra },
});
const heardBy = (steps: string): string =>
	requestsOfScript(endpoint, steps)
		.flatMap((request) => request.messages.map((each) => each.text))
		.join("\n");

/**
 * Every process below `root` by parent pid. A subagent retitles itself (`octocode-<role>-<id>`), so its command line no
 * longer names the sandbox and only its ancestry finds it.
 */
function descendantsOf(root: number): number[] {
	const listing = execFileSync("ps", ["-axww", "-o", "pid=,ppid="], { encoding: "utf8" });
	const parents = new Map<number, number[]>();
	for (const line of listing.trim().split("\n")) {
		const [pid, ppid] = line.trim().split(/\s+/).map(Number);
		parents.set(ppid, [...(parents.get(ppid) ?? []), pid]);
	}
	const found: number[] = [];
	for (const queue = [root]; queue.length > 0;) {
		const next = parents.get(queue.shift()!) ?? [];
		found.push(...next);
		queue.push(...next);
	}
	return found;
}

describe("a coordinator that exits with a running background child", () => {
	/** A coordinator whose background child runs a command that records its pid and never ends. */
	async function coordinatorWithRunningChild() {
		const box = sandbox(endpoint);
		const marker = path.join(box.root, "held.pid");
		const child = script([
			{ tool: "bash", args: { command: box.holdCommand(marker), reason: "hold" } },
			{ text: "done: unreachable" },
		]);
		const parent = await session(box);
		prompt(parent.run, "go", script([background("hold a process", child), { text: "started" }]));
		await until(() => fs.existsSync(marker) && Number.isInteger(pidFrom(marker)), "the child's command to run");
		const coordinator = parent.instance.pid;
		const childPids = descendantsOf(coordinator);
		// The child process itself, not only the command it started.
		expect(childPids.length).toBeGreaterThan(1);
		return { box, parent, coordinator, childPids, held: pidFrom(marker) };
	}

	it("stops the child on SIGTERM and leaves no process of the sandbox behind", async () => {
		const { box, parent, childPids, held } = await coordinatorWithRunningChild();
		parent.run.process.kill("SIGTERM");
		await parent.run.exited;
		// The graceful stop and the exit hook have a bounded time: the RPC shutdown deadline is 10 s.
		await until(() => childPids.every((pid) => !alive(pid)), "every child process to end", 60_000);
		expect(box.survivors()).toEqual([]);
		expect(alive(held)).toBe(false);
	});

	it("lets the child exit within about 15 s of a SIGKILLed coordinator", async () => {
		const { box, parent, childPids, held } = await coordinatorWithRunningChild();
		const killedAt = Date.now();
		parent.run.process.kill("SIGKILL");
		await parent.run.exited;
		await until(() => childPids.every((pid) => !alive(pid)) && !alive(held), "the parentless child to exit", 60_000);
		// A loaded machine adds to the 10 s deadline; the child still must not live on.
		expect(Date.now() - killedAt).toBeLessThan(25_000);
		expect(box.survivors()).toEqual([]);
	});
});

describe("starts that name the same paths", () => {
	it("queues the second until the first reports, then both report", async () => {
		const box = sandbox(endpoint);
		const gate = path.join(box.root, "first-may-finish");
		const first = script([
			{
				tool: "bash",
				args: { command: `for i in $(seq 1 1200); do [ -f ${JSON.stringify(gate)} ] && break; sleep 0.1; done` },
			},
			{ text: "done: first report marker" },
		]);
		const second = script([{ text: "done: second report marker" }]);
		const parent = await session(box);
		const steps = script([
			background("edit shared", first, { paths: ["shared.txt"] }),
			background("edit shared too", second, { paths: ["shared.txt"] }),
			{ text: "both started" },
		]);
		prompt(parent.run, "go", steps);
		await until(() => requestsOfScript(endpoint, steps).some((request) => request.step >= 2), "both starts to answer");
		const results = requestsOfScript(endpoint, steps).at(-1)!.toolResults.join("\n");
		expect(results).toMatch(/Reserved until it reports: shared\.txt/);
		expect(results).toMatch(/Queued \S+ [^\n]*it holds no paths yet: it waits for the children holding them/);
		// Held back: the second child has not asked the model anything while the first holds the paths.
		await until(() => requestsOfScript(endpoint, first).length > 0, "the first child to run");
		await new Promise((resolve) => setTimeout(resolve, 1500));
		expect(requestsOfScript(endpoint, second)).toHaveLength(0);

		fs.writeFileSync(gate, "");
		await until(() => heardBy(steps).includes("first report marker"), "the first report", 120_000);
		await until(() => heardBy(steps).includes("second report marker"), "the second report", 120_000);
		const firstEnd = requestsOfScript(endpoint, first).at(-1)!.at;
		expect(requestsOfScript(endpoint, second)[0].at).toBeGreaterThanOrEqual(firstEnd);
		parent.run.process.stdin?.end();
		await parent.run.exited;
	});
});

describe("a resumed child", () => {
	it("sends its earlier transcript with its first request", async () => {
		const box = sandbox(endpoint);
		const first: Step[] = [{ text: "done: earlier answer marker" }];
		const second: Step[] = [{ text: "done: continued" }];
		const parent: Step[] = [
			{ tool: "agent", args: { type: "task", goal: "earlier goal marker", task: script(first) } },
			{ tool: "agent", args: { type: "task", goal: "the rest", resume: "{{CHILD}}", task: script(second) } },
			{ text: "read its report" },
		];
		const { code } = await box.start(["-p", script(parent)]).exited;
		expect(code).toBe(0);
		const resumed = requestsOf(second)[0];
		const roles = resumed.messages.map((each) => each.role);
		expect(roles).toContain("assistant");
		const text = allText(resumed);
		expect(text).toContain("done: earlier answer marker");
		expect(text).toContain(script(first));
		expect(resumed.lastUserText).toContain(script(second));
	});
});

describe("an isolated start", () => {
	it("names the child's worktree and the ref its result lands on", async () => {
		const box = sandbox(endpoint);
		const child: Step[] = [{ text: "done: nothing to change" }];
		const parent: Step[] = [
			{
				tool: "agent",
				args: { type: "task", background: true, isolate: true, goal: "work apart", task: script(child) },
			},
			{ text: "started" },
		];
		const { code } = await box.start(["-p", script(parent)]).exited;
		expect(code).toBe(0);
		const started = requestsOf(parent).at(-1)!.toolResults.join("\n");
		const id = /Started (\S+) \(/.exec(started)?.[1];
		expect(id, started).toBeDefined();
		expect(started).toContain(`Works in its own worktree ${id}`);
		expect(started).toContain(`refs/octocode/${id}`);
	});
});
