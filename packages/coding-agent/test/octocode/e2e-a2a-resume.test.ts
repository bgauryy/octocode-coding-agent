import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	close,
	message,
	prompt,
	records,
	requestsOf,
	resultsOf,
	script,
	session,
	sessionIdle,
} from "./e2e-a2a-helpers.ts";
import {
	type Endpoint,
	killEverything,
	outputOfRuns,
	sandbox,
	startEndpoint,
	until,
} from "./e2e-real-process-harness.ts";

/**
 * A message to a child that already finished its run reaches it again. The child is a real process that left the team
 * after its report and lingers; the parent's message resumes it, and the resumed run reads the message framed as its
 * parent's, in its own database row (a stored message a reply can name), not as a lost dead letter.
 */
let endpoint: Endpoint;
vi.setConfig({ testTimeout: 240_000 });

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

const heard = (steps: string): string =>
	requestsOf(endpoint, steps)
		.flatMap((request) => request.messages.map((each) => each.text))
		.join("\n");

describe("a finished child", () => {
	it("is resumed by its parent's message and reads it, with the stored message recorded for it", async () => {
		const box = sandbox(endpoint);
		const file = path.join(box.root, "team.sqlite");
		box.env.OCTOCODE_AGENT_DB = file;
		// A finished run keeps its process for follow-ups for this long.
		box.env.OCTOCODE_SUBAGENT_LINGER_SECONDS = "120";
		const parent = await session(box);
		const worker = script([{ text: "worker finished its first run" }]);
		const start = script([
			{ tool: "agent", args: { type: "task", background: true, goal: "finish first", task: worker } },
			{ text: "started" },
		]);
		prompt(parent.run, "start", start);
		// The child's report reached the parent: the child is finished and now only lingers.
		await until(() => heard(start).includes("worker finished its first run"), "the child's report");
		await sessionIdle(parent);
		const before = requestsOf(endpoint, worker).length;

		const steps = script([
			message("{{CHILD}}", "second round: confirm you got this", { replyRequired: true }),
			{ text: "asked" },
		]);
		prompt(parent.run, "go", steps);
		const response = () => records(parent.run).find((row) => row.type === "response" && row.id === "go");
		await until(() => response() !== undefined, "the follow-up prompt response");
		expect(response()).toMatchObject({ success: true });
		await until(() => requestsOf(endpoint, steps).some((request) => request.step >= 1), "the message sent");
		expect(resultsOf(endpoint, steps)).not.toContain("takes no more messages");

		// The resumed run is a new request of the child's own script, and it carries the message.
		await until(() => requestsOf(endpoint, worker).length > before, "the child's resumed run");
		await until(() => heard(worker).includes("second round: confirm you got this"), "the child reading it");
		const framed = requestsOf(endpoint, worker)
			.flatMap((request) => request.messages)
			.find((each) => each.text.includes("second round: confirm you got this"))!.text;
		expect(framed).toContain("your coordinator");
		await close(parent);
	});
});
