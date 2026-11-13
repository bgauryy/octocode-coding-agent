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
 * A call to the removed `steps` tool and a `timer` wake reaching the model, through a real headless process on a scripted
 * model. (e2e-all-tools covers each tool's single-call results; the wake itself had no end-to-end coverage.)
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

const lastResult = () => endpoint.requests.at(-1)?.toolResults.at(-1) ?? "";

describe("the removed steps tool and timer through a real session", () => {
	it("refuses a call to the removed steps tool in one sentence that names what replaces it, and the run goes on", async () => {
		const box = sandbox(endpoint);
		const run = box.start([
			"-p",
			script([{ tool: "steps", args: { op: "add", goal: "Write the thing" } }, { text: "went on without steps" }]),
		]);
		const { code } = await run.exited;
		expect(code, `${run.stdout()}\n${run.stderr()}`).toBe(0);
		expect(endpoint.requests).toHaveLength(2);
		expect(endpoint.requests[0].tools, "steps must not be declared").not.toContain("steps");
		expect(lastResult()).toBe(
			"Tool steps not found: it was removed. Keep the steps of an item in its plan (backlogPlan edit) and record progress with backlog note.",
		);
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
