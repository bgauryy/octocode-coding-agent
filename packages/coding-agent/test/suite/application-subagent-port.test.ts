import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { getApplicationPort } from "../../src/core/application/index.ts";
import { ApplicationTranscript } from "../../src/core/application/transcript.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

/**
 * One answered prompt; `checks` counts the session messages the port projected while it ran (a root port's facts are
 * checked only for a follower, `application-facts-deferred`, so its transcript is what shows it follows the session).
 */
async function answered() {
	const harness = await createHarness();
	harnesses.push(harness);
	const projected = vi.spyOn(ApplicationTranscript.prototype, "message");
	harness.setResponses([fauxAssistantMessage("first answer")]);
	await harness.session.prompt("hello");
	const checks = projected.mock.calls.length;
	projected.mockRestore();
	return { harness, checks };
}

const shown = (harness: Harness) => {
	const snapshot = getApplicationPort(harness.session).getSnapshot();
	return {
		messages: snapshot.messages.map(({ role, text, complete }) => ({ role, text, complete })),
		model: snapshot.model?.id,
		usage: snapshot.usage,
		streaming: snapshot.streaming,
	};
};

describe("a subagent's application port", () => {
	it("projects nothing while nothing observes it, then shows what a root session's port shows", async () => {
		const root = await answered();
		// A subagent's session has no attach endpoint: no view follows it unless one asks.
		vi.stubEnv(SUBAGENT_ENV, "1");
		const child = await answered();
		expect(root.checks).toBeGreaterThan(0);
		expect(child.checks).toBe(0);
		const attached = shown(child.harness);
		expect(attached.messages.map((message) => message.text)).toContain("first answer");
		expect(attached).toEqual(shown(root.harness));
		// From now on it follows the session live.
		const events: string[] = [];
		getApplicationPort(child.harness.session).subscribe((event) => events.push(event.type));
		child.harness.setResponses([fauxAssistantMessage("second answer")]);
		await child.harness.session.prompt("again");
		expect(events).toContain("run.settled");
		expect(
			shown(child.harness)
				.messages.map((message) => message.text)
				.slice(-2),
		).toEqual(["again", "second answer"]);
	});
});
