import { describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { getApplicationPort } from "../../src/core/application/index.ts";
import { UIPromptTracker } from "../../src/core/features/runner/ui-prompt.ts";
import type { DialogOptions, SessionUI } from "../../src/core/features/types.ts";
import { inputOrigin, withInputOrigin } from "../../src/core/input-origin.ts";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A terminal whose dialogs stay open until the test answers; `shown` counts what the terminal drew. */
function terminal() {
	const shown: string[] = [];
	const ui = {
		confirm: (title: string, _message: string, opts?: DialogOptions) => {
			shown.push(title);
			return new Promise<boolean>((resolve) => {
				opts?.signal?.addEventListener("abort", () => resolve(false), { once: true });
			});
		},
	} as unknown as SessionUI;
	return { ui, shown };
}

function tracked() {
	const events: Array<Record<string, unknown>> = [];
	const tracker = new UIPromptTracker(async (event) => {
		events.push(event as unknown as Record<string, unknown>);
	});
	return { tracker, events };
}

describe("a confirmation a web prompt triggers goes to the web dialog", () => {
	it("is not drawn in the terminal, and the web client's answer settles it", async () => {
		const { ui, shown } = terminal();
		const { tracker, events } = tracked();
		const wrapped = tracker.wrap(ui);
		const answer = withInputOrigin("web", () => wrapped.confirm("Change theme?", "details"));
		await flush();
		expect(shown).toEqual([]);
		expect(events[0]).toMatchObject({ type: "ui_prompt_start", kind: "confirm", options: ["Yes", "No"] });
		expect(tracker.answer(events[0].id as string, { choice: "Yes" })).toEqual({ ok: true });
		expect(await answer).toBe(true);
	});

	it("is refused by a No, and an abort closes it as declined", async () => {
		const { ui } = terminal();
		const { tracker, events } = tracked();
		const wrapped = tracker.wrap(ui);
		const no = withInputOrigin("web", () => wrapped.confirm("Change theme?", ""));
		await flush();
		tracker.answer(events[0].id as string, { choice: "No" });
		expect(await no).toBe(false);
		const controller = new AbortController();
		const aborted = withInputOrigin("web", () => wrapped.confirm("Again?", "", { signal: controller.signal }));
		await flush();
		controller.abort();
		expect(await aborted).toBe(false);
	});

	it("stays a terminal dialog, answerable by both, when the terminal started the run", async () => {
		const { ui, shown } = terminal();
		const { tracker, events } = tracked();
		const wrapped = tracker.wrap(ui);
		const answer = wrapped.confirm("Change theme?", "");
		await flush();
		expect(shown).toEqual(["Change theme?"]);
		tracker.answer(events[0].id as string, { choice: "Yes" });
		expect(await answer).toBe(true);
	});
});

describe("web daemon sessions", () => {
	it.each(["prompt", "steer", "followUp"] as const)("run a %s command under the web origin", async (action) => {
		const seen: string[] = [];
		const record = async () => void seen.push(inputOrigin());
		const session = {
			sessionId: `daemon-${action}`,
			messages: [],
			isStreaming: false,
			getSteeringMessages: () => [],
			getFollowUpMessages: () => [],
			subscribe: () => () => {},
			prompt: record,
			steer: record,
			followUp: record,
			abort: record,
		} as unknown as AgentSession;
		const service = getApplicationPort(session);
		await service.execute({ id: "c1", sessionId: session.sessionId, action, text: "hi" });
		await flush();
		expect(seen).toEqual(["web"]);
		service.dispose();
	});
});
