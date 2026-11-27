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
} from "./e2e-real-process-harness.ts";

/**
 * The check-in through real processes on the scripted model: the child's own harness sends it, it arrives in the child's
 * next request, and the parent's model is never called for it. A short interval comes from settings, as a user sets it.
 */
const PING = "Do you need something?";

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

/** A sandbox whose global settings give `checkInSeconds`. */
function withInterval(seconds: number): Sandbox {
	const box = sandbox(endpoint);
	fs.writeFileSync(
		path.join(box.home, ".octocode", "octocodecode", "settings.json"),
		JSON.stringify({ monitor: { checkInSeconds: seconds } }),
	);
	return box;
}

const sleep: Step = { tool: "bash", args: { command: "sleep 1.5" } };
const requestsOf = (steps: readonly Step[]) => {
	const source = script(steps).slice("B64SCRIPT:".length);
	return endpoint.requests.filter((request) => request.script === source);
};
const pinged = (request: { messages: Array<{ role: string; text: string }> }) =>
	request.messages.some((message) => message.role === "user" && message.text.includes(PING));

describe("the subagent check-in", () => {
	it("reaches a background child's next request, costs its parent no request, and the child's reply reaches the parent", async () => {
		const box = withInterval(1);
		const reply = "premise is wrong: the file is generated";
		const child: Step[] = [
			sleep,
			sleep,
			sleep,
			{ tool: "agent", args: { type: "message", to: "parent", message: reply } },
			{ text: "done: nothing else to do" },
		];
		const parent: Step[] = [
			{ tool: "agent", args: { type: "task", background: true, goal: "check in on me", task: script(child) } },
			{ text: "started it" },
			{ text: "read its report" },
		];
		const { code } = await box.start(["-p", script(parent)]).exited;
		expect(code).toBe(0);

		const childRequests = requestsOf(child);
		const firstPing = childRequests.find(pinged);
		expect(firstPing, "a child request with the ping").toBeDefined();
		// The ping names how to answer in the background: a message to its parent.
		const text = firstPing!.messages.findLast((message) => message.text.includes(PING))!.text;
		expect(text).toContain("`parent`");
		expect(text).not.toContain("`blocked`");
		// Every ping after the first step joined a request the child was making anyway: the script's steps are all it made.
		expect(childRequests.map((request) => request.step)).toEqual([0, 1, 2, 3, 4]);
		expect(childRequests.filter(pinged).length).toBeGreaterThanOrEqual(2);

		const parentRequests = requestsOf(parent);
		// Pings went on until the child made the request that answers with its message: the parent's model was not called.
		const answering = childRequests[3];
		const during = parentRequests.filter((request) => request.at >= firstPing!.at && request.at <= answering.at);
		expect(during, "no parent request while the child was checked on").toEqual([]);
		// The parent made its two requests before the child's first ping, and the rest only for the reply and the report.
		expect(parentRequests.filter((request) => request.at < firstPing!.at)).toHaveLength(2);
		expect(parentRequests.some((request) => request.messages.some((message) => message.text.includes(reply)))).toBe(
			true,
		);
		expect(
			parentRequests.at(-1)!.messages.some((message) => message.text.includes("reported done")),
			"the report",
		).toBe(true);
	});

	it("tells a foreground child to finish with blocked, since its parent reads messages only with its report", async () => {
		const box = withInterval(1);
		const note = "a note the parent reads with my report";
		const child: Step[] = [
			sleep,
			sleep,
			{ tool: "agent", args: { type: "message", to: "parent", message: note } },
			{ text: "done: nothing else to do" },
		];
		const parent: Step[] = [
			{ tool: "agent", args: { type: "task", goal: "check in on me", task: script(child) } },
			{ text: "read its report" },
		];
		const { code } = await box.start(["-p", script(parent)]).exited;
		expect(code).toBe(0);

		const firstPing = requestsOf(child).find(pinged);
		expect(firstPing, "a child request with the ping").toBeDefined();
		const text = firstPing!.messages.findLast((message) => message.text.includes(PING))!.text;
		expect(text).toContain("`blocked`");
		expect(text).toContain("only with it");
		// Its own message says the same in its result, and reaches the parent along with the report.
		expect(requestsOf(child).at(-1)!.toolResults.at(-1)).toContain(
			"it cannot answer during this run; if you need its decision or it should know now, finish with a `blocked` report",
		);
		expect(requestsOf(parent)).toHaveLength(2);
		expect(
			requestsOf(parent)
				.at(-1)!
				.messages.some((message) => message.text.includes(note)),
		).toBe(true);
	});

	it("sends nothing when the setting is 0", async () => {
		const box = withInterval(0);
		// One sleep outlasts the 1 s interval: a ping would join the request after it.
		const child: Step[] = [sleep, { text: "done: nothing else to do" }];
		const parent: Step[] = [
			{ tool: "agent", args: { type: "task", goal: "leave me alone", task: script(child) } },
			{ text: "read its report" },
		];
		const { code } = await box.start(["-p", script(parent)]).exited;
		expect(code).toBe(0);
		expect(requestsOf(child).length).toBeGreaterThan(0);
		expect(requestsOf(child).filter(pinged)).toEqual([]);
	});

	it("sends nothing in the top-level session, which has no parent", async () => {
		const box = withInterval(1);
		const steps: Step[] = [sleep, { text: "done" }];
		const { code } = await box.start(["-p", script(steps)]).exited;
		expect(code).toBe(0);
		expect(requestsOf(steps).filter(pinged)).toEqual([]);
	});
});
