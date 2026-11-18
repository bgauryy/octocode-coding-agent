import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prompt, session } from "./e2e-a2a-helpers.ts";
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
 * The subagent lifecycle through real processes on the scripted model: the outcome word reaching a `-p` parent, a
 * coordinator that exits (SIGTERM, SIGKILL) with a running child, and a resumed child that sends its earlier transcript.
 * Held jobs, report outcomes, path queues and the isolated start text are asserted in-process (subagent-job-hold,
 * subagent-report, subagent-reservation-queue, subagent-isolated-start); the request budget has e2e-budget-conversation.
 */
let endpoint: Endpoint;

vi.setConfig({ testTimeout: 180_000 });

beforeAll(async () => {
	endpoint = await startEndpoint();
});
afterAll(async () => {
	await endpoint?.close();
});
afterEach(async (context) => {
	if (context.task.result?.state === "fail") console.error(outputOfRuns());
	await killEverything();
	endpoint.requests.length = 0;
});

const requestsOf = (steps: readonly Step[]) => {
	const source = script(steps).slice("B64SCRIPT:".length);
	return endpoint.requests.filter((request) => request.script === source);
};
const allText = (request: { messages: Array<{ text: string }> }) =>
	request.messages.map((message) => message.text).join("\n");

const background = (goal: string, task: string, extra: Record<string, unknown> = {}): Step => ({
	tool: "agent",
	args: { type: "task", background: true, goal, task, ...extra },
});
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

	/** The two exits wait out the same bounded shutdown, so they run side by side in separate sandboxes. */
	it("stops the child on SIGTERM and leaves no process of the sandbox behind; lets it exit within about 15 s of a SIGKILLed coordinator", async () => {
		const [termed, killed] = await Promise.all([coordinatorWithRunningChild(), coordinatorWithRunningChild()]);
		termed.parent.run.process.kill("SIGTERM");
		const killedAt = Date.now();
		killed.parent.run.process.kill("SIGKILL");
		await Promise.all([termed.parent.run.exited, killed.parent.run.exited]);
		// The graceful stop and the exit hook have a bounded time: the RPC shutdown deadline is 10 s.
		await until(() => termed.childPids.every((pid) => !alive(pid)), "every child process to end", 60_000);
		expect(termed.box.survivors()).toEqual([]);
		expect(alive(termed.held)).toBe(false);
		await until(
			() => killed.childPids.every((pid) => !alive(pid)) && !alive(killed.held),
			"the parentless child to exit",
			60_000,
		);
		// A loaded machine adds to the 10 s deadline; the child still must not live on.
		expect(Date.now() - killedAt).toBeLessThan(25_000);
		expect(killed.box.survivors()).toEqual([]);
	});
});

describe("a subagent's run and report", () => {
	it("hands a blocked report to the parent with its outcome word, and a resumed child sends its earlier transcript with its first request", async () => {
		const box = sandbox(endpoint);
		const blocked: Step[] = [{ text: "blocked: stopped at step two; the build needs a decision" }];
		const first: Step[] = [{ text: "done: earlier answer marker" }];
		const second: Step[] = [{ text: "done: continued" }];
		const parent: Step[] = [
			{ tool: "agent", args: { type: "task", goal: "earlier goal marker", task: script(first) } },
			{ tool: "agent", args: { type: "task", goal: "the rest", resume: "{{CHILD}}", task: script(second) } },
			{ tool: "agent", args: { type: "task", background: false, goal: "do the work", task: script(blocked) } },
			{ text: "read its report" },
		];
		const { code } = await box.start(["-p", script(parent)]).exited;
		expect(code).toBe(0);
		const report = requestsOf(parent).at(-1)!.toolResults.join("\n");
		expect(report).toContain("blocked: stopped at step two");
		expect(report).toMatch(/\bblocked\b/);

		const resumed = requestsOf(second)[0];
		const roles = resumed.messages.map((each) => each.role);
		expect(roles).toContain("assistant");
		const text = allText(resumed);
		expect(text).toContain("done: earlier answer marker");
		expect(text).toContain(script(first));
		expect(resumed.lastUserText).toContain(script(second));
	});
});
