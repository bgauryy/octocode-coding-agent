import type { AssistantMessage, AssistantMessageEvent } from "@octocodeai/octocode-ai";
import type { AgentContext, AgentLoopConfig, AgentToolCall, AgentToolResult, EarlyToolStart } from "../types.ts";
import type { ToolUpdateSink } from "./events.ts";
import { reportListenerErrorToStderr } from "../listener-errors.ts";
import {
	type DeferredToolCall,
	type ExecutedToolCallOutcome,
	executePreparedToolCall,
	type ImmediateToolCallOutcome,
	type PreparedToolCall,
	prepareEarlyToolCall,
} from "./tool-call.ts";
import { resolveToolConcurrency } from "./tool-schedule.ts";

/**
 * One call started before its message ended. Its updates wait until the batch attaches a sink. A `deferred` preparation
 * means the call never started: the batch prepares it as a normal call.
 */
export interface EarlyRun {
	toolCall: AgentToolCall;
	preparation: Promise<PreparedToolCall | ImmediateToolCallOutcome | DeferredToolCall>;
	executed: Promise<ExecutedToolCallOutcome | undefined>;
	/** Forward buffered then live updates to `sink`, in order; resolves once the buffered ones were delivered. */
	attach(sink: ToolUpdateSink): Promise<void>;
}

const BLOCK_STARTS = new Set(["text_start", "thinking_start", "toolcall_start"]);

/**
 * Starts the calls of a streaming assistant message that `EarlyToolStart` allows, in call order (see its contract). A
 * call is settled once a later content block starts: the provider closed its block whole, so an output-limit cut, which
 * only ever ends the last block, never reaches a started call. Runs use their own abort signal, linked to the run's.
 */
export class EarlyToolCalls {
	private readonly controller = new AbortController();
	private readonly runs: EarlyRun[] = [];
	private ended: Array<{ index: number; toolCall: AgentToolCall }> = [];
	private closed = false;
	private preparing: Promise<Awaited<EarlyRun["preparation"]> | undefined> = Promise.resolve(undefined);
	private readonly unlink: () => void;
	private readonly context: AgentContext;
	private readonly config: AgentLoopConfig;
	private readonly policy: EarlyToolStart;

	constructor(context: AgentContext, config: AgentLoopConfig, policy: EarlyToolStart, signal: AbortSignal | undefined) {
		this.context = context;
		this.config = config;
		this.policy = policy;
		const abort = () => this.controller.abort(signal?.reason);
		if (signal?.aborted) abort();
		signal?.addEventListener("abort", abort, { once: true });
		this.unlink = () => signal?.removeEventListener("abort", abort);
	}

	/** Feed every event of the assistant stream, in order. */
	observe(event: AssistantMessageEvent): void {
		if (this.closed) return;
		if (event.type === "toolcall_end") {
			this.ended.push({ index: event.contentIndex, toolCall: event.toolCall });
			return;
		}
		if (!BLOCK_STARTS.has(event.type) || !("contentIndex" in event)) return;
		const settled = this.ended.filter((entry) => entry.index < event.contentIndex);
		this.ended = this.ended.filter((entry) => entry.index >= event.contentIndex);
		for (const entry of settled) this.consider(entry.toolCall, event.partial);
	}

	private consider(toolCall: AgentToolCall, partial: AssistantMessage): void {
		if (this.closed) return;
		const tool = this.context.tools?.find((candidate) => candidate.name === toolCall.name);
		if (
			!tool ||
			resolveToolConcurrency(tool, toolCall.arguments) !== "shared" ||
			!this.policy.mayStart(toolCall, tool)
		) {
			this.closed = true;
			return;
		}
		const signal = this.controller.signal;
		const message = { ...partial, content: [...partial.content] };
		const preparation = this.preparing.then(async (previous) => {
			// A deferred check also withdraws calls already queued behind it before the check settled.
			if (previous?.kind === "deferred") return previous;
			const prepared = await prepareEarlyToolCall(this.context, message, toolCall, this.config, signal);
			if (prepared.kind === "deferred") this.closed = true;
			return prepared;
		});
		this.preparing = preparation;
		const buffered: AgentToolResult<any>[] = [];
		let forward: ((update: AgentToolResult<any>) => Promise<void>) | undefined;
		const executed = preparation.then((prepared) =>
			prepared.kind === "prepared"
				? executePreparedToolCall(
						prepared,
						signal,
						(update) => (forward ? forward(update) : void buffered.push(update)),
						this.config.onListenerError,
					)
				: undefined,
		);
		void executed.catch(() => {});
		this.runs.push({
			toolCall,
			preparation,
			executed,
			attach: (sink) => {
				let delivered = Promise.resolve();
				const send = (update: AgentToolResult<any>) => {
					// As in `executePreparedToolCall`: a failing listener costs neither the tool's result nor the batch.
					delivered = delivered
						.then(() => sink(update))
						.catch((error: unknown) => {
							const report = this.config.onListenerError ?? reportListenerErrorToStderr;
							report(`Tool update listener error (${toolCall.name}): ${String(error)}`, error);
						});
					return delivered;
				};
				for (const update of buffered.splice(0)) void send(update);
				forward = send;
				return delivered;
			},
		});
	}

	/**
	 * The message ended cleanly: stop starting calls and hand over the started ones, a prefix of `toolCalls` in call order.
	 * A mismatch (a call the final message does not carry at that place) discards them all.
	 */
	take(toolCalls: readonly AgentToolCall[]): EarlyRun[] {
		this.closed = true;
		if (this.runs.some((run, index) => toolCalls[index]?.id !== run.toolCall.id)) {
			this.discard();
			return [];
		}
		return this.runs;
	}

	/** The batch that took the runs ended: a later abort of the run no longer concerns them. */
	dispose(): void {
		this.unlink();
	}

	/** The message ended by error, abort or the output limit: abort every started call and report it discarded. */
	discard(): void {
		this.closed = true;
		this.unlink();
		if (this.runs.length === 0) return;
		this.controller.abort(new Error("Assistant message did not complete"));
		for (const run of this.runs.splice(0)) this.policy.onDiscarded?.(run.toolCall.id);
	}
}
