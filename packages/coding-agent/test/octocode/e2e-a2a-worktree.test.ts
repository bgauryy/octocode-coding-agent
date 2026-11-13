import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { close, message, prompt, reachedStep, requestsOf, resultsOf, script, session } from "./e2e-a2a-helpers.ts";
import {
	type Endpoint,
	killEverything,
	outputOfRuns,
	sandbox,
	startEndpoint,
	type Step,
	until,
} from "./e2e-real-process-harness.ts";

/**
 * An isolated (worktree) child is a teammate. Its team database comes from the Octocode home, not from its
 * working directory, so it sees its coordinator and its sibling, messages both, and reads their replies, on real
 * processes and the scripted model.
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

const sleep = (seconds: number): Step => ({ tool: "bash", args: { command: `sleep ${seconds}` } });
/** Holds the script until another agent created `file`: the order the test needs, whatever the start-up times. */
const waitFor = (file: string): Step => ({
	tool: "bash",
	args: { command: `for i in $(seq 1 1200); do [ -f ${JSON.stringify(file)} ] && break; sleep 0.1; done` },
});
const mark = (file: string): Step => ({ tool: "bash", args: { command: `touch ${JSON.stringify(file)}` } });
const list: Step = { tool: "agent", args: { type: "coordinate", action: "list" } };
const isolated = (profile: string, goal: string, task: string): Step => ({
	tool: "agent",
	args: { type: "task", background: true, isolate: true, profile, goal, task },
});

describe("isolated children on one team", () => {
	it("see their coordinator and sibling, message both, and read the replies", async () => {
		const box = sandbox(endpoint);
		const gate = (name: string) => path.join(box.root, `gate-${name}`);
		const parent = await session(box);

		// Siblings are told apart by role: ids are generated, and a unique role name resolves like an id.
		// The implementer sends first, once the researcher listed the team; the researcher answers that message.
		const implementer = script([
			waitFor(gate("researcher-joined")),
			list,
			message("researcher", "hello researcher from the implementer", { replyRequired: true }),
			message("parent", "hello coordinator from the implementer", { wake: true }),
			mark(gate("implementer-sent")),
			waitFor(gate("coordinator-replied")),
			sleep(1),
		]);
		const researcher = script([
			list,
			mark(gate("researcher-joined")),
			waitFor(gate("implementer-sent")),
			// The implementer's message is the first in this database: a reply names it.
			{ tool: "agent", args: { type: "message", replyTo: 1, message: "reply from the researcher" } },
			message("parent", "hello coordinator from the researcher", { wake: true }),
			mark(gate("researcher-sent")),
			waitFor(gate("coordinator-replied")),
			sleep(1),
		]);
		const steps = script([
			isolated("implementer", "talk as a teammate", implementer),
			isolated("researcher", "talk as a teammate", researcher),
			waitFor(gate("researcher-sent")),
			message("implementer", "coordinator reply to the implementer"),
			message("researcher", "coordinator reply to the researcher"),
			mark(gate("coordinator-replied")),
			{ text: "coordinator idle" },
		]);
		prompt(parent.run, "go", steps);

		const heard = (steps: string) =>
			requestsOf(endpoint, steps)
				.flatMap((request) => request.messages.map((each) => each.text))
				.join("\n");
		await reachedStep(endpoint, implementer, 6, "the implementer to finish its sends");
		await reachedStep(endpoint, steps, 6, "the coordinator to answer both");

		// The implementer's list names the coordinator (the main checkout's session) and the researcher, each in its own worktree.
		const listed = requestsOf(endpoint, implementer)
			.at(-1)!
			.toolResults.find((result) => result.includes("talk as a teammate"));
		expect(listed, "the implementer's coordinate list").toBeDefined();
		expect(listed).toMatch(/ · main · /);
		expect(listed).toContain("(you) · implementer");
		expect(listed).toMatch(/ · researcher · [^\n]*\n[^\n]*\n[^\n]*\n[^\n]*worktrees\//);
		expect(listed).toMatch(/parent \S+ · worktree \S+\n/);

		const sent = resultsOf(endpoint, implementer);
		expect(sent).toMatch(/Queued message #1 for \S+ as a request/);
		expect(sent).toMatch(/Queued message #2 for \S+ as an FYI/);

		// Both messages reached the other side: the sibling, the coordinator, and each child's reply.
		await until(() => heard(researcher).includes("hello researcher from the implementer"), "the sibling's message");
		await until(() => heard(implementer).includes("reply from the researcher"), "the sibling's reply");
		await until(() => heard(implementer).includes("coordinator reply to the implementer"), "the coordinator's reply");
		await until(() => heard(researcher).includes("coordinator reply to the researcher"), "the coordinator's reply");
		await until(
			() =>
				heard(steps).includes("hello coordinator from the implementer") &&
				heard(steps).includes("hello coordinator from the researcher"),
			"the coordinator hearing both children",
		);
		await close(parent);
	});
});
