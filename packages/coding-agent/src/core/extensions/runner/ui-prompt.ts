/**
 * Tracking of UI dialogs, reported to extensions as `ui_prompt_start` and `ui_prompt_end`, and the broker that lets a
 * client other than the mode's own UI answer them.
 *
 * Every tracked dialog gets an id. The mode's dialog (terminal, RPC host) and a remote answer race: the first answer
 * wins, and the loser is closed through the abort signal every dialog implementation honors. A remote `choice` must
 * be one of the dialog's own options, so an approval answered remotely is exactly one of the permission gate's
 * choices; a `confirm` takes "Yes" or "No"; an `input` takes text. Editor and custom dialogs have no remote shape.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionUIContext, ExtensionUIDialogOptions, UIPromptKind } from "../types.ts";
import type { RunnerEmitEvent } from "./types.ts";

type UIPromptEvent = Extract<RunnerEmitEvent, { type: "ui_prompt_start" | "ui_prompt_end" }>;

/** What a client sends to answer a dialog: one of its options, or text where it accepts text. */
export interface DialogAnswer {
	choice?: string;
	text?: string;
}

/** Whether an answer was taken; a refusal names why (unknown dialog, not an offered choice, already answered). */
export type DialogAnswerResult = { ok: true } | { ok: false; reason: string };

export const CONFIRM_OPTIONS = ["Yes", "No"] as const;

interface Pending {
	kind: UIPromptKind;
	title?: string;
	options?: string[];
	allowsText: boolean;
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

	wrap(ui: ExtensionUIContext): ExtensionUIContext {
		return {
			...ui,
			select: (title, options, opts) =>
				this.tracked(
					{ kind: "select", title, options: [...options], allowsText: false },
					(signal) => ui.select(title, options, { ...opts, signal }),
					opts,
					(answer) => (answer.choice !== undefined && options.includes(answer.choice) ? answer.choice : REFUSED),
				),
			confirm: (title, message, opts) =>
				this.tracked(
					{ kind: "confirm", title, options: [...CONFIRM_OPTIONS], allowsText: false },
					(signal) => ui.confirm(title, message, { ...opts, signal }),
					opts,
					(answer) => (answer.choice === "Yes" ? true : answer.choice === "No" ? false : REFUSED),
				),
			input: (title, placeholder, opts) =>
				this.tracked(
					{ kind: "input", title, allowsText: true },
					(signal) => ui.input(title, placeholder, { ...opts, signal }),
					opts,
					(answer) => (typeof answer.text === "string" ? answer.text : REFUSED),
				),
			editor: (title, prefill) =>
				this.tracked({ kind: "editor", title, allowsText: false }, () => ui.editor(title, prefill)),
			custom: (factory, options) =>
				this.tracked({ kind: "custom", allowsText: false }, () => ui.custom(factory, options)),
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
				reason: dialog.allowsText
					? "This dialog takes text."
					: `Answer with one of: ${(dialog.options ?? []).join(", ")}.`,
			};
		}
		dialog.settle(value);
		return { ok: true };
	}

	private tracked<T>(
		dialog: Omit<Pending, "settle" | "parse">,
		run: (signal: AbortSignal | undefined) => Promise<T>,
		opts?: ExtensionUIDialogOptions,
		parse?: (answer: DialogAnswer) => T | typeof REFUSED,
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
			void this.emit(event);
		});
	}
}

/** The marker a parser returns for an answer the dialog cannot take. */
const REFUSED: unique symbol = Symbol("refused");
