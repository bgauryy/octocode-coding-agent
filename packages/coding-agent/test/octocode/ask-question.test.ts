import type { ExtensionUIDialogOptions } from "../../src/core/features/types.ts";
import type { OptionRole, Question, Reply } from "@octocodeai/octocode-contracts";
import { describe, expect, it, vi } from "vitest";
import { ask } from "../../src/octocode/ask/ask.ts";
import { confirmed, askUserResult, inputText, permissionAnswer, selectedLabel } from "../../src/octocode/ask/decode.ts";
import { degrade } from "../../src/octocode/ask/degrade.ts";
import type { AskQuestion } from "../../src/octocode/ask/dialog/answers.ts";
import { questionView } from "../../src/octocode/ask/dialog/view.ts";
import { approvalQuestion, choice, confirm, fromAskUser, text, viewOf } from "../../src/octocode/ask/question.ts";
import {
	ALLOW_ONCE,
	DENY,
	DENY_NOTE,
	kindOption,
	NOTE_TITLE,
	selectAnswer,
	sessionOption,
} from "../../src/octocode/permission/ask/text.ts";
import type { PermissionMode } from "../../src/octocode/permission/mode.ts";
import { permissionView } from "../../src/octocode/permission/ask/view.ts";
import type { PermissionRequest } from "../../src/octocode/permission/request.ts";
import { fakeCtx } from "./fake-host.ts";

const scope: AskQuestion = {
	question: "Which scope?",
	header: "Scope",
	options: [{ label: "Small (Recommended)", description: "One file" }, { label: "Large" }],
};
const extras: AskQuestion = {
	question: "Which extras?",
	multiSelect: true,
	options: [{ label: "Docs" }, { label: "Tests" }, { label: "Bench" }],
};
const forwarded: AskQuestion = {
	question: "jolly asks (message #7):\nA\nB\n\nWhich scope?",
	forwarded: { label: "jolly asks (message #7):", text: "A\nB", ask: "Which scope?" },
	options: [{ label: "Small" }, { label: "Large" }],
};
const free: AskQuestion = { question: "Which region?", options: [] };

type Labels = Parameters<typeof permissionView>[3];

/** The approval question for `request`, built from the card the permission prompt draws, as the asker will. */
function approvalFor(id: string, request: PermissionRequest, labels: Labels, mode: PermissionMode = "workspace") {
	const roles: Record<string, OptionRole> = {
		[labels.allowOnce]: "allow_once",
		[labels.deny]: "deny",
		[labels.note]: "deny_note",
		...(labels.session ? { [labels.session]: "allow_session" as const } : {}),
		...(labels.kind ? { [labels.kind]: "allow_kind" as const } : {}),
	};
	const choices = [
		labels.allowOnce,
		...(labels.session ? [labels.session] : []),
		...(labels.kind ? [labels.kind] : []),
		labels.deny,
		labels.note,
	];
	return approvalQuestion({
		id,
		view: permissionView(request, mode, choices, labels),
		roles,
		approval: {
			...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
			...(request.action ? { action: request.action } : {}),
			targets: [...request.what],
		},
	});
}

const picks = (id: string, ...ids: string[]): Reply => ({ id, picks: ids });
const said = (id: string, value: string, ...ids: string[]): Reply => ({ id, picks: ids, text: value });

describe("fromAskUser", () => {
	it("types a question by its options and multiSelect, and marks the recommendation", () => {
		const [a, b, c] = fromAskUser([scope, extras, free]);
		expect(a).toMatchObject({
			id: "q1",
			type: "choice",
			header: "Scope",
			writeIn: { label: "Write an answer", title: "Which scope?" },
		});
		expect(a.options).toEqual([
			{ id: "1", label: "Small (Recommended)", description: "One file", recommended: true },
			{ id: "2", label: "Large" },
		]);
		expect(b).toMatchObject({ id: "q2", type: "multi" });
		expect(c).toEqual({ id: "q3", type: "text", question: "Which region?" });
	});
});

describe("viewOf parity", () => {
	it.each([
		["choice", scope],
		["multi", extras],
		["forwarded", forwarded],
	])("draws the card viewOf gives for a %s question", (_name, q) => {
		const question = fromAskUser([q])[0];
		expect(questionView(question)).toEqual(viewOf(question));
	});

	it("keeps a free-text question's write-in row in the dialog", () => {
		const view = questionView(fromAskUser([free])[0]);
		expect(view.options).toEqual([{ label: "Write an answer" }]);
		expect(view.writeIn).toEqual({ label: "Write an answer", title: "Which region?" });
	});

	it("gives the view the permission prompt draws, and its options in the order the select offers them", async () => {
		const request: PermissionRequest = {
			action: "shell",
			reasons: ["provenance"],
			title: "Run this shell command?",
			what: ["npm test", "cd /tmp\nls"],
			effect: "runs a command as you",
			undo: "none",
			risk: "deletes files",
			reason: "contains text from agent misty-prawn (3m ago)",
			purpose: "Run the tests",
			grant: { key: "npm test", label: "`npm test`" },
			toolCallId: "call-1",
		};
		let seen: { options: string[]; ask?: unknown } | undefined;
		const ctx = {
			hasUI: true,
			ui: {
				ask: (questions: Question[], opts?: object) =>
					degrade(
						{
							...fakeCtx({ cwd: "." }).ui,
							approve: async (question) => {
								seen = { options: (question.options ?? []).map((option) => option.label), ask: viewOf(question) };
								return { label: DENY };
							},
						},
						questions,
						opts,
					),
			},
		} as unknown as Parameters<typeof selectAnswer>[0];
		await selectAnswer(ctx, { ...request, reasons: [] }, "workspace", false, "");
		const session = sessionOption(request.grant?.label ?? "");
		const kind = kindOption("shell");
		const q = approvalFor(
			"a1",
			{ ...request, reasons: [] },
			{
				allowOnce: ALLOW_ONCE,
				session,
				...(kind ? { kind } : {}),
				deny: DENY,
				note: DENY_NOTE,
				noteTitle: NOTE_TITLE,
			},
		);
		expect(viewOf(q)).toEqual(seen?.ask);
		expect(q.options?.map((option) => option.label)).toEqual(seen?.options);
		expect(q.options?.map((option) => option.role)).toEqual([
			"allow_once",
			"allow_session",
			"allow_kind",
			"deny",
			"deny_note",
		]);
		expect(q.approval).toEqual({ toolCallId: "call-1", action: "shell", targets: ["npm test", "cd /tmp\nls"] });
		expect(q.type).toBe("approval");
	});
});

describe("decode", () => {
	it("reads askUser answers as today's result does", () => {
		const questions = fromAskUser([scope, extras, free]);
		const result = askUserResult(questions, [picks("q1", "2"), picks("q2", "3", "1"), said("q3", "  eu-west-1 ")]);
		expect(result).toEqual({
			cancelled: false,
			answers: [
				{ question: "Which scope?", answer: "Large", custom: false },
				{ question: "Which extras?", answer: "Docs, Bench", custom: false },
				{ question: "Which region?", answer: "eu-west-1", custom: true },
			],
		});
	});

	it("keeps a multi write-in apart from its picks", () => {
		const [q] = fromAskUser([extras]);
		expect(askUserResult([q], [said("q1", "CI", "2")]).answers[0]).toEqual({
			question: "Which extras?",
			answer: "Tests, CI",
			custom: true,
			picks: ["Tests"],
			typed: "CI",
		});
	});

	it("keeps answers given before a cancellation, and says why it stopped", () => {
		const questions = fromAskUser([scope, extras]);
		expect(askUserResult(questions, [picks("q1", "1"), { id: "q2", cancelled: "declined" }])).toEqual({
			cancelled: true,
			answers: [{ question: "Which scope?", answer: "Small (Recommended)", custom: false }],
		});
		expect(
			askUserResult(questions, [
				{ id: "q1", cancelled: "unavailable" },
				{ id: "q2", cancelled: "unavailable" },
			]),
		).toEqual({
			cancelled: true,
			answers: [],
			reason: "unavailable",
		});
		expect(askUserResult(questions, [{ id: "q1", cancelled: "aborted" }])).toMatchObject({ reason: "aborted" });
		// A timeout and a missing reply read as a decline.
		expect(askUserResult(questions, [{ id: "q1", cancelled: "timeout" }])).toEqual({ cancelled: true, answers: [] });
		expect(askUserResult(questions, [])).toEqual({ cancelled: true, answers: [] });
	});

	it.each([
		["no pick and no text", picks("q1")],
		["only whitespace", said("q1", "   ")],
		["an id that is no option", picks("q1", "9")],
	])("treats %s as no answer", (_name, reply) => {
		expect(askUserResult(fromAskUser([scope]), [reply])).toEqual({ cancelled: true, answers: [] });
	});

	it("takes one option of a single choice", () => {
		expect(askUserResult(fromAskUser([scope]), [picks("q1", "2", "1")]).answers[0].answer).toBe("Small (Recommended)");
	});

	const request: PermissionRequest = { action: "shell", title: "Run it?", what: ["ls"] };
	const approval = approvalFor("a", request, {
		allowOnce: ALLOW_ONCE,
		session: sessionOption("`ls`"),
		kind: kindOption("shell") ?? "kind",
		deny: DENY,
		note: DENY_NOTE,
		noteTitle: NOTE_TITLE,
	});

	it.each([
		["allow_once", picks("a", "allow_once"), "once"],
		["allow_session", picks("a", "allow_session"), "session"],
		["allow_kind", picks("a", "allow_kind"), "kind"],
		["deny", picks("a", "deny"), "deny"],
		["deny_note with a note", said("a", " use rg ", "deny_note"), { deny: "use rg" }],
		["deny_note without one", said("a", "  ", "deny_note"), "deny"],
		["a cancelled reply", { id: "a", cancelled: "declined" }, undefined],
		["an unknown option id", picks("a", "allow_forever"), undefined],
		["no pick", picks("a"), undefined],
	] as [string, Reply, unknown][])("decodes an approval reply by role: %s", (_name, reply, expected) => {
		expect(permissionAnswer(approval, reply)).toEqual(expected);
	});

	it("never decodes a role the reply claims, a label, or a question that is not an approval", () => {
		// The roles live in the question the harness built: a pick of another question's id decides nothing.
		expect(permissionAnswer(approval, picks("a", "Allow once"))).toBeUndefined();
		expect(permissionAnswer(approval, { id: "a", picks: ["deny"], role: "allow_once" } as unknown as Reply)).toBe(
			"deny",
		);
		expect(permissionAnswer(choice("c", "Which?", [{ label: "Deny", role: "deny" }]), picks("c", "1"))).toBeUndefined();
		expect(permissionAnswer(approval, undefined)).toBeUndefined();
	});

	it("decodes select labels, confirm booleans and input text", () => {
		const pick = choice("s", "Which?", ["A", "B"]);
		expect(selectedLabel(pick, picks("s", "2"))).toBe("B");
		expect(selectedLabel(pick, said("s", " mine "))).toBe("mine");
		expect(selectedLabel(pick, picks("s", "7"))).toBeUndefined();
		expect(selectedLabel(pick, { id: "s", cancelled: "aborted" })).toBeUndefined();
		const yes = confirm("c", "Sure?", "detail");
		expect(confirmed(yes, picks("c", "yes"))).toBe(true);
		expect(confirmed(yes, picks("c", "no"))).toBe(false);
		expect(confirmed(yes, { id: "c", cancelled: "timeout" })).toBe(false);
		expect(confirmed(pick, picks("s", "1"))).toBe(false);
		expect(inputText(said("t", " raw "))).toBe(" raw ");
		expect(inputText({ id: "t", cancelled: "declined" })).toBeUndefined();
	});
});

/** The RPC fallback cases of ask.test.ts, driven through the question owner. */
describe("degrade", () => {
	const run = async (questions: AskQuestion[], ui: Parameters<typeof fakeCtx>[0]["ui"]) => {
		const qs = fromAskUser(questions);
		return askUserResult(qs, await degrade(fakeCtx({ cwd: ".", mode: "rpc", ui }).ui, qs));
	};

	it("asks a select, then an input for a write-in", async () => {
		const result = await run([scope, extras], { selects: ["2. Large", "Write an answer"], inputs: ["  just docs  "] });
		expect(result).toMatchObject({
			cancelled: false,
			answers: [
				{ question: "Which scope?", answer: "Large", custom: false },
				{ question: "Which extras?", answer: "just docs", custom: true },
			],
		});
	});

	it("maps a described label back to the bare label, and stops at a dismissal", async () => {
		const result = await run([scope, extras], { selects: ["1. Small (Recommended) \u2014 One file", undefined] });
		expect(result).toMatchObject({
			cancelled: true,
			answers: [{ question: "Which scope?", answer: "Small (Recommended)", custom: false }],
		});
	});

	it("asks an empty write-in again", async () => {
		const result = await run([scope, extras], {
			selects: ["Write an answer", "2. Large", "Write an answer"],
			inputs: ["   ", "tests"],
		});
		expect(result).toMatchObject({
			cancelled: false,
			answers: [
				{ question: "Which scope?", answer: "Large", custom: false },
				{ question: "Which extras?", answer: "tests", custom: true },
			],
		});
	});

	it("picks a multi question one option per round until Submit, or until every option is picked", async () => {
		expect((await run([extras], { selects: ["3. Bench", "1. Docs", "Submit selection"] })).answers[0].answer).toBe(
			"Docs, Bench",
		);
		expect((await run([extras], { selects: ["1. Docs", "2. Tests", "3. Bench"] })).answers[0].answer).toBe(
			"Docs, Tests, Bench",
		);
		expect((await run([extras], { selects: ["2. Tests", "Write an answer"], inputs: ["CI"] })).answers[0]).toEqual({
			question: "Which extras?",
			answer: "Tests, CI",
			custom: true,
			picks: ["Tests"],
			typed: "CI",
		});
	});

	it("offers Submit selection only after a pick", async () => {
		const offered: string[][] = [];
		const ctx = fakeCtx({ cwd: ".", mode: "rpc" });
		const ui = {
			...ctx.ui,
			select: async (_title: string, options: string[]) => {
				offered.push(options);
				return offered.length === 1 ? "1. Docs" : "Submit selection";
			},
		};
		await degrade(ui, fromAskUser([extras]));
		expect(offered).toEqual([
			["1. Docs", "2. Tests", "3. Bench", "Write an answer"],
			["2. Tests", "3. Bench", "Submit selection", "Write an answer"],
		]);
	});

	it("asks a free-text question with an input only", async () => {
		const result = await run([free], { inputs: ["eu-west-1"] });
		expect(result).toMatchObject({ cancelled: false, answers: [{ answer: "eu-west-1", custom: true }] });
	});

	it("distinguishes duplicate labels and labels named after UI actions by their numbers", async () => {
		const result = await run(
			[
				{
					question: "Which?",
					options: [
						{ label: "Done.", description: "first" },
						{ label: "Done.", description: "second" },
						{ label: "Write an answer" },
					],
				},
			],
			{ selects: ["2. Done. \u2014 second"] },
		);
		expect(result).toMatchObject({ cancelled: false, answers: [{ answer: "Done.", custom: false }] });
	});

	it("asks a forwarded child's question as a plain select, its numbered options and write-in row, with no card", async () => {
		const seen: { title: string; options: string[]; opts: unknown }[] = [];
		const ui = {
			...fakeCtx({ cwd: ".", mode: "rpc" }).ui,
			select: async (title: string, options: string[], opts?: ExtensionUIDialogOptions) => {
				seen.push({ title, options, opts });
				return "1. Small";
			},
		};
		await degrade(ui, fromAskUser([forwarded]));
		expect(seen[0].title).toBe(forwarded.question);
		expect(seen[0].options).toEqual(["1. Small", "2. Large", "Write an answer"]);
		expect(seen[0].opts).not.toHaveProperty("ask");
	});

	it("answers aborted without asking when the signal is already aborted, and the rest after a dismissal", async () => {
		const controller = new AbortController();
		controller.abort();
		const ctx = fakeCtx({ cwd: ".", mode: "rpc", ui: { inputs: ["x"] } });
		expect(await degrade(ctx.ui, [text("t", "Region?")], { signal: controller.signal })).toEqual([
			{ id: "t", cancelled: "aborted" },
		]);
		expect(ctx.ui.inputs).toEqual(["x"]);
		const replies = await degrade(fakeCtx({ cwd: ".", mode: "rpc", ui: { inputs: [undefined] } }).ui, [
			text("t1", "A?"),
			text("t2", "B?"),
		]);
		expect(replies).toEqual([
			{ id: "t1", cancelled: "declined" },
			{ id: "t2", cancelled: "declined" },
		]);
	});

	it("reports a dismissal after the timeout as a timeout", async () => {
		const ui = {
			...fakeCtx({ cwd: "." }).ui,
			input: async () => (await new Promise((r) => setTimeout(r, 15)), undefined),
		};
		expect(await degrade(ui, [text("t", "A?")], { timeout: 10 })).toEqual([{ id: "t", cancelled: "timeout" }]);
	});

	it("asks a confirm and an approval with their host options", async () => {
		const opts: unknown[] = [];
		const ctx = fakeCtx({ cwd: ".", mode: "rpc" });
		const ui = {
			...ctx.ui,
			confirm: async () => true,
			input: async () => " because ",
			select: async (_title: string, options: string[], o?: unknown) => {
				opts.push(o);
				return options.find((label) => label === DENY_NOTE);
			},
		};
		const approval = approvalFor(
			"a",
			{ action: "shell", title: "Run it?", what: ["ls"], toolCallId: "c1" },
			{ allowOnce: ALLOW_ONCE, deny: DENY, note: DENY_NOTE, noteTitle: NOTE_TITLE },
		);
		const replies = await degrade(ui, [confirm("c", "Sure?"), approval]);
		expect(replies).toEqual([picks("c", "yes"), said("a", "because", "deny_note")]);
		expect(permissionAnswer(approval, replies[1])).toEqual({ deny: "because" });
		// A host without its own approval shows a plain select: no approval flag, permission request or card rides on it.
		expect(opts[0]).not.toHaveProperty("approval");
		expect(opts[0]).not.toHaveProperty("permission");
		expect(opts[0]).not.toHaveProperty("ask");
	});

	it("hands an approval to the host's own approve with the question, and takes the note it returns", async () => {
		const approval = approvalFor(
			"a",
			{ action: "shell", title: "Run it?", what: ["ls"], toolCallId: "c1" },
			{ allowOnce: ALLOW_ONCE, deny: DENY, note: DENY_NOTE, noteTitle: NOTE_TITLE },
		);
		const input = vi.fn(async () => "second dialog");
		const approve = vi.fn(async () => ({ label: DENY_NOTE, note: "typed in the card" }));
		const select = vi.fn();
		const replies = await degrade({ ...fakeCtx({ cwd: "." }).ui, select, input, approve }, [approval]);
		expect(approve).toHaveBeenCalledWith(approval, expect.anything());
		expect(replies).toEqual([said("a", "typed in the card", "deny_note")]);
		expect(select).not.toHaveBeenCalled();
		expect(input).not.toHaveBeenCalled();
	});

	it("cancels an approval answered with a label it did not offer", async () => {
		const approval = approvalFor(
			"a",
			{ action: "shell", title: "Run it?", what: ["ls"] },
			{ allowOnce: ALLOW_ONCE, deny: DENY, note: DENY_NOTE, noteTitle: NOTE_TITLE },
		);
		const ui = { ...fakeCtx({ cwd: "." }).ui, select: async () => "Allow forever" };
		expect(await degrade(ui, [approval])).toEqual([{ id: "a", cancelled: "declined" }]);
	});
});

describe("ask", () => {
	const questions: Question[] = [choice("c", "Which?", ["A", "B"])];

	it("answers unavailable for every question when there is no UI", async () => {
		const ctx = fakeCtx({ cwd: ".", hasUI: false });
		expect(await ask(ctx, [...questions, text("t", "Why?")])).toEqual([
			{ id: "c", cancelled: "unavailable" },
			{ id: "t", cancelled: "unavailable" },
		]);
	});

	it("answers aborted for an interrupted turn without asking", async () => {
		const controller = new AbortController();
		controller.abort();
		const ctx = fakeCtx({ cwd: ".", ui: { selects: ["1. A"] } });
		expect(await ask(ctx, questions, { signal: controller.signal })).toEqual([{ id: "c", cancelled: "aborted" }]);
		expect(ctx.ui.selects).toEqual(["1. A"]);
	});

	it("uses the host's ask when it has one, passing the options", async () => {
		const seen: unknown[] = [];
		const ctx = fakeCtx({ cwd: ".", ui: { selects: ["never"] } });
		const ui = Object.assign(ctx.ui, {
			ask: async (qs: Question[], opts: unknown) => {
				seen.push(qs, opts);
				return [picks("c", "2"), picks("stray", "1")];
			},
		});
		const replies = await ask({ hasUI: true, ui }, [...questions, text("t", "Why?")], { blocking: true, timeout: 50 });
		// One reply per question, in order: a missing one is a decline, a stray one is dropped.
		expect(replies).toEqual([picks("c", "2"), { id: "t", cancelled: "declined" }]);
		expect(seen[1]).toEqual({ blocking: true, timeout: 50 });
		expect(ui.selects).toEqual(["never"]);
	});

	it("degrades to plain dialogs when the host has no ask", async () => {
		const ctx = fakeCtx({ cwd: ".", mode: "rpc", ui: { selects: ["2. B"] } });
		expect(await ask(ctx, questions)).toEqual([picks("c", "2")]);
	});

	it("draws text, choice and multi questions with the terminal dialog, and asks an approval as a select", async () => {
		const seen: string[] = [];
		const ctx = fakeCtx({ cwd: ".", mode: "tui", ui: { selects: [DENY] } });
		const ui = Object.assign(ctx.ui, {
			custom: async () => (seen.push("custom"), [picks("c", "1")]),
		});
		expect(await ask({ hasUI: true, mode: "tui", ui }, questions)).toEqual([picks("c", "1")]);
		expect(seen).toEqual(["custom"]);
		const approval = approvalFor(
			"a",
			{ action: "shell", title: "Run it?", what: ["ls"] },
			{ allowOnce: ALLOW_ONCE, deny: DENY, note: DENY_NOTE, noteTitle: NOTE_TITLE },
		);
		expect(await ask({ hasUI: true, mode: "tui", ui }, [approval])).toEqual([picks("a", "deny")]);
		expect(seen).toEqual(["custom"]);
	});

	it("lets a host error propagate", async () => {
		const ctx = fakeCtx({ cwd: "." });
		const ui = Object.assign(ctx.ui, {
			ask: async () => {
				throw new Error("transport closed");
			},
		});
		await expect(ask({ hasUI: true, ui }, questions)).rejects.toThrow("transport closed");
	});
});
