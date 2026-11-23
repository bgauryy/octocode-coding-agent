import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import type { ApplicationCursor, ApplicationFrame, ApplicationSnapshot } from "@octocodeai/octocode-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getApplicationPort } from "../../src/core/application/index.ts";
import { ApplicationService } from "../../src/core/application/service.ts";
import { SessionFacts } from "../../src/core/application/service/facts.ts";
import { followSessionActivity } from "../../src/octocode/activity/session-activity.ts";
import { createHarness, type Harness } from "./harness.ts";

/*
 * The model, spend, quota and model list a root session's port publishes (`service/facts.ts`) are checked only while
 * something follows them (an event or state listener, a connected view); a view that arrives later first gets one full
 * check. Each observer must see what it saw when every session event was checked: two ports on one session, one
 * followed from the start (every event checked) and one followed by nothing, must show the same facts.
 */

const harnesses: Harness[] = [];
const services: ApplicationService[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const service of services.splice(0)) service.dispose();
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

async function harnessed(): Promise<Harness> {
	const harness = await createHarness({ models: [{ id: "windowed", contextWindow: 100_000 }] });
	harnesses.push(harness);
	return harness;
}

/** Two ports on `harness`'s session: `eager` has a listener from the start, `deferred` has none. */
function ports(harness: Harness): { eager: ApplicationService; deferred: ApplicationService } {
	const eager = new ApplicationService(harness.session);
	const deferred = new ApplicationService(harness.session);
	services.push(eager, deferred);
	eager.start();
	deferred.start();
	eager.subscribe(() => {});
	return { eager, deferred };
}

/** Two answered prompts. */
async function run(harness: Harness): Promise<void> {
	harness.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
	await harness.session.prompt("hello");
	await harness.session.prompt("again");
}

const facts = (snapshot: Pick<ApplicationSnapshot, "model" | "usage" | "quota" | "models">) => ({
	model: snapshot.model,
	usage: snapshot.usage,
	quota: snapshot.quota ?? [],
	models: snapshot.models,
});

/** The frames `connection` has queued, read until none arrives within 50 ms. */
async function drain(connection: AsyncIterable<ApplicationFrame>): Promise<ApplicationFrame[]> {
	const iterator = connection[Symbol.asyncIterator]();
	const frames: ApplicationFrame[] = [];
	for (;;) {
		const next = await Promise.race([iterator.next(), new Promise<undefined>((done) => setTimeout(done, 50))]);
		if (!next || next.done) return frames;
		frames.push(next.value);
	}
}

describe("a root session's facts while nothing follows them", () => {
	it("are not checked during a run nobody follows", async () => {
		const harness = await harnessed();
		getApplicationPort(harness.session);
		const sync = vi.spyOn(SessionFacts.prototype, "sync");
		await run(harness);
		expect(sync).not.toHaveBeenCalled();
	});

	it("are what an eagerly checked port shows, in a snapshot taken after the run", async () => {
		const harness = await harnessed();
		const { eager, deferred } = ports(harness);
		await run(harness);
		const shown = facts(deferred.getSnapshot());
		// The faux provider reports tokens without a price: both replies count as unpriced, and the context is measured.
		expect(shown.usage).toMatchObject({ unpriced: 2, contextWindow: 100_000 });
		expect(shown.model).toMatchObject({ id: "windowed" });
		expect(shown).toEqual(facts(eager.getSnapshot()));
	});

	it("reach a view that connects after the run in its first snapshot frame", async () => {
		const harness = await harnessed();
		const { eager, deferred } = ports(harness);
		await run(harness);
		const connection = deferred.connect();
		const [frame] = await drain(connection);
		connection.close();
		expect(frame.type).toBe("snapshot");
		const snapshot = (frame as Extract<ApplicationFrame, { type: "snapshot" }>).snapshot;
		expect(facts(snapshot)).toEqual(facts(eager.getSnapshot()));
	});

	it("reach a view that reconnects from its cursor: the replay ends with the spend the eager port shows", async () => {
		const harness = await harnessed();
		const { eager, deferred } = ports(harness);
		const first = deferred.connect();
		const [opened] = await drain(first);
		const cursor: ApplicationCursor = opened.cursor;
		first.close();
		await run(harness);
		const again = deferred.connect({ cursor });
		const frames = await drain(again);
		again.close();
		// The resume frame, then every frame since the cursor; the facts come last, from the check on reconnecting.
		expect(frames[0]?.type).toBe("resumed");
		const usage = frames.flatMap((frame) =>
			frame.type === "event" && frame.event.type === "session.usage" ? [frame.event.usage] : [],
		);
		expect(usage.at(-1)).toEqual(eager.getSnapshot().usage);
	});

	it("leave the activity light as it is when every event is checked", async () => {
		const light = async (follow: boolean) => {
			const harness = await harnessed();
			const port = getApplicationPort(harness.session);
			if (follow) port.subscribe(() => {});
			const tones: string[] = [];
			const stop = followSessionActivity(harness.session.sessionId, ({ tone, label }) =>
				tones.push(`${tone}:${label}`),
			);
			await run(harness);
			stop();
			return tones;
		};
		const eager = await light(true);
		const deferred = await light(false);
		expect(deferred.length).toBeGreaterThan(1);
		expect(deferred).toEqual(eager);
	});

	it("are checked at every event again once a listener follows them", async () => {
		const harness = await harnessed();
		const { deferred } = ports(harness);
		await run(harness);
		const heard: string[] = [];
		deferred.subscribe((event) => heard.push(event.type));
		harness.setResponses([fauxAssistantMessage("third answer")]);
		await harness.session.prompt("once more");
		expect(heard).toContain("session.usage");
	});
});
