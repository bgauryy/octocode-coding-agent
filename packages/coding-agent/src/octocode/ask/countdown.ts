import type { Question, Reply } from "@octocodeai/octocode-contracts";

/**
 * askUser's `timeout`: the options marked recommended are taken when the time runs out. Only a choice or multi question
 * that offers one carries it; a permission prompt, a confirmation and a free-text question never count down.
 */

/** The ids of the options a timed-out question takes: a choice its first recommended option, a multi all of them. */
export function recommendedIds(q: Question): string[] {
	if (q.type !== "choice" && q.type !== "multi") return [];
	const ids = (q.options ?? []).filter((option) => option.recommended).map((option) => option.id);
	return q.type === "multi" ? ids : ids.slice(0, 1);
}

/** The labels of the options `recommendedIds` takes. */
export function recommendedLabels(q: Question): string[] {
	const ids = new Set(recommendedIds(q));
	return (q.options ?? []).filter((option) => ids.has(option.id)).map((option) => option.label);
}

/**
 * Seconds the whole batch waits before its recommended options are taken, or undefined when it never counts down: every
 * question must carry a timeout and a recommended option, so a timeout never leaves a question without an answer.
 */
export function autoSeconds(questions: readonly Question[]): number | undefined {
	const seconds = questions[0]?.timeoutSeconds;
	const every = questions.every((q) => q.timeoutSeconds === seconds && recommendedIds(q).length > 0);
	return seconds !== undefined && every ? seconds : undefined;
}

/** The replies of a timed-out batch: each question's recommended options, marked automatic. */
export const autoReplies = (questions: readonly Question[]): Reply[] =>
	questions.map((q) => ({ id: q.id, picks: recommendedIds(q), auto: true }));

/**
 * One countdown, started on construction: `onTick` (when given) once a second while it runs, `onExpire` when the time is
 * up. `stop` (any interaction, a client's hold, an answer, a dismissal) releases both timers and is safe to call again; a
 * stopped countdown never expires.
 */
export class Countdown {
	private readonly deadline: number;
	private tick: ReturnType<typeof setInterval> | undefined;
	private expiry: ReturnType<typeof setTimeout> | undefined;

	constructor(seconds: number, onTick: (() => void) | undefined, onExpire: () => void) {
		this.deadline = Date.now() + seconds * 1000;
		this.tick = onTick ? setInterval(onTick, 1000) : undefined;
		this.expiry = setTimeout(() => {
			this.stop();
			onExpire();
		}, seconds * 1000);
	}

	get running(): boolean {
		return this.expiry !== undefined;
	}

	/** Whole seconds left, rounded up so the card never shows 0s while it still waits. */
	remaining(): number {
		return Math.max(0, Math.ceil((this.deadline - Date.now()) / 1000));
	}

	/** Whether it was still running. */
	stop(): boolean {
		const was = this.running;
		clearInterval(this.tick);
		clearTimeout(this.expiry);
		this.tick = undefined;
		this.expiry = undefined;
		return was;
	}
}

/**
 * Runs a host's dialogs (`show`, given the signal that dismisses them and the `hold` that stops the timer) under the
 * batch's timeout. When the time runs out first, the dialogs are dismissed and the recommended replies stand; an answer
 * that arrives first wins and releases the timer, and so does `hold`, which the host calls when the person starts
 * answering: the dialogs then wait for them as long as they need. `signal` is the turn's: an interruption passes through
 * to `show` unchanged.
 */
export async function withDeadline(
	questions: readonly Question[],
	signal: AbortSignal | undefined,
	show: (signal: AbortSignal | undefined, hold: () => void) => Promise<Reply[]>,
): Promise<Reply[]> {
	const seconds = autoSeconds(questions);
	if (seconds === undefined) return show(signal, () => undefined);
	const own = new AbortController();
	const forward = () => own.abort(signal?.reason);
	if (signal?.aborted) forward();
	else signal?.addEventListener("abort", forward, { once: true });
	let expired = false;
	const timer = new Countdown(seconds, undefined, () => {
		expired = true;
		own.abort();
	});
	try {
		const replies = await show(own.signal, () => void timer.stop());
		return expired && !signal?.aborted ? autoReplies(questions) : replies;
	} finally {
		timer.stop();
		signal?.removeEventListener("abort", forward);
	}
}
