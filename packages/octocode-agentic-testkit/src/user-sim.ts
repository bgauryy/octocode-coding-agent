import type { AgentSession } from "./adapter.ts";
import { forwardOf, type Tier } from "./tiers.ts";
import type { ChatMessage, Trace } from "./trace.ts";
import { forwardUpstream, type Forward } from "./upstream.ts";

/** One exchange: what the user sent, the agent's answer (null when the run produced none) and the run's result. */
export interface ConverseTurn<R = unknown> {
	user: string;
	answer: string | null;
	result: R;
}

export interface UserContext {
	/** The exchanges so far. */
	transcript: readonly ConverseTurn[];
	/** The agent's last answer; null before the first run or when the run produced none. */
	lastAnswer: string | null;
	/** How many messages this user has written in this conversation (0 on the first call). */
	turn: number;
}

/** Writes the next user message; `undefined` ends the conversation. */
export interface SimulatedUser {
	next(ctx: UserContext): Promise<string | undefined> | string | undefined;
	/** A message containing this ends the conversation and is not sent. */
	stopToken?: string;
}

export type ScriptedTurn = string | ((lastAnswer: string | null) => string | undefined);

/** A user that sends the turns in order; a function turn reads the last answer. Ends past the last turn. */
export function scriptedUser(turns: readonly ScriptedTurn[]): SimulatedUser {
	return {
		next: ({ turn, lastAnswer }) => {
			const t = turns[turn];
			return typeof t === "function" ? t(lastAnswer) : t;
		},
	};
}

/** The tau-bench stop token. */
export const DEFAULT_STOP_TOKEN = "###STOP###";

export interface ModelUserOptions {
	/** The user model: a tier from `resolveTier` or a gateway-style `forward` (OpenAI chat or Anthropic wire). */
	model: Tier | Forward;
	/** What the simulated user wants. The user model sees it; the agent only sees the messages. */
	goal: string;
	/** Who the user is: tone, knowledge, patience. */
	persona?: string;
	/** Default `###STOP###`. */
	stopToken?: string;
}

const isTier = (m: Tier | Forward): m is Tier => "remote" in m && "name" in m;

function systemPrompt(o: ModelUserOptions, stop: string): string {
	return [
		"You are role-playing a user who talks to an AI assistant. Write only the user's next message: no role labels, no narration.",
		`Your goal: ${o.goal}`,
		o.persona ? `Your persona: ${o.persona}` : "",
		"Share details only when the assistant needs them, and do not do the assistant's work yourself.",
		`When the goal is met, or the assistant clearly cannot meet it, reply with ${stop} alone.`,
	]
		.filter(Boolean)
		.join("\n");
}

/**
 * A user played by a model. The transcript is sent with roles swapped (the agent's answers as `user`, the simulated
 * user's messages as `assistant`), after the goal and persona in the system prompt. Upstream errors propagate; an
 * empty reply throws.
 */
export function modelUser(o: ModelUserOptions): SimulatedUser {
	const forward = isTier(o.model) ? forwardOf(o.model) : o.model;
	const extra = isTier(o.model) ? o.model.body : {};
	if (!forward.model) throw new TypeError("modelUser: set model.model, the user model's id");
	const stopToken = o.stopToken ?? DEFAULT_STOP_TOKEN;
	const system = systemPrompt(o, stopToken);
	return {
		stopToken,
		async next({ transcript }) {
			const messages: ChatMessage[] = [
				{ role: "system", content: system },
				{ role: "user", content: "(The conversation starts. Write your first message to the assistant.)" },
			];
			for (const t of transcript)
				messages.push(
					{ role: "assistant", content: t.user },
					{ role: "user", content: t.answer ?? "(The assistant gave no answer.)" },
				);
			const reply = await forwardUpstream({ ...extra, model: forward.model, messages }, forward);
			const text = reply.text.trim();
			if (!text)
				throw new Error(`modelUser: the user model returned an empty message after ${transcript.length} turns`);
			return text;
		},
	};
}

export type ConverseStop = "user" | "stop-token" | "max-turns";

export interface ConverseOptions<R> {
	/** Runs of the agent at most; the user is not asked for a message past it. */
	maxTurns: number;
	/** Sent first instead of asking the user for the opening message. */
	firstMessage?: string;
	/** The agent's answer in a run's result. Default: `result.answer` when the result has one (the reference adapter). */
	answerOf?: (result: R) => string | null;
	/** Read each run's answer from this trace's `answer` events (`Gateway.trace`) when the result carries none. */
	trace?: Trace;
}

export interface Conversation<R> {
	turns: ConverseTurn<R>[];
	stopped: ConverseStop;
}

function answerFrom<R>(result: R, opts: ConverseOptions<R>, trace: Trace | undefined): string | null {
	if (opts.answerOf) return opts.answerOf(result);
	if (typeof result === "object" && result !== null && "answer" in result) {
		const a = (result as { answer: unknown }).answer;
		if (typeof a === "string" || a === null) return a;
	}
	if (trace) {
		const data = trace.of("answer").at(-1)?.data;
		return typeof data === "string" ? data : null;
	}
	throw new Error("converse: the run result has no `answer`; pass `answerOf` or `trace`");
}

/**
 * Drive a session with a simulated user: send a message, read the answer, ask the user for the next one, until the user
 * returns `undefined` (`user`), writes its stop token (`stop-token`) or `maxTurns` runs are done (`max-turns`).
 * Keeping context across `run()` calls is the adapter's job (`referenceAdapter({ conversation: true })`).
 */
export async function converse<R>(
	session: AgentSession<R>,
	user: SimulatedUser,
	opts: ConverseOptions<R>,
): Promise<Conversation<R>> {
	if (!Number.isInteger(opts.maxTurns) || opts.maxTurns < 1)
		throw new RangeError(`converse: maxTurns=${opts.maxTurns} must be an integer of at least 1`);
	const turns: ConverseTurn<R>[] = [];
	let asked = 0;
	let message = opts.firstMessage ?? (await user.next({ transcript: turns, lastAnswer: null, turn: asked++ }));
	for (;;) {
		if (message === undefined) return { turns, stopped: "user" };
		if (user.stopToken && message.includes(user.stopToken)) return { turns, stopped: "stop-token" };
		const mark = opts.trace?.mark();
		// oxlint-disable-next-line no-await-in-loop -- turns of one conversation: the user's next message reads the last answer
		const result = await session.run(message);
		const answer = answerFrom(result, opts, mark && opts.trace?.since(mark));
		turns.push({ user: message, answer, result });
		if (turns.length >= opts.maxTurns) return { turns, stopped: "max-turns" };
		// oxlint-disable-next-line no-await-in-loop -- turns of one conversation: the user's next message reads the last answer
		message = await user.next({ transcript: turns, lastAnswer: answer, turn: asked++ });
	}
}
