import { describe, expect, it } from "vitest";
import { Thought, thoughtGist } from "../../src/octocode/render/thought.ts";
import { Activity, callTarget } from "../../src/octocode/ui/activity-model.ts";

/** A window title, a hyperlink, a screen clear and a bidi override: none may reach a reader's terminal. */
const HOSTILE = "\u001b]0;pwned\u0007\u001b]8;;https://x.test\u0007\u001b[2J\u202e";
const CONTROL = /\u001b|\u0007|\u202e/;

describe("activity text from the model is clean where it is produced", () => {
	it("removes terminal controls from a thinking gist, streamed or complete", () => {
		expect(thoughtGist(`Plan ${HOSTILE}the fix. Next step.`, true)).toBe("Next step.");
		expect(thoughtGist(`Read ${HOSTILE}the file.`, true)).toBe("Read the file.");
		const thought = new Thought();
		thought.add(`Check ${HOSTILE}the tests. `);
		thought.add("More");
		expect(thought.gist).toBe("Check the tests.");
	});

	it("removes terminal controls from a call's target and a dialog title", () => {
		expect(callTarget("agent", { goal: `fix ${HOSTILE}login` }).hint).toBe("fix login");
		expect(callTarget("mcp__octocode__localSearch", { queries: [{ path: `src${HOSTILE}/a.ts` }] }).hint).toBe(
			"src/a.ts",
		);
		const activity = new Activity();
		activity.start(0);
		activity.promptStart(`Allow ${HOSTILE}this?`, 0);
		expect(activity.working()).toBe("Waiting for you: Allow this?");
	});

	it("removes terminal controls from a tool name the model made up", () => {
		const activity = new Activity();
		activity.start(0);
		activity.toolStart("1", `rm${HOSTILE}`, {}, 0);
		for (const line of [activity.working(), activity.describe()]) {
			expect(line).toMatch(/Running rm$/i);
			expect(line).not.toMatch(CONTROL);
		}
	});
});
