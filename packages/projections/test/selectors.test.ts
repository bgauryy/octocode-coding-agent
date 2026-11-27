import type { ApplicationMessage, ApplicationSnapshot } from "@octocodeai/octocode-contracts";
import { describe, expect, it } from "vitest";
import { ApplicationProjection, applicationMessageDisplayed, toolDisplayState, toolState } from "../src/index.ts";

const message = (id: string, over: Partial<ApplicationMessage>): ApplicationMessage => ({
	id,
	role: "assistant",
	complete: true,
	text: id,
	...over,
});

/** Shared fixture: the terminal ingress test feeds the same shapes. */
const messages = [
	message("shown-user", { role: "user" }),
	message("shown-assistant", {}),
	message("hidden-assistant", { display: false }),
	message("context-custom", { role: "custom" }),
	message("hidden-custom", { role: "custom", display: false }),
	message("shown-custom", { role: "custom", display: true }),
];

describe("message visibility", () => {
	it("hides display:false and custom messages the host did not mark shown", () => {
		expect(messages.filter(applicationMessageDisplayed).map((each) => each.id)).toEqual([
			"shown-user",
			"shown-assistant",
			"shown-custom",
		]);
	});

	it('shows a session entry\'s "only" display', () => {
		expect(applicationMessageDisplayed({ role: "custom", display: "only" })).toBe(true);
		expect(applicationMessageDisplayed({ role: "custom", display: false })).toBe(false);
		expect(applicationMessageDisplayed({ role: "custom" })).toBe(false);
	});

	it("is what the feed projection shows", () => {
		const snapshot = { messages, tools: [] } as unknown as ApplicationSnapshot;
		const shown = new ApplicationProjection().update(snapshot, 0).map((event) => event.message?.id);
		for (const each of messages) expect(shown.includes(each.id)).toBe(applicationMessageDisplayed(each));
	});
});

describe("tool state", () => {
	it("maps each tool outcome to one shared state", () => {
		expect(toolState(undefined)).toBe("pending");
		expect(toolState({ status: "failed", notRun: true })).toBe("stopped");
		expect(
			toolState({ status: "failed", display: { title: "t", blocks: [], outcome: { stopped: true } } } as never),
		).toBe("stopped");
		expect(toolState({ status: "completed", display: { title: "t", blocks: [], state: "waiting" } } as never)).toBe(
			"waiting",
		);
		expect(toolState({ status: "running" })).toBe("running");
		expect(toolState({ status: "failed" })).toBe("failed");
		expect(toolState({ status: "completed" })).toBe("done");
	});
});

describe("tool display state", () => {
	it("forces a state only when the host's display says so", () => {
		expect(toolDisplayState({ status: "failed" })).toBeUndefined();
		expect(toolDisplayState({ status: "completed", display: { title: "t", blocks: [] } })).toBeUndefined();
		expect(toolDisplayState({ status: "running", display: { title: "t", blocks: [], state: "waiting" } })).toBe(
			"waiting",
		);
		expect(
			toolDisplayState({ status: "failed", display: { title: "t", blocks: [], outcome: { text: "", stopped: true } } }),
		).toBe("stopped");
		expect(
			toolDisplayState({
				status: "completed",
				display: { title: "t", blocks: [], outcome: { text: "", stopped: true } },
			}),
		).toBeUndefined();
	});
});
