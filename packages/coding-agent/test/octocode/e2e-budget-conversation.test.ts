import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	type Endpoint,
	killEverything,
	outputOfRuns,
	type Sandbox,
	sandbox,
	script,
	type Step,
	startEndpoint,
	until,
} from "./e2e-real-process-harness.ts";

/**
 * The request budget as a conversation, through real processes on the scripted model: a child near its limit asks, its
 * parent grants while it runs, silence changes nothing, and a resume gives a real allowance. The limit comes from the
 * environment, as a user sets it; the parent counts the replies, so nothing here reaches into a child.
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

function limited(soft: number): Sandbox {
	const box = sandbox(endpoint);
	box.env.OCTOCODE_SUBAGENT_MAX_REQUESTS = String(soft);
	return box;
}

/** A tool call that differs each time, so the repeated-call guard stays out of it. */
const tick = (n: number): Step => ({ tool: "bash", args: { command: `echo tick ${n}` } });
const ticks = (from: number, to: number): Step[] =>
	Array.from({ length: to - from + 1 }, (_unused, index) => tick(from + index));
/** A child's turn that holds until its parent has acted, so the order does not depend on a loaded machine. */
const waitFor = (marker: string): Step => ({
	tool: "bash",
	args: { command: `for i in $(seq 1 1200); do [ -f ${JSON.stringify(marker)} ] && break; sleep 0.1; done` },
});
const ask = (message: string): Step => ({
	tool: "agent",
	args: { type: "message", to: "parent", wake: true, message },
});
const grant = (requests: unknown): Step => ({
	tool: "agent",
	args: { type: "coordinate", action: "grant", subagent: "{{CHILD}}", requests },
});

const requestsOf = (steps: readonly Step[]) => {
	const source = script(steps).slice("B64SCRIPT:".length);
	return endpoint.requests.filter((request) => request.script === source);
};
const says = (request: { messages: Array<{ text: string }> } | undefined, text: string): boolean =>
	request?.messages.some((message) => message.text.includes(text)) === true;
/**
 * Starts a parent that can be woken: an RPC session goes idle between turns, as a terminal one does. A headless (`-p`) parent
 * holds inside its last turn until its children have reported, so it reads their mail only then. Returns once it has made
 * every request of its script.
 */
async function runToEnd(box: Sandbox, steps: readonly Step[]): Promise<void> {
	const run = box.start(["--mode", "rpc"], { stdin: "pipe" });
	await until(() => run.stdout().includes('"rpc_ready"'), "RPC to start");
	run.process.stdin?.write(`${JSON.stringify({ id: "p", type: "prompt", message: script(steps) })}\n`);
	await until(() => requestsOf(steps).length >= steps.length, "the parent's last step");
}
const nextSteer = /You have used (\d+) of (\d+) model requests; the run stops at (\d+)/;

describe("a child that asks its parent for more requests", () => {
	it("sees its budget, asks, is granted more while it runs, and goes past the old hard limit", async () => {
		const box = limited(6);
		const marker = path.join(box.root, "granted");
		const need = "I need 6 more requests: the second half of the files is left";
		// Six replies reach the soft limit; the seventh asks; the eighth waits; old hard limit: nine.
		const child: Step[] = [...ticks(1, 6), ask(need), waitFor(marker), ...ticks(9, 13), { text: "done: all of it" }];
		const parent: Step[] = [
			{ tool: "agent", args: { type: "task", background: true, goal: "long work", task: script(child) } },
			{ text: "started it" },
			// The child's message starts this turn.
			grant(0),
			grant(6),
			{ tool: "agent", args: { type: "coordinate", action: "list" } },
			{ tool: "bash", args: { command: `touch ${JSON.stringify(marker)}` } },
			{ text: "granted" },
			// Its report starts this one.
			grant(5),
			{ text: "read its report" },
		];
		await runToEnd(box, parent);

		const childRequests = requestsOf(child);
		// The steer joined the request after the reply that reached the limit, and it names the numbers and how to ask.
		const steer = childRequests[6].messages.findLast((message) => nextSteer.test(message.text))!.text;
		expect(steer).toContain("You have used 6 of 6 model requests; the run stops at 9");
		expect(steer).toContain("`parent`");
		expect(steer).toContain("how many");
		expect(steer).not.toContain("only with your report");
		// Past the hard limit of 9, and it finished on its own.
		expect(childRequests).toHaveLength(14);
		expect(says(childRequests.at(-1), "granted 6 more model requests")).toBe(true);
		expect(says(childRequests.at(-1), "the run now stops at 15")).toBe(true);
		// A second check at the new soft limit, so it can ask again.
		expect(says(childRequests[12], "You have used 12 of 12 model requests; the run stops at 15")).toBe(true);

		const parentRequests = requestsOf(parent);
		const results = parentRequests.at(-1)!.toolResults;
		expect(says(parentRequests[2], need)).toBe(true);
		expect(results.find((result) => result.includes("positive whole number"))).toBeDefined();
		expect(results.find((result) => result.includes("Granted 6 more"))).toContain("stops at 15");
		// `coordinate list` shows the cost beside what it already shows.
		expect(results.find((result) => result.includes("· parent "))).toMatch(/\d+ of 12 requests, stops at 15/);
		// The child has finished: a grant has nothing to raise.
		expect(results.at(-1)).toContain("is not running");
		expect(says(parentRequests.at(-1), "reported done")).toBe(true);
	});

	it("keeps working unanswered and stops at the hard limit with its work and a way to continue", async () => {
		const box = limited(2);
		const child: Step[] = [
			{ tool: "file", args: { queries: [{ type: "write", path: "kept.txt", content: "work\n" }] } },
			...ticks(2, 40),
		];
		const parent: Step[] = [
			{ tool: "agent", args: { type: "task", background: true, goal: "long work", task: script(child) } },
			{ text: "started it" },
			{ text: "read its report" },
		];
		const { code } = await box.start(["-p", script(parent)]).exited;
		expect(code).toBe(0);
		expect(requestsOf(child)).toHaveLength(3);
		expect(fs.readFileSync(path.join(box.project, "kept.txt"), "utf8")).toBe("work\n");
		// The parent was not called for it, and nothing waited on the parent.
		const parentRequests = requestsOf(parent);
		expect(parentRequests).toHaveLength(3);
		const report = parentRequests
			.at(-1)!
			.messages.findLast((message) => message.text.includes("model request budget"))!;
		expect(report.text).toContain("reported partial");
		expect(report.text).toContain("stopped at the model request budget (3 requests; limit 2, hard limit 3)");
		expect(report.text).toContain("Changed files (1): kept.txt");
		const id = /subagent (\S+) \(/.exec(report.text)?.[1];
		expect(id).toBeDefined();
		expect(report.text).toContain(`\`resume: ${id}\``);
	});

	it("tells a foreground child to say what is left in its report, since its parent reads messages only with it", async () => {
		const box = limited(2);
		const child: Step[] = [...ticks(1, 2), { text: "partial: half done; 10 more requests would finish the rest" }];
		const parent: Step[] = [
			{ tool: "agent", args: { type: "task", goal: "long work", task: script(child) } },
			{ text: "read its report" },
		];
		const { code } = await box.start(["-p", script(parent)]).exited;
		expect(code).toBe(0);
		const childRequests = requestsOf(child);
		expect(childRequests).toHaveLength(3);
		const steer = childRequests[2].messages.findLast((message) => nextSteer.test(message.text))!.text;
		expect(steer).toContain("You have used 2 of 2 model requests; the run stops at 3");
		expect(steer).toContain("Your coordinator waits for your report and reads messages only with it");
		expect(steer).toContain("how many");
		expect(steer).not.toContain("`parent`");
		expect(requestsOf(parent)).toHaveLength(2);
	});

	it("gives a resumed child at the hard limit a real allowance instead of a stop", async () => {
		const box = limited(2);
		const first: Step[] = ticks(1, 40);
		const second: Step[] = [...ticks(50, 51), { text: "done: continued" }];
		const parent: Step[] = [
			{ tool: "agent", args: { type: "task", goal: "long work", task: script(first) } },
			{ tool: "agent", args: { type: "task", goal: "the rest", resume: "{{CHILD}}", task: script(second) } },
			{ text: "read its report" },
		];
		const { code } = await box.start(["-p", script(parent)]).exited;
		expect(code).toBe(0);
		expect(requestsOf(first)).toHaveLength(3);
		const secondRequests = requestsOf(second);
		// Three requests of its own: the two tool calls and the answer, where the old limit had none left.
		expect(secondRequests).toHaveLength(3);
		// The stop may save an aborted reply too, and saved replies are what count: the allowance starts from that count.
		const told = /Your coordinator continued you after (\d+) model requests; the run is stopped at (\d+)/.exec(
			secondRequests[0].lastUserText,
		);
		expect(Number(told?.[1])).toBeGreaterThanOrEqual(3);
		expect(Number(told?.[2])).toBe(Number(told?.[1]) + 3);
		expect(says(requestsOf(parent).at(-1), "reported done")).toBe(true);
	});

	it("gives a child resumed past its soft limit the same allowance, not just what was left of the hard limit", async () => {
		const box = limited(2);
		const first: Step[] = [tick(1), { text: "partial: stopped early" }];
		const second: Step[] = [...ticks(50, 51), { text: "done: continued" }];
		const parent: Step[] = [
			{ tool: "agent", args: { type: "task", goal: "long work", task: script(first) } },
			{ tool: "agent", args: { type: "task", goal: "the rest", resume: "{{CHILD}}", task: script(second) } },
			{ text: "read its report" },
		];
		const { code } = await box.start(["-p", script(parent)]).exited;
		expect(code).toBe(0);
		const secondRequests = requestsOf(second);
		expect(secondRequests).toHaveLength(3);
		// Reply 4 of the child reaches the limit its resume set, so it can ask again.
		expect(says(secondRequests[2], "You have used 4 of 4 model requests; the run stops at 5")).toBe(true);
		expect(says(requestsOf(parent).at(-1), "reported done")).toBe(true);
	});

	it("leaves the budget off when it is 0: no steer, no limit in the list, and a grant is refused", async () => {
		const box = limited(0);
		const marker = path.join(box.root, "answered");
		const child: Step[] = [...ticks(1, 8), ask("go on"), waitFor(marker), { text: "done: no limits" }];
		const parent: Step[] = [
			{ tool: "agent", args: { type: "task", background: true, goal: "long work", task: script(child) } },
			{ text: "started it" },
			grant(5),
			{ tool: "agent", args: { type: "coordinate", action: "list" } },
			{ tool: "bash", args: { command: `touch ${JSON.stringify(marker)}` } },
			{ text: "answered" },
			{ text: "read its report" },
		];
		await runToEnd(box, parent);
		const childRequests = requestsOf(child);
		expect(childRequests).toHaveLength(11);
		expect(childRequests.some((request) => request.messages.some((message) => nextSteer.test(message.text)))).toBe(
			false,
		);
		const results = requestsOf(parent).at(-1)!.toolResults;
		expect(results.find((result) => result.includes("no request limit"))).toBeDefined();
		expect(results.find((result) => result.includes("· parent "))).not.toMatch(/requests, stops at/);
	});
});
