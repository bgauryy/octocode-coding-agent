import type { AgentTool } from "@octocodeai/octocode-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import type { FeatureSetup } from "../../src/core/features/index.ts";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, getUserTexts, type Harness } from "./harness.ts";
import { testFeatures } from "../helpers/features.ts";

async function createWaitingHarness(factories: Array<(api: FeatureSetup) => void> = []) {
	let release: () => void = () => {};
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	const waitTool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Wait for release",
		parameters: Type.Object({}),
		execute: async () => {
			await released;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	};
	const harness = await createHarness({ tools: [waitTool], features: testFeatures(factories) });
	harness.setResponses([fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" })]);
	const toolStarted = new Promise<void>((resolve) => {
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "tool_execution_start") {
				unsubscribe();
				resolve();
			}
		});
	});
	const promptPromise = harness.session.prompt("start");
	await toolStarted;
	return { harness, release, promptPromise };
}

const waitingResponses = (...rest: ReturnType<typeof fauxAssistantMessage>[]) => rest;

describe("AgentSession queue management", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("lists queued inputs in delivery order with kind, text, source and attachment count", async () => {
		let api: FeatureSetup | undefined;
		const { harness, release, promptPromise } = await createWaitingHarness([
			(host) => {
				api = host;
			},
		]);
		harnesses.push(harness);
		harness.setResponses(waitingResponses(fauxAssistantMessage("a"), fauxAssistantMessage("b")));
		const { session } = harness;

		await session.followUp("after");
		await session.steer("first", [{ type: "image", data: "AAAA", mimeType: "image/png" }]);
		api?.session.sendUserMessage("from feature", { deliverAs: "steer" });
		await new Promise((resolve) => setTimeout(resolve, 0));

		const queued = session.getQueuedInputs();
		expect(queued.map(({ mode, text, imageCount, source }) => ({ mode, text, imageCount, source }))).toEqual([
			{ mode: "steer", text: "first", imageCount: 1, source: "interactive" },
			{ mode: "steer", text: "from feature", imageCount: 0, source: "feature" },
			{ mode: "followUp", text: "after", imageCount: 0, source: "interactive" },
		]);
		expect(new Set(queued.map((entry) => entry.id)).size).toBe(3);
		expect(session.getSteeringMessages()).toEqual(["first", "from feature"]);
		expect(session.getFollowUpMessages()).toEqual(["after"]);

		session.clearQueue();
		expect(session.getQueuedInputs()).toEqual([]);
		release();
		await promptPromise;
	});

	it("replaces queued text and delivers the edited text, keeping attachments", async () => {
		const { harness, release, promptPromise } = await createWaitingHarness();
		harnesses.push(harness);
		harness.setResponses(waitingResponses(fauxAssistantMessage("done")));
		const { session } = harness;
		const events: string[][] = [];
		session.subscribe((event) => {
			if (event.type === "queue_update") events.push([...event.steering]);
		});

		await session.steer("draft", [{ type: "image", data: "AAAA", mimeType: "image/png" }]);
		const [entry] = session.getQueuedInputs();
		expect(session.replaceQueuedInput(entry.id, "final")).toBe("replaced");
		expect(session.getSteeringMessages()).toEqual(["final"]);
		expect(session.getQueuedInputs()[0]).toMatchObject({ id: entry.id, text: "final", imageCount: 1 });
		expect(events.at(-1)).toEqual(["final"]);

		release();
		await promptPromise;
		expect(getUserTexts(harness)).toEqual(["start", "final"]);
		const delivered = harness.session.messages.find(
			(message) => message.role === "user" && getMessageText(message) === "final",
		);
		expect(JSON.stringify(delivered)).toContain("image/png");
	});

	it("treats an empty or whitespace-only replacement as removal", async () => {
		const { harness, release, promptPromise } = await createWaitingHarness();
		harnesses.push(harness);
		harness.setResponses(waitingResponses(fauxAssistantMessage("done")));
		const { session } = harness;

		await session.steer("gone");
		await session.followUp("stays");
		const [steerEntry] = session.getQueuedInputs();
		expect(session.replaceQueuedInput(steerEntry.id, "  \n\t ")).toBe("removed");
		expect(session.getQueuedInputs().map((entry) => entry.text)).toEqual(["stays"]);

		release();
		await promptPromise;
		expect(getUserTexts(harness)).toEqual(["start", "stays"]);
	});

	it("removes one queued input without touching the others", async () => {
		const { harness, release, promptPromise } = await createWaitingHarness();
		harnesses.push(harness);
		harness.setResponses(waitingResponses(fauxAssistantMessage("1"), fauxAssistantMessage("2")));
		const { session } = harness;

		await session.steer("one");
		await session.steer("two");
		await session.followUp("three");
		const ids = session.getQueuedInputs().map((entry) => entry.id);
		expect(session.removeQueuedInput(ids[0])).toMatchObject({ mode: "steer", text: "one" });
		expect(session.removeQueuedInput(ids[0])).toBeUndefined();
		expect(session.pendingMessageCount).toBe(2);

		release();
		await promptPromise;
		expect(getUserTexts(harness)).toEqual(["start", "two", "three"]);
	});

	it("keeps unrelated custom messages when removing a queued user input", async () => {
		const { harness, release, promptPromise } = await createWaitingHarness();
		harnesses.push(harness);
		harness.setResponses(waitingResponses(fauxAssistantMessage("done")));
		const { session } = harness;
		await session.steer("discard me");
		await session.sendCustomMessage(
			{ customType: "team-mail", content: "Keep this mail", display: false },
			{ deliverAs: "steer" },
		);
		const [queued] = session.getQueuedInputs();
		expect(session.removeQueuedInput(queued.id)?.text).toBe("discard me");
		release();
		await promptPromise;
		expect(getUserTexts(harness)).toEqual(["start"]);
		expect(session.messages.some((message) => message.role === "custom" && message.customType === "team-mail")).toBe(
			true,
		);
	});

	it("moves queued inputs within their kind and delivers the new order", async () => {
		const { harness, release, promptPromise } = await createWaitingHarness();
		harnesses.push(harness);
		harness.setResponses(
			waitingResponses(fauxAssistantMessage("1"), fauxAssistantMessage("2"), fauxAssistantMessage("3")),
		);
		const { session } = harness;

		await session.steer("a");
		await session.steer("b");
		await session.followUp("c");
		const [a, b, c] = session.getQueuedInputs();
		expect(session.moveQueuedInput(b.id, "up")).toBe(true);
		expect(session.getSteeringMessages()).toEqual(["b", "a"]);
		expect(session.moveQueuedInput(b.id, "up")).toBe(false);
		expect(session.moveQueuedInput(a.id, "down")).toBe(false);
		expect(session.moveQueuedInput(c.id, "down")).toBe(false);
		expect(session.moveQueuedInput("missing", "up")).toBe(false);

		release();
		await promptPromise;
		expect(getUserTexts(harness)).toEqual(["start", "b", "a", "c"]);
	});

	it("moves user input across a queued custom message without dropping or reordering that message", async () => {
		const { harness, release, promptPromise } = await createWaitingHarness();
		harnesses.push(harness);
		harness.setResponses(
			waitingResponses(
				fauxAssistantMessage("1"),
				fauxAssistantMessage("2"),
				fauxAssistantMessage("3"),
				fauxAssistantMessage("4"),
			),
		);
		const { session } = harness;
		await session.steer("a");
		await session.sendCustomMessage(
			{ customType: "team-mail", content: "mail", display: false },
			{ deliverAs: "steer" },
		);
		await session.steer("b");
		const [, b] = session.getQueuedInputs();
		expect(session.moveQueuedInput(b.id, "up")).toBe(true);
		release();
		await promptPromise;
		expect(
			session.messages
				.filter((message) => message.role === "user" || message.role === "custom")
				.map((message) => `${message.role}:${getMessageText(message)}`),
		).toEqual(["user:start", "user:b", "custom:mail", "user:a"]);
	});

	it("cannot edit, remove or move a message once its delivery has begun", async () => {
		const { harness, release, promptPromise } = await createWaitingHarness();
		harnesses.push(harness);
		harness.setResponses(waitingResponses(fauxAssistantMessage("done")));
		const { session } = harness;
		await session.steer("racing");
		const [entry] = session.getQueuedInputs();
		const outcomes: unknown[] = [];
		session.subscribe((event) => {
			if (
				event.type === "message_start" &&
				event.message.role === "user" &&
				getMessageText(event.message) === "racing"
			) {
				outcomes.push(
					session.replaceQueuedInput(entry.id, "too late"),
					session.removeQueuedInput(entry.id),
					session.moveQueuedInput(entry.id, "up"),
				);
			}
		});

		release();
		await promptPromise;
		expect(outcomes).toEqual(["missing", undefined, false]);
		expect(getUserTexts(harness)).toEqual(["start", "racing"]);
	});

	it("shows the edited text to input handlers", async () => {
		const seen: string[] = [];
		const { harness, release, promptPromise } = await createWaitingHarness([
			(api) => {
				api.bus.on("user_input", (event) => {
					seen.push(event.text);
				});
			},
		]);
		harnesses.push(harness);
		harness.setResponses(waitingResponses(fauxAssistantMessage("done")));
		const { session } = harness;
		await session.steer("before");
		seen.length = 0;
		session.replaceQueuedInput(session.getQueuedInputs()[0].id, "after");
		release();
		await promptPromise;
		expect(seen).toEqual(["after"]);
	});

	it("holds a message out of delivery while it is edited and puts it back in the same place", async () => {
		const { harness, release, promptPromise } = await createWaitingHarness();
		harnesses.push(harness);
		harness.setResponses(
			waitingResponses(fauxAssistantMessage("1"), fauxAssistantMessage("2"), fauxAssistantMessage("3")),
		);
		const { session } = harness;
		await session.steer("a");
		await session.steer("b", [{ type: "image", data: "AAAA", mimeType: "image/png" }]);
		await session.steer("c");
		const [, b] = session.getQueuedInputs();

		expect(session.holdQueuedInput(b.id)).toMatchObject({ id: b.id, text: "b", held: true, imageCount: 1 });
		expect(session.getQueuedInputs().map((entry) => [entry.text, entry.held ?? false])).toEqual([
			["a", false],
			["b", true],
			["c", false],
		]);
		// While held, nothing else can change or take it.
		expect(session.holdQueuedInput(b.id)).toBeUndefined();
		expect(session.replaceQueuedInput(b.id, "x")).toBe("missing");
		expect(session.removeQueuedInput(b.id)).toBeUndefined();
		expect(session.setQueuedInputMode(b.id, "followUp")).toBe(false);

		expect(session.releaseQueuedInput(b.id, "B!")).toEqual({ outcome: "queued" });
		expect(session.getQueuedInputs()[1]).toMatchObject({ text: "B!", imageCount: 1 });
		expect(session.getQueuedInputs()[1].held).toBeUndefined();
		release();
		await promptPromise;
		expect(getUserTexts(harness)).toEqual(["start", "a", "B!", "c"]);
		const delivered = session.messages.find((message) => message.role === "user" && getMessageText(message) === "B!");
		expect(JSON.stringify(delivered)).toContain("image/png");
	});

	it("delivery skips a held message; released while the run is active it is delivered later", async () => {
		const { harness, release, promptPromise } = await createWaitingHarness();
		harnesses.push(harness);
		harness.setResponses(waitingResponses(fauxAssistantMessage("1"), fauxAssistantMessage("2")));
		const { session } = harness;
		await session.steer("held");
		await session.steer("other");
		const [held] = session.getQueuedInputs();
		session.holdQueuedInput(held.id);
		const outcomes: unknown[] = [];
		session.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "user" && getMessageText(event.message) === "other")
				outcomes.push(session.releaseQueuedInput(held.id));
		});
		release();
		await promptPromise;
		expect(outcomes).toEqual([{ outcome: "queued" }]);
		expect(getUserTexts(harness)).toEqual(["start", "other", "held"]);
	});

	it("hands a held message back when no run is left to deliver it, and removes it on blank text", async () => {
		const { harness, release, promptPromise } = await createWaitingHarness();
		harnesses.push(harness);
		harness.setResponses(waitingResponses(fauxAssistantMessage("done")));
		const { session } = harness;
		await session.followUp("late");
		await session.followUp("blank me");
		const [late, blank] = session.getQueuedInputs();
		session.holdQueuedInput(late.id);
		session.holdQueuedInput(blank.id);
		expect(session.releaseQueuedInput(blank.id, "  ")).toEqual({ outcome: "removed" });
		release();
		await promptPromise;
		expect(getUserTexts(harness)).toEqual(["start"]);

		expect(session.releaseQueuedInput(late.id, "late!")).toEqual({
			outcome: "idle",
			mode: "followUp",
			text: "late!",
			images: [],
			source: "interactive",
		});
		expect(session.getQueuedInputs()).toEqual([]);
		expect(session.releaseQueuedInput(late.id)).toEqual({ outcome: "missing" });
	});

	it("clearing the queue returns and drops a held message", async () => {
		const { harness, release, promptPromise } = await createWaitingHarness();
		harnesses.push(harness);
		harness.setResponses(waitingResponses(fauxAssistantMessage("done")));
		const { session } = harness;
		await session.steer("held");
		const [held] = session.getQueuedInputs();
		session.holdQueuedInput(held.id);
		expect(session.clearQueue()).toEqual({ steering: ["held"], followUp: [] });
		expect(session.releaseQueuedInput(held.id)).toEqual({ outcome: "missing" });
		release();
		await promptPromise;
		expect(getUserTexts(harness)).toEqual(["start"]);
	});

	it("switches a message between after-run and next-turn delivery", async () => {
		const { harness, release, promptPromise } = await createWaitingHarness();
		harnesses.push(harness);
		harness.setResponses(
			waitingResponses(fauxAssistantMessage("1"), fauxAssistantMessage("2"), fauxAssistantMessage("3")),
		);
		const { session } = harness;
		await session.followUp("later");
		await session.followUp("promote me");
		await session.steer("soon");
		const promote = session.getQueuedInputs().find((entry) => entry.text === "promote me");
		if (!promote) throw new Error("queued input missing");
		expect(session.setQueuedInputMode(promote.id, "steer")).toBe(true);
		expect(session.getSteeringMessages()).toEqual(["soon", "promote me"]);
		expect(session.getFollowUpMessages()).toEqual(["later"]);
		expect(session.setQueuedInputMode(promote.id, "steer")).toBe(true);
		expect(session.setQueuedInputMode("missing", "followUp")).toBe(false);
		release();
		await promptPromise;
		expect(getUserTexts(harness)).toEqual(["start", "soon", "promote me", "later"]);
	});
});
