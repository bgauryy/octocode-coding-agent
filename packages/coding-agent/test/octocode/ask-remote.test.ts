import { describe, expect, it } from "vitest";
import type { SessionUI } from "../../src/core/features/types.ts";
import { UIPromptTracker } from "../../src/core/features/runner/ui-prompt.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { showAskDialog } from "./ask-dialog-helper.ts";
import type { AskQuestion } from "../../src/octocode/ask/dialog/answers.ts";
import { awaitingFor } from "../../src/octocode/ui/awaiting.ts";
import { fakeCtx, theme } from "./fake-host.ts";

const tui = { requestRender: () => undefined, terminal: { rows: 40, columns: 100 } };
type Dialog = { handleInput(data: string): void; dispose(): void; focused: boolean };

/** A terminal that shows the real card through the broker; `closed` records the card being closed by `done`. */
function setup() {
	const events: Array<Record<string, unknown>> = [];
	const tracker = new UIPromptTracker(async (event) => void events.push(event as unknown as Record<string, unknown>));
	let dialog: Dialog | undefined;
	const state = { disposed: false };
	const ui = {
		custom: (factory: (...args: unknown[]) => Dialog) =>
			new Promise((resolve) => {
				dialog = factory(tui, theme, new KeybindingsManager(), (result: unknown) => {
					state.disposed = true;
					resolve(result);
				});
				dialog.focused = true;
			}),
	} as unknown as SessionUI;
	const base = fakeCtx({ cwd: process.cwd() });
	const ctx = { ...base, ui: tracker.wrap({ ...base.ui, ...ui }) } as typeof base;
	const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
	return { tracker, events, ctx, flush, key: (data: string) => dialog?.handleInput(data), state };
}

const scope: AskQuestion = {
	question: "Which scope?",
	options: [{ label: "Small (Recommended)", description: "One file" }, { label: "Large" }],
};

describe("askUser answered from the web or an RPC client", () => {
	it("reports the question with its card, and a remote choice closes the terminal card and answers", async () => {
		const { tracker, events, ctx, flush, state } = setup();
		const result = showAskDialog(ctx, [scope]);
		await flush();
		const start = events.find((event) => event.type === "ui_prompt_start")!;
		expect(start).toMatchObject({ kind: "custom", title: "Which scope?", options: ["Small (Recommended)", "Large"] });
		expect(awaitingFor(start as never)).toMatchObject({
			id: start.id,
			optionInfo: [{ description: "One file", recommended: true }, {}],
			allowsText: true,
		});
		expect(tracker.answer(start.id as string, { choice: "Medium" })).toMatchObject({ ok: false });
		expect(tracker.answer(start.id as string, { choice: "Large" })).toEqual({ ok: true });
		expect(await result).toEqual({
			answers: [{ question: "Which scope?", answer: "Large", custom: false }],
			cancelled: false,
		});
		expect(state.disposed).toBe(true);
		// First answer wins: a second remote answer finds no dialog.
		expect(tracker.answer(start.id as string, { choice: "Large" })).toMatchObject({ ok: false });
	});

	it("takes typed text remotely as a write-in, refuses blank text, and lets the terminal win a race", async () => {
		const { tracker, events, ctx, flush, key } = setup();
		const typed = showAskDialog(ctx, [scope]);
		await flush();
		const id = events.find((event) => event.type === "ui_prompt_start")!.id as string;
		expect(tracker.answer(id, { text: "  " })).toMatchObject({ ok: false });
		expect(tracker.answer(id, { text: "Medium" })).toEqual({ ok: true });
		expect((await typed).answers[0]).toMatchObject({ answer: "Medium", custom: true });

		const raced = showAskDialog(ctx, [scope]);
		await flush();
		const second = events.filter((event) => event.type === "ui_prompt_start").at(-1)!.id as string;
		key("2");
		key("\r");
		expect((await raced).answers[0]).toMatchObject({ answer: "Large" });
		expect(tracker.answer(second, { choice: "Small (Recommended)" })).toMatchObject({ ok: false });
	});

	it("answers a batch by one reply per question and refuses replies that do not fit", async () => {
		const { tracker, events, ctx, flush, state } = setup();
		const batch = showAskDialog(ctx, [scope, { ...scope, question: "Again?", multiSelect: true }]);
		await flush();
		const start = events.find((event) => event.type === "ui_prompt_start")!;
		expect(start.options).toBeUndefined();
		expect(awaitingFor(start as never)).toMatchObject({ id: start.id, questions: [{ id: "q1" }, { id: "q2" }] });
		const id = start.id as string;
		// One reply for two questions, an unknown option and a second pick on a single choice are no answers.
		expect(tracker.answer(id, { replies: [{ id: "q1", picks: ["1"] }] })).toMatchObject({ ok: false });
		expect(
			tracker.answer(id, {
				replies: [
					{ id: "q1", picks: ["9"] },
					{ id: "q2", picks: ["1"] },
				],
			}),
		).toMatchObject({
			ok: false,
		});
		expect(
			tracker.answer(id, {
				replies: [
					{ id: "q1", picks: ["1", "2"] },
					{ id: "q2", picks: ["1"] },
				],
			}),
		).toMatchObject({ ok: false });
		expect(
			tracker.answer(id, {
				replies: [
					{ id: "q1", picks: ["2"] },
					{ id: "q2", picks: ["1", "2"] },
				],
			}),
		).toEqual({ ok: true });
		const result = await batch;
		expect(result.answers.map((entry) => entry.answer)).toEqual(["Large", "Small (Recommended), Large"]);
		expect(state.disposed).toBe(true);
	});
});
