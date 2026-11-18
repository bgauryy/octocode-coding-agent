import { checkedReplies, type Question, type Reply } from "@octocodeai/octocode-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { ask } from "../../src/octocode/ask/ask.ts";
import { checkedQuestions } from "../../src/octocode/ask/check.ts";
import { autoReplies, autoSeconds, Countdown, recommendedIds, withDeadline } from "../../src/octocode/ask/countdown.ts";
import { askUserResult } from "../../src/octocode/ask/decode.ts";
import { showAskDialog } from "../../src/octocode/ask/dialog.ts";
import type { AskQuestion } from "../../src/octocode/ask/dialog/answers.ts";
import { fromAskUser } from "../../src/octocode/ask/question.ts";
import { formatAnswers, registerAskUser } from "../../src/octocode/native/tools/ask-user/tool.ts";
import { fakeCtx, fakeHost, theme } from "./fake-host.ts";

const KEY = { down: "\x1b[B", enter: "\r" };
const tui = { requestRender: () => undefined, terminal: { rows: 40, columns: 100 } };
const scope: AskQuestion = {
	question: "Which scope?",
	options: [
		{ label: "Small (Recommended)", description: "One file, lowest risk" },
		{ label: "Large", description: "Whole repo" },
	],
};
const extras: AskQuestion = {
	question: "Which extras?",
	multiSelect: true,
	options: [
		{ label: "Docs (Recommended)", description: "Users read them" },
		{ label: "Tests (Recommended)", description: "Guard the change" },
		{ label: "Bench", description: "Slow" },
	],
};

type Dialog = {
	render(width: number): string[];
	handleInput(data: string): void;
	handleMouse?(event: object): unknown;
	dispose(): void;
	focused: boolean;
};

/** Opens the terminal dialog in a fake TUI and hands back the dialog and the pending replies. */
function open(questions: Question[], signal?: AbortSignal) {
	const box: { dialog?: Dialog } = {};
	const ctx = fakeCtx({
		cwd: ".",
		ui: {
			custom: (factory) =>
				new Promise((resolve) => {
					box.dialog = factory(tui, theme, new KeybindingsManager(), resolve) as Dialog;
				}),
		},
	});
	const pending = showAskDialog(ctx, questions, signal);
	return { box, pending };
}
const frame = (box: { dialog?: Dialog }) => box.dialog!.render(80).join("\n");
const asked = (questions: AskQuestion[], timeout?: number) => fromAskUser(questions, timeout);

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	const left = vi.getTimerCount();
	vi.useRealTimers();
	// Every exit path releases its timer.
	if (left !== 0) throw new Error(`${left} timers still pending`);
});

describe("askUser countdown in the terminal dialog", () => {
	it("takes the recommended option when the time runs out, and marks the answer automatic", async () => {
		const questions = asked([scope], 20);
		const { box, pending } = open(questions);
		expect(frame(box)).toContain("auto: Small in 20s");
		await vi.advanceTimersByTimeAsync(2000);
		expect(frame(box)).toContain("auto: Small in 18s");
		await vi.advanceTimersByTimeAsync(18_000);
		const replies = await pending;
		expect(replies).toEqual([{ id: "q1", picks: ["1"], auto: true }]);
		const result = askUserResult(questions, replies);
		expect(result.cancelled).toBe(false);
		expect(result.answers[0]).toMatchObject({
			answer: "Small (Recommended)",
			auto: { seconds: 20, reason: "One file, lowest risk" },
		});
	});

	it("shows each option's reason, the recommended one first", async () => {
		const { box, pending } = open(asked([scope], 20));
		const text = frame(box);
		expect(text).toContain("One file, lowest risk");
		expect(text).toContain("Whole repo");
		expect(text.indexOf("Small")).toBeLessThan(text.indexOf("Large"));
		box.dialog!.handleInput("\x1b");
		await pending;
	});

	it("stops at any key: nothing is taken afterwards, and the person's own answer stands", async () => {
		const { box, pending } = open(asked([scope], 20));
		await vi.advanceTimersByTimeAsync(5000);
		box.dialog!.handleInput(KEY.down);
		expect(frame(box)).not.toContain("auto:");
		await vi.advanceTimersByTimeAsync(120_000);
		box.dialog!.handleInput(KEY.enter);
		expect(await pending).toEqual([{ id: "q1", picks: ["2"] }]);
	});

	it("stops at a click or the wheel", async () => {
		const { box, pending } = open(asked([scope], 20));
		box.dialog!.handleMouse!({ type: "wheel", button: "none", wheelDelta: 1, x: 0, y: 0, screenX: 0, screenY: 0 });
		expect(frame(box)).not.toContain("auto:");
		await vi.advanceTimersByTimeAsync(60_000);
		box.dialog!.handleInput("\x1b");
		await pending;
	});

	it("takes every recommended option of a multi question, and each question of a batch", async () => {
		const questions = asked([extras, scope], 10);
		const { pending } = open(questions);
		await vi.advanceTimersByTimeAsync(10_000);
		const replies = await pending;
		expect(replies).toEqual([
			{ id: "q1", picks: ["1", "2"], auto: true },
			{ id: "q2", picks: ["1"], auto: true },
		]);
		expect(askUserResult(questions, replies).answers.map((answer) => answer.answer)).toEqual([
			"Docs (Recommended), Tests (Recommended)",
			"Small (Recommended)",
		]);
	});

	it("never counts down without a timeout", async () => {
		const { box, pending } = open(asked([scope]));
		expect(frame(box)).not.toContain("auto:");
		await vi.advanceTimersByTimeAsync(3_600_000);
		box.dialog!.handleInput(KEY.enter);
		expect(await pending).toEqual([{ id: "q1", picks: ["1"] }]);
	});

	it("releases its timer when the turn is aborted or the dialog is disposed", async () => {
		const controller = new AbortController();
		const { box, pending } = open(asked([scope], 20), controller.signal);
		controller.abort();
		expect(await pending).toEqual([{ id: "q1", cancelled: "aborted" }]);
		box.dialog!.dispose();
	});
});

describe("askUser countdown on other hosts", () => {
	const hang = (_questions: Question[], opts?: { signal?: AbortSignal }) =>
		new Promise<Reply[]>((resolve) =>
			opts?.signal?.addEventListener("abort", () => resolve([{ id: "q1", cancelled: "aborted" }])),
		);

	it("dismisses the host's dialog and takes the recommended option", async () => {
		const questions = asked([scope], 20);
		const ctx = fakeCtx({ cwd: ".", mode: "rpc", ui: { ask: hang } as never });
		const pending = ask(ctx, questions);
		await vi.advanceTimersByTimeAsync(20_000);
		expect(await pending).toEqual([{ id: "q1", picks: ["1"], auto: true }]);
	});

	it("lets an answer given first win and releases the timer", async () => {
		const answered = vi.fn(async (): Promise<Reply[]> => [{ id: "q1", picks: ["2"] }]);
		const ctx = fakeCtx({ cwd: ".", mode: "rpc", ui: { ask: answered } as never });
		expect(await ask(ctx, asked([scope], 20))).toEqual([{ id: "q1", picks: ["2"] }]);
	});

	it("passes the deadline in the question payload", async () => {
		const seen: Question[][] = [];
		const ctx = fakeCtx({
			cwd: ".",
			mode: "rpc",
			ui: { ask: async (questions: Question[]) => (seen.push(questions), [{ id: "q1", picks: ["1"] }]) } as never,
		});
		await ask(ctx, asked([scope], 20));
		expect(seen[0][0].timeoutSeconds).toBe(20);
	});

	it("never times out a permission prompt or a question without a recommendation", async () => {
		const approval: Question = {
			id: "p",
			type: "approval",
			question: "Run it?",
			timeoutSeconds: 5,
			options: [{ id: "allow_once", label: "Allow", role: "allow_once", recommended: true }],
		};
		const plain = fromAskUser(
			[
				{
					question: "Which?",
					options: [
						{ label: "A", description: "a" },
						{ label: "B", description: "b" },
					],
				},
			],
			5,
		);
		for (const questions of [[approval], plain]) {
			expect(autoSeconds(questions)).toBeUndefined();
			const released = withDeadline(questions, undefined, () => Promise.resolve([{ id: "x", picks: [] }]));
			expect(await released).toEqual([{ id: "x", picks: [] }]);
		}
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("Countdown", () => {
	it("ticks each second, expires once, and a stopped countdown never expires", () => {
		const tick = vi.fn();
		const expire = vi.fn();
		const countdown = new Countdown(3, tick, expire);
		vi.advanceTimersByTime(2000);
		expect(tick).toHaveBeenCalledTimes(2);
		expect(countdown.remaining()).toBe(1);
		vi.advanceTimersByTime(1000);
		expect(expire).toHaveBeenCalledTimes(1);
		expect(countdown.running).toBe(false);
		const stopped = new Countdown(3, tick, expire);
		expect(stopped.stop()).toBe(true);
		expect(stopped.stop()).toBe(false);
		vi.advanceTimersByTime(10_000);
		expect(expire).toHaveBeenCalledTimes(1);
	});

	it("picks the first recommended option of a choice and all of a multi", () => {
		const [choice, multi] = asked([scope, extras], 5);
		expect(recommendedIds(choice)).toEqual(["1"]);
		expect(recommendedIds(multi)).toEqual(["1", "2"]);
		expect(autoReplies([choice]).every((reply) => "auto" in reply)).toBe(true);
	});
});

describe("askUser tool timeout", () => {
	const fake = fakeHost();
	registerAskUser(fake.api);
	const tool = fake.tools.get("askUser");
	const run = (questions: unknown[], timeout?: number, ui: object = {}) =>
		tool.execute(
			"c",
			{ questions, ...(timeout !== undefined ? { timeout } : {}) },
			undefined,
			undefined,
			fakeCtx({ cwd: ".", mode: "rpc", ui }),
		);

	it("refuses a timeout on a free-text question or a choice without a recommended option", async () => {
		await expect(run([{ question: "Name?", type: "text" }], 20)).rejects.toThrow(/recommended option/);
		await expect(
			run(
				[
					{
						question: "Which?",
						options: [
							{ label: "A", description: "a" },
							{ label: "B", description: "b" },
						],
					},
				],
				20,
			),
		).rejects.toThrow(/\(Recommended\)/);
	});

	it("refuses a timeout outside 1 to 3600 seconds", async () => {
		const question = {
			question: "Which?",
			options: [
				{ label: "A (Recommended)", description: "a" },
				{ label: "B", description: "b" },
			],
		};
		await expect(run([question], 0.5)).rejects.toThrow(/whole number of seconds/);
		await expect(run([question], 99_999)).rejects.toThrow(/from 1 to 3600/);
	});

	it("refuses an option without a reason", async () => {
		await expect(
			run([
				{
					question: "Which?",
					options: [
						{ label: "A", description: "a" },
						{ label: "B", description: "  " },
					],
				},
			]),
		).rejects.toThrow(/no reason/);
	});

	it("sends the recommended option first with the deadline, and reports a timed-out answer as no approval", async () => {
		const seen: Question[][] = [];
		const ui = {
			ask: async (questions: Question[]) => (
				seen.push(questions),
				[{ id: "q1", picks: [questions[0].options![0].id], auto: true }]
			),
		};
		const result = await run(
			[
				{
					question: "Continue to the next item?",
					options: [
						{ label: "Stop", description: "Pause here" },
						{ label: "Continue (Recommended)", description: "Next item is routine" },
					],
				},
			],
			20,
			ui,
		);
		expect(seen[0][0].options?.[0]).toMatchObject({ label: "Continue (Recommended)", recommended: true });
		expect(seen[0][0].timeoutSeconds).toBe(20);
		const text = result.content[0].text as string;
		expect(text).toContain("(auto: no answer in 20s)");
		expect(text).toContain("Next item is routine");
		expect(text).toMatch(/not the user's approval/);
		expect(formatAnswers({ answers: [{ question: "q", answer: "a", custom: false }], cancelled: false })).not.toMatch(
			/approval/,
		);
	});
});

describe("questions and replies from another process", () => {
	it("keeps a choice's deadline and an automatic reply, and never a forged approval's deadline", () => {
		const [choice] = asked([scope], 20);
		const forged = { ...choice, id: "p", type: "approval", timeoutSeconds: 20 };
		const checked = checkedQuestions([choice, forged]);
		expect(checked?.[0].timeoutSeconds).toBe(20);
		expect(checked?.[1].type).toBe("choice");
		expect(checked?.[1].timeoutSeconds).toBeUndefined();
		expect(checkedQuestions([{ ...choice, timeoutSeconds: 99_999 }])?.[0].timeoutSeconds).toBe(3600);
		expect(checkedReplies([choice], [{ id: "q1", picks: ["1"], auto: true }])).toEqual([
			{ id: "q1", picks: ["1"], auto: true },
		]);
	});
});
