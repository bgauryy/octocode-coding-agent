import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	type Endpoint,
	killEverything,
	outputOfRuns,
	sandbox,
	script,
	startEndpoint,
} from "./e2e-real-process-harness.ts";

/**
 * `steps` state across calls and a `timer` wake reaching the model, through a real headless process on a scripted model.
 * (e2e-all-tools covers each tool's single-call results; the wake itself had no end-to-end coverage.)
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

const lastResult = () => endpoint.requests.at(-1)?.toolResults.at(-1) ?? "";

describe("steps and timer through a real session", () => {
	it("keeps steps state across calls: add, update, list", async () => {
		const box = sandbox(endpoint);
		// `steps` is registered but not default-active: the run opts in.
		const run = box.start([
			"--tools",
			"+steps",
			"-p",
			script([
				{ tool: "steps", args: { op: "add", goal: "Write the thing" } },
				{ tool: "steps", args: { op: "update", id: "T1", state: "done", result: "wrote it" } },
				{ tool: "steps", args: { op: "list", state: "done" } },
				{ text: "steps finished" },
			]),
		]);
		const { code } = await run.exited;
		expect(code, `${run.stdout()}\n${run.stderr()}`).toBe(0);
		expect(endpoint.requests).toHaveLength(4);
		expect(endpoint.requests[1].toolResults.at(-1), "add result").toContain("Added T1");
		expect(endpoint.requests[2].toolResults.at(-1), "update result").toContain("T1");
		const listed = lastResult();
		expect(listed, "list of done steps must show the updated step").toContain("T1");
		expect(listed).toContain("Write the thing");
	});

	it("wakes the session when a timer fires and sends the note to the model", async () => {
		const box = sandbox(endpoint);
		const note = "TIMERWAKE-check-the-build";
		const run = box.start([
			"-p",
			script([
				{ tool: "timer", args: { op: "set", after: 1, note } },
				{ text: "timer scheduled" },
				{ text: "woken by the timer" },
			]),
		]);
		const { code } = await run.exited;
		expect(code, `${run.stdout()}\n${run.stderr()}`).toBe(0);
		expect(endpoint.requests.length, "the wake did not trigger another model request").toBeGreaterThanOrEqual(3);
		const wake =
			endpoint.requests
				.at(-1)
				?.messages.map((m) => m.text)
				.join("\n") ?? "";
		expect(wake, "wake note missing from the request after the timer fired").toContain(note);
	});
});
