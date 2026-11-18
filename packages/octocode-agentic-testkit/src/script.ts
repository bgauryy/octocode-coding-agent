import type { StopReason } from "./reply.ts";
import type { CapturedRequest, Trace, Usage } from "./trace.ts";

/** One scripted tool call. `rawArgs` sends that argument text verbatim (malformed JSON included) instead of `args`. */
export interface ScriptedCall {
	name: string;
	args?: unknown;
	rawArgs?: string;
}

/** A scripted model answer, or an HTTP error. Text and tool calls may both be set. */
export type Step =
	| {
			text?: string;
			toolCalls?: ScriptedCall[];
			/** Overrides fields of the simulated usage. */
			usage?: Partial<Usage>;
			/** Waits before replying. */
			delayMs?: number;
			/** Ends the reply on a token limit or a refusal, in each wire's own stop field. */
			stop?: StopReason;
			/**
			 * Drops the connection: `before-reply` closes it with no response, `mid-stream` after a partial body. The
			 * request is recorded; no answer or tool call is.
			 */
			disconnect?: "before-reply" | "mid-stream";
	  }
	| { error: { status: number; message?: string; retryAfterSeconds?: number } };

/** Thrown by a responder to answer with a status other than the default 502; its message lands in `errors`. */
export class StepFailure extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

export interface ScriptOptions {
	/** `repeat-last` (default) replays the last step; `fail` answers 500 and records the error. */
	onExhausted?: "repeat-last" | "fail";
}

export interface ResponderContext {
	request: CapturedRequest;
	trace: Trace;
	/** 0-based position among this agent's requests. */
	turn: number;
}

export type StepSource = Step | ((ctx: ResponderContext) => Step);
export type Responder = (ctx: ResponderContext) => Step | Promise<Step>;

/** Per-agent sequential steps; the last step repeats unless `onExhausted: "fail"`. A step may be a function of the request. */
export function script(steps: StepSource[], opts: ScriptOptions = {}): Responder {
	return (ctx) => {
		if (opts.onExhausted === "fail" && ctx.turn >= steps.length)
			throw new StepFailure(`script exhausted after ${steps.length} steps`, 500);
		const s = steps[Math.min(ctx.turn, steps.length - 1)];
		if (s === undefined) return { text: "testkit: empty script" };
		return typeof s === "function" ? s(ctx) : s;
	};
}

/**
 * One script per agent role, by the `x-testkit-agent` header or the role the gateway inferred (see `Lineage`).
 * `<role>:compactor` falls back to a canned summary, other unknown roles to a notice.
 */
export function scripts(byAgent: Record<string, StepSource[]>): Responder {
	const built = new Map(Object.entries(byAgent).map(([k, v]) => [k, script(v)]));
	return (ctx) => {
		const r = built.get(ctx.request.agent);
		if (r) return r(ctx);
		if (ctx.request.agent.endsWith(":compactor")) return { text: "Summary of the earlier work." };
		return { text: `testkit: no script for agent ${ctx.request.agent}` };
	};
}
