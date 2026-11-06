import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	type Endpoint,
	killEverything,
	outputOfRuns,
	sandbox,
	script,
	type Step,
	startEndpoint,
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
