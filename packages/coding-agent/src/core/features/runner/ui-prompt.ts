/**
 * Tracking of UI dialogs, reported to features as `ui_prompt_start` and `ui_prompt_end`, and the broker that lets a
 * client other than the mode's own UI answer them. Each notice the UI shows (`notify`) is reported as `ui_notice`, so
 * such a client can show it too.
 *
 * Every tracked dialog gets an id. The mode's dialog (terminal, RPC host) and a remote answer race: the first answer
 * wins, and the loser is closed through the abort signal every dialog implementation honors. A remote `choice` must
 * be one of the dialog's own options; a `confirm` takes "Yes" or "No"; an `input` takes text; an `ask` takes one checked
 * reply per question, so an approval answered remotely is exactly one of the permission gate's options. Editor and
 * custom dialogs have no remote shape.
 */

import { randomUUID } from "node:crypto";
import { checkedReplies, type Question } from "@octocodeai/octocode-contracts";
import { inputOrigin } from "../../input-origin.ts";
import type { AskView, SessionUI, DialogOptions, UIPromptKind } from "../types.ts";
import type { RunnerEmitEvent } from "./types.ts";

type UIPromptEvent = Extract<RunnerEmitEvent, { type: "ui_prompt_start" | "ui_prompt_end" | "ui_notice" }>;

/** What a client sends to answer a dialog: one of its options, or text where it accepts text. */
export interface DialogAnswer {
	choice?: string;
	text?: string;
	/** The replies to an `ask` dialog, one per question id (checked against the questions before they are taken). */
	replies?: unknown;
}

/** Whether an answer was taken; a refusal names why (unknown dialog, not an offered choice, already answered). */
export type DialogAnswerResult = { ok: true } | { ok: false; reason: string };

const CONFIRM_OPTIONS = ["Yes", "No"] as const;

interface Pending {
	kind: UIPromptKind;
	title?: string;
	options?: string[];
	allowsText: boolean;
	/** An `ask` dialog with an `approval` question: it decides whether to allow an action. */
	approval?: boolean;
	/** The structured card a custom dialog with a remote answer shape draws, reported so a client can draw it too. */
	ask?: AskView;
	/** The typed questions an `ask` dialog shows, so a client can draw and answer them. */
	questions?: Question[];
	/** The dialog blocks work that goes on without the user (`DialogOptions.blocking`). */
	blocking?: boolean;
	/** Stops the countdown the dialog runs, when a client starts answering. */
	hold?: () => void;
	/** Settles the dialog with the remote answer's value; undefined when the dialog cannot be answered remotely. */
	settle?: (value: unknown) => void;
	/** Maps a client's answer to the dialog's value, or `REFUSED`. */
	parse?: (answer: DialogAnswer) => unknown;
}

export class UIPromptTracker {
	private depth = 0;
	private readonly pending = new Map<string, Pending>();

	private readonly emit: (event: UIPromptEvent) => Promise<unknown>;

	/** `emit` dispatches an event to the runner's handlers; it is called in a microtask. */
	constructor(emit: (event: UIPromptEvent) => Promise<unknown>) {
		this.emit = emit;
	}

	wrap(ui: SessionUI): SessionUI {
		const hostAsk = ui.ask?.bind(ui);
		return {
			...ui,
			notify: (message, type) => {
				ui.notify(message, type);
				this.emitUIPromptEvent({ type: "ui_notice", message, level: type ?? "info" });
			},
			// A host that draws questions itself: tracked so a remote client sees them and answers by reply.
			...(hostAsk
				? {
						ask: (questions: Question[], opts?: Parameters<NonNullable<SessionUI["ask"]>>[1]) =>
							this.tracked(
								{
									kind: "ask",
									title: questions[0]?.question,
									allowsText: false,
									questions,
									...(questions.some((question) => question.type === "approval") ? { approval: true } : {}),
									...(opts?.blocking ? { blocking: true } : {}),
									...(opts?.hold ? { hold: opts.hold } : {}),
								},
								(signal) => hostAsk(questions, { ...opts, ...(signal ? { signal } : {}) }),
								opts,
								(answer) => checkedReplies(questions, answer.replies) ?? REFUSED,
							),
					}
				: {}),
			select: (title, options, opts) =>
				this.tracked(
					{
						kind: "select",
						title,
						options: [...options],
						allowsText: false,
						...dialogFlags(opts),
					},
					(signal) => ui.select(title, options, { ...opts, signal }),
					opts,
					(answer) => (answer.choice !== undefined && options.includes(answer.choice) ? answer.choice : REFUSED),
				),
			confirm: (title, message, opts) =>
				this.tracked(
					{ kind: "confirm", title, options: [...CONFIRM_OPTIONS], allowsText: false, ...dialogFlags(opts) },
					// A confirmation a web prompt triggered is the web client's to answer: the terminal draws no dialog for it.
					(signal) =>
						inputOrigin() === "web" ? closedOnAbort(signal, false) : ui.confirm(title, message, { ...opts, signal }),
					opts,
					(answer) => (answer.choice === "Yes" ? true : answer.choice === "No" ? false : REFUSED),
				),
			input: (title, placeholder, opts) =>
				this.tracked(
					{ kind: "input", title, allowsText: true, ...dialogFlags(opts) },
					(signal) => ui.input(title, placeholder, { ...opts, signal }),
					opts,
					(answer) => (typeof answer.text === "string" ? answer.text : REFUSED),
				),
			editor: (title, prefill, opts) =>
				this.tracked(
					{ kind: "editor", title, allowsText: false },
					(signal) => ui.editor(title, prefill, { ...opts, signal }),
					opts,
				),
			custom: (factory, options) => {
				const remote = options?.remote;
				if (!remote) return this.tracked({ kind: "custom", allowsText: false }, () => ui.custom(factory, options));
				// The terminal's component closes when a remote answer wins: its `done` is the only handle on it.
				let close: (() => void) | undefined;
				const shown: typeof factory = (tui, theme, keybindings, done) => {
					close = () => done(undefined as never);
					return factory(tui, theme, keybindings, done);
				};
				if ("questions" in remote) {
					const questions = [...remote.questions];
					return this.tracked(
						{
							kind: "custom",
							title: remote.title,
							allowsText: false,
							questions,
							...(remote.hold ? { hold: () => remote.hold?.() } : {}),
						},
						() => ui.custom(shown, options),
						undefined,
						(answer) => (checkedReplies(questions, answer.replies) as never) ?? REFUSED,
						() => close?.(),
					);
				}
				return this.tracked(
					{
						kind: "custom",
						title: remote.title,
						options: [...remote.options],
						allowsText: remote.allowsText === true,
						...(remote.ask ? { ask: remote.ask } : {}),
						...(remote.hold ? { hold: () => remote.hold?.() } : {}),
					},
					() => ui.custom(shown, options),
					undefined,
					(answer) => {
						const value =
							answer.choice !== undefined && remote.options.includes(answer.choice)
								? remote.answer({ choice: answer.choice })
								: remote.allowsText && typeof answer.text === "string"
									? remote.answer({ text: answer.text })
									: undefined;
						return value ?? REFUSED;
					},
					() => close?.(),
				);
			},
		};
	}

	/** Answer the dialog `id` on behalf of a client. The mode's own dialog closes when the answer is taken. */
	answer(id: string, answer: DialogAnswer): DialogAnswerResult {
		const dialog = this.pending.get(id);
		if (!dialog) return { ok: false, reason: "No such dialog is open; it may have been answered already." };
		if (!dialog.settle) return { ok: false, reason: `A ${dialog.kind} dialog can only be answered in the terminal.` };
		const value = dialog.parse?.(answer) ?? REFUSED;
		if (value === REFUSED) {
			return {
				ok: false,
				reason: dialog.questions
					? "Answer with one reply per question, picking only the options it offers (picks), and text only where it takes text."
					: dialog.allowsText
						? "This dialog takes text."
						: `Answer with one of: ${(dialog.options ?? []).join(", ")}.`,
			};
		}
		dialog.settle(value);
		return { ok: true };
	}

	/**
	 * A client started answering the dialog `id`: stop the countdown it runs, so nothing is taken for the person. A
	 * dialog without a countdown has nothing to stop; only a dialog that is no longer open is refused.
	 */
	hold(id: string): DialogAnswerResult {
		const dialog = this.pending.get(id);
		if (!dialog) return { ok: false, reason: "No such dialog is open; it may have been answered already." };
		dialog.hold?.();
		return { ok: true };
	}

	private tracked<T>(
		dialog: Omit<Pending, "settle" | "parse">,
		run: (signal: AbortSignal | undefined) => Promise<T>,
		opts?: DialogOptions,
		parse?: (answer: DialogAnswer) => T | typeof REFUSED,
		close?: () => void,
	): Promise<T> {
		const id = randomUUID();
		const nested = this.depth++ > 0;
		const controller = new AbortController();
		const forward = () => controller.abort(opts?.signal?.reason);
		if (opts?.signal?.aborted) forward();
		else opts?.signal?.addEventListener("abort", forward, { once: true });
		this.emitUIPromptEvent({
			type: "ui_prompt_start",
			reason: "ui_prompt",
			kind: dialog.kind,
			id,
			...(dialog.title ? { title: dialog.title } : {}),
			...(dialog.options ? { options: dialog.options } : {}),
			...(dialog.allowsText ? { allowsText: true } : {}),
			...(dialog.approval ? { approval: true } : {}),
			...(dialog.ask ? { ask: dialog.ask } : {}),
			...(dialog.questions ? { questions: dialog.questions } : {}),
			...(dialog.blocking ? { blocking: true } : {}),
			...(nested ? { nested: true } : {}),
		});
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			this.depth = Math.max(0, this.depth - 1);
			this.pending.delete(id);
			opts?.signal?.removeEventListener("abort", forward);
			this.emitUIPromptEvent({
				type: "ui_prompt_end",
				reason: "ui_prompt",
				kind: dialog.kind,
				id,
				...(dialog.title ? { title: dialog.title } : {}),
				...(nested ? { nested: true } : {}),
			});
		};
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, {
				...dialog,
				...(parse
					? {
							parse,
							settle: (value: unknown) => {
								if (settled) return;
								finish();
								// The mode's dialog closes; its own resolution (undefined/false on abort) is dropped below.
								controller.abort();
								close?.();
								resolve(value as T);
							},
						}
					: {}),
			});
			let modeResult: Promise<T>;
			try {
				modeResult = run(parse ? controller.signal : opts?.signal);
			} catch (error) {
				finish();
				reject(error);
				return;
			}
			modeResult.then(
				(value) => {
					if (settled) return;
					finish();
					resolve(value);
				},
				(error: unknown) => {
					if (settled) return;
					finish();
					reject(error);
				},
			);
		});
	}

	private emitUIPromptEvent(event: UIPromptEvent): void {
		queueMicrotask(() => {
			// Handler failures are already reported through emitError; nothing awaits this notification.
			void this.emit(event).catch(() => undefined);
		});
	}
}

/** A dialog drawn only in a remote client: it stays open until `signal` aborts (an answer or the caller's abort), then closes as `closed`. */
function closedOnAbort<T>(signal: AbortSignal | undefined, closed: T): Promise<T> {
	return new Promise<T>((resolve) => {
		if (!signal || signal.aborted) resolve(closed);
		else signal.addEventListener("abort", () => resolve(closed), { once: true });
	});
}

/** What a dialog's options say about it: whether it blocks work that goes on without the user. */
function dialogFlags(opts: DialogOptions | undefined): Pick<Pending, "blocking"> {
	return opts?.blocking ? { blocking: true } : {};
}

/** The marker a parser returns for an answer the dialog cannot take. */
const REFUSED: unique symbol = Symbol("refused");
