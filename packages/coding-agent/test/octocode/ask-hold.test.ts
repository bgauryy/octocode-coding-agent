import type { ApplicationCommand, Question, Reply } from "@octocodeai/octocode-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeCommand } from "../../src/core/application/service/commands.ts";
import type { SessionUI } from "../../src/core/features/types.ts";
import { UIPromptTracker } from "../../src/core/features/runner/ui-prompt.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { ask } from "../../src/octocode/ask/ask.ts";
import type { AskQuestion } from "../../src/octocode/ask/dialog/answers.ts";
import { fromAskUser } from "../../src/octocode/ask/question.ts";
import { fakeCtx, theme } from "./fake-host.ts";

/**
 * A timed askUser card answered from the web: the `hold` command stops the host's countdown, so the person's answer
 * stands however long they take. The commands go through `invokeCommand`, as the application service dispatches them.
 */
const tui = { requestRender: () => undefined, terminal: { rows: 40, columns: 100 } };
const scope: AskQuestion = {
	question: "Which scope?",
	options: [
		{ label: "Small (Recommended)", description: "One file" },
		{ label: "Large", description: "Whole repo" },
	],
};
const SECONDS = 20;

type Mode = "tui" | "rpc";

/** A session whose dialogs are the real broker's; the mode draws the card itself (`tui`) or hands it to a host (`rpc`). */
function setup(mode: Mode) {
	const events: Array<Record<string, unknown>> = [];
	const tracker = new UIPromptTracker(async (event) => void events.push(event as unknown as Record<string, unknown>));
	const base =
		mode === "tui"
			? {
					custom: (factory: (...args: unknown[]) => unknown) =>
						new Promise((resolve) => void factory(tui, theme, new KeybindingsManager(), resolve)),
				}
			: {
					ask: (_questions: Question[], opts?: { signal?: AbortSignal }) =>
						new Promise<Reply[]>((resolve) =>
							opts?.signal?.addEventListener("abort", () => resolve([{ id: "q1", cancelled: "aborted" }])),
						),
				};
	// `fakeCtx` replaces `custom` and drops its options: wrap the fake's own UI with the mode's dialogs on top.
	const fake = fakeCtx({ cwd: ".", mode });
	const ctx = { ...fake, ui: tracker.wrap({ ...fake.ui, ...base } as unknown as SessionUI) } as unknown as typeof fake;
	const unused = () => {
		throw new Error("not a dialog command");
	};
	const session = {
		abort: unused,
		clearQueue: unused,
		prompt: unused,
		steer: unused,
		followUp: unused,
		answerDialog: (id: string, answer: Parameters<UIPromptTracker["answer"]>[1]) => tracker.answer(id, answer),
		holdDialog: (id: string) => tracker.hold(id),
	};
	const send = (command: Omit<Extract<ApplicationCommand, { action: "hold" | "answer" }>, "id" | "sessionId">) =>
		invokeCommand({ id: "c", sessionId: "s", ...command }, undefined, session);
	const dialogId = (): string => {
		const start = events.find((event) => event.type === "ui_prompt_start");
		return start!.id as string;
	};
	return { ctx, send, dialogId };
}

/** The person's pick of option `id` in the shape this host takes: the card's choice, or a host's reply. */
const choose = (mode: Mode, id: string, label: string) =>
	mode === "tui" ? { choice: label } : { replies: [{ id: "q1", picks: [id] }] };

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	const left = vi.getTimerCount();
	vi.useRealTimers();
	// Every exit path releases its timer.
	if (left !== 0) throw new Error(`${left} timers still pending`);
});

describe.each<Mode>(["tui", "rpc"])("hold command, %s host", (mode) => {
	it("keeps the host waiting past the timeout, and the person's own answer stands", async () => {
		const { ctx, send, dialogId } = setup(mode);
		const settled = vi.fn();
		const pending = ask(ctx, fromAskUser([scope], SECONDS)).then(settled);
		await flush();
		await vi.advanceTimersByTimeAsync(5000);
		send({ action: "hold", dialogId: dialogId() });
		await vi.advanceTimersByTimeAsync(SECONDS * 1000 * 100);
		expect(settled).not.toHaveBeenCalled();
		// The first answer given after the hold is the person's, not the recommended option.
		send({ action: "answer", dialogId: dialogId(), ...choose(mode, "2", "Large") });
		await pending;
		expect(settled).toHaveBeenCalledWith([{ id: "q1", picks: ["2"] }]);
	});

	it("takes the recommended option when no hold arrives", async () => {
		const { ctx } = setup(mode);
		const pending = ask(ctx, fromAskUser([scope], SECONDS));
		await vi.advanceTimersByTimeAsync(SECONDS * 1000);
		expect(await pending).toEqual([{ id: "q1", picks: ["1"], auto: true }]);
	});

	it("is idempotent, and refuses a dialog that is no longer open", async () => {
		const { ctx, send, dialogId } = setup(mode);
		const pending = ask(ctx, fromAskUser([scope], SECONDS));
		await flush();
		const id = dialogId();
		send({ action: "hold", dialogId: id });
		expect(() => send({ action: "hold", dialogId: id })).not.toThrow();
		send({ action: "answer", dialogId: id, ...choose(mode, "2", "Large") });
		await pending;
		expect(() => send({ action: "hold", dialogId: id })).toThrow(/No such dialog/);
	});

	it("has nothing to stop on a dialog without a timeout", async () => {
		const { ctx, send, dialogId } = setup(mode);
		const pending = ask(ctx, fromAskUser([scope]));
		await flush();
		expect(() => send({ action: "hold", dialogId: dialogId() })).not.toThrow();
		send({ action: "answer", dialogId: dialogId(), ...choose(mode, "1", "Small (Recommended)") });
		await pending;
	});
});
