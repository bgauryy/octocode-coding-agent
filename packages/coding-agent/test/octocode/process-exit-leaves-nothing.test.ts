import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
 * A headless run that holds a background bash job and a background subagent running its own bash command, ended by a
 * signal or by a crash: afterwards no process of the run is left, whichever way it ended.
 */
let endpoint: Endpoint;

// A source CLI start takes seconds, more on a busy machine, and a child is another one.
vi.setConfig({ testTimeout: 120_000 });

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

describe.runIf(process.platform !== "win32")("a run that ends while it holds background work", () => {
	it.each([
		{ end: "SIGTERM", signal: "SIGTERM" as const, code: 143 },
		// An uncaught error on the main thread: the process exits 1 without its graceful shutdown.
		{ end: "a crash", signal: "SIGUSR2" as const, code: 1 },
	])("leaves no process behind after $end", async ({ signal, code }) => {
		const box = sandbox(endpoint);
		const crash = path.join(box.root, "crash.mjs");
		fs.writeFileSync(crash, 'process.on("SIGUSR2", () => setImmediate(() => { throw new Error("test crash"); }));\n');
		box.env.NODE_OPTIONS = `--import ${JSON.stringify(crash)}`;
		const marker = path.join(box.root, "child.pid");
		const jobMarker = path.join(box.root, "job.pid");
		const child: Step[] = [
			{ tool: "bash", args: { command: box.holdCommand(marker), timeout: 280 } },
			{ text: "done" },
		];
		const parent: Step[] = [
			{ tool: "bash", args: { command: box.holdCommand(jobMarker), background: true, timeout: 280 } },
			{ tool: "agent", args: { type: "task", background: true, goal: "hold a command", task: script(child) } },
			{ text: "waiting for the child" },
		];
		const run = box.start(["-p", script(parent)]);
		await until(() => fs.existsSync(marker) && fs.existsSync(jobMarker), "the child's command and the job");
		const command = pidFrom(marker);
		const job = pidFrom(jobMarker);
		expect(alive(command) && alive(job)).toBe(true);

		run.process.kill(signal);
		expect((await run.exited).code).toBe(code);
		await until(
			() => !alive(command) && !alive(job),
			"the child's command and the job to stop",
			15_000,
			() =>
				`child command ${command}: ${alive(command)}, background job ${job}: ${alive(job)}, sandbox PIDs: ${box.survivors().join(", ")}`,
		);
		await until(() => box.survivors().length === 0, "every process of the run to stop", 15_000);
	});
});
