import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { TeamStore } from "../../src/octocode/team/store.ts";
import {
	close,
	message,
	prompt,
	reachedStep,
	requestsOf,
	resultsOf,
	script,
	session,
	shareTeam,
} from "./e2e-a2a-helpers.ts";
import {
	type Endpoint,
	killEverything,
	outputOfRuns,
	type Sandbox,
	sandbox,
	startEndpoint,
	type Step,
	until,
} from "./e2e-real-process-harness.ts";

/**
 * Team mail between a session and its subagents, through real processes on the scripted model: a parent and its
 * children talk both ways, a busy child reads mail at its next step, an idle parent is woken, a child's message to
 * another session tree is refused, and a stand-up broadcast collects every child's answer.
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
const background = (goal: string, task: string): Step => ({
	tool: "agent",
	args: { type: "task", background: true, goal, task },
});

/** A sandbox whose sessions share a team database the test can read. */
function teamBox(): { box: Sandbox; store: () => TeamStore } {
	const box = sandbox(endpoint);
	return { box, store: shareTeam(box) };
}

const read = <T>(open: () => TeamStore, work: (store: TeamStore) => T): T => {
	const store = open();
	try {
		return work(store);
	} finally {
		store.close();
	}
};

/** How many subagents have joined the team. */
const children = (open: () => TeamStore): number =>
	read(open, (db) => db.list().filter((each) => each.parentId).length);

/** The texts of every message a script's requests carried. */
const heard = (steps: string): string =>
	requestsOf(endpoint, steps)
		.flatMap((request) => request.messages.map((each) => each.text))
		.join("\n");

describe("a session tree", () => {
	it("parent and children talk both ways, a busy child reads at its next step, and another tree is refused", async () => {
		const { box, store } = teamBox();
		// Another session tree: a top-level session with a child that stays in its request.
		const other = await session(box);
		prompt(other.run, "other", script([background("stay", script([{ hang: true }])), { text: "other started" }]));
		let outsider = "";
		await until(() => {
			outsider = read(store, (db) => db.list().find((member) => member.parentId)?.id ?? "");
			return outsider !== "";
		}, "the other tree's child to join");

		const parent = await session(box);
		// The busy child runs a short command at every step (the last step repeats) until the broadcast, which carries the
		// script that ends it, reaches its context: it stays busy however long the sender takes to start.
		const busy = script([sleep(2)]);
		const done = script([{ text: "busy child done" }]);
		const sender = script([
			message("parent", "hello parent from the sender", { wake: true }),
			message("all", `hello team from the sender ${done}`),
			message(outsider, "hello other tree"),
			{ text: "sender done" },
		]);
		// A child reads mail once it has joined the team (before that a send is refused as "still starting"): the second
		// prompt comes once it has.
		const start = script([background("stay busy", busy), { text: "started" }]);
		prompt(parent.run, "start", start);
		await reachedStep(endpoint, start, 1, "the busy child started");
		await until(() => children(store) >= 2, "the busy child to join");
		const steps = script([
			message("{{CHILD}}", "parent to the busy child: keep going"),
			background("send mail", sender),
			{ text: "parent idle" },
		]);
		prompt(parent.run, "go", steps);

		expect(resultsOf(endpoint, steps)).not.toContain("cannot read messages yet");
		await reachedStep(endpoint, sender, 3, "the sender's three sends");
		const sent = resultsOf(endpoint, sender);
		expect(sent).toMatch(/Queued message #\d+ for \S+ as an FYI/);
		expect(sent).toContain(`${outsider} is outside your team; ask your coordinator`);
		expect(read(store, (db) => db.pending(outsider).map((each) => each.text))).toEqual([]);

		// The busy child read both messages in a later step of its own script, with no extra request: steered, not woken.
		await until(() => heard(done).includes("hello team from the sender"), "the busy child reading the broadcast");
		await until(
			() => [busy, done].some((each) => heard(each).includes("parent to the busy child")),
			"the busy child reading its parent's message",
		);
		const busyRequests = [...requestsOf(endpoint, busy), ...requestsOf(endpoint, done)];
		const ownSteps = requestsOf(endpoint, busy).map((request) => request.step);
		expect(new Set(ownSteps).size).toBe(ownSteps.length);
		const steered = busyRequests.find((request) =>
			request.messages.some((each) => each.text.includes("parent to the busy child")),
		);
		expect(steered, `the busy child's requests: ${heard(busy)}${heard(done)}`).toBeDefined();
		expect(steered!.step).toBeGreaterThan(0);
		const fromParent = steered!.messages.find((each) => each.text.includes("parent to the busy child"))!.text;
		expect(fromParent).toContain("your coordinator");
		const fromSibling = requestsOf(endpoint, done)
			.flatMap((request) => request.messages)
			.find((each) => each.text.includes("hello team from the sender"))!.text;
		expect(fromSibling).not.toContain("your coordinator");

		// The parent went idle after starting both, and the sender's wake started a turn that read it.
		await until(
			() => [steps, done].some((each) => heard(each).includes("hello parent from the sender")),
			"the idle parent woken",
		);
		await close(parent, other);
	});

	it("a stand-up broadcast reaches every busy child, and each answer comes back to the parent", async () => {
		const { box, store } = teamBox();
		const parent = await session(box);
		// Each child follows the script the stand-up carries once it reads it, at its next step. The database is new, so the
		// stand-up is message #1: an answer naming it wakes the idle asker (an FYI to an idle agent would only wait).
		const answer = script([
			{ tool: "agent", args: { type: "message", replyTo: 1, message: "stand-up answer: no blockers" } },
			{ text: "answered" },
		]);
		// Each child runs a short command at every step (the last step repeats) until the stand-up reaches it.
		const kid = script([sleep(2)]);
		const start = script([background("first", kid), background("second", kid), { text: "started" }]);
		prompt(parent.run, "start", start);
		await reachedStep(endpoint, start, 2, "both children started");
		// "all" reaches the agents that have joined: a child still starting is not among them.
		await until(() => children(store) >= 2, "both children to join");
		const steps = script([
			message("all", `Stand-up: what blocks you? ${answer}`, { replyRequired: true }),
			{ text: "asked" },
		]);
		prompt(parent.run, "go", steps);
		await reachedStep(endpoint, steps, 1, "the stand-up sent");
		expect(resultsOf(endpoint, steps)).toMatch(/Queued message #1 for \S+, \S+ as a request/);
		await until(() => requestsOf(endpoint, answer).filter((request) => request.step === 1).length >= 2, "both answers");
		await until(
			() => (heard(steps).match(/stand-up answer: no blockers/g) ?? []).length >= 2,
			"both answers reaching the parent",
		);
		await close(parent);
	});
});
