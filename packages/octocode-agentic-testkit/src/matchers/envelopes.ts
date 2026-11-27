import { toolEnvelopes } from "../envelopes.ts";
import { textOf } from "../trace.ts";
import { cannot, needTrace, type Result } from "./shared.ts";

export interface EnvelopeLimits {
	/** Largest tool result, in characters, read from the requests (built-in tools included). */
	toolOutputChars?: number;
	/** Largest tool-call argument string, in characters, from every model tool call. */
	toolInputChars?: number;
	/** Largest final answer, in characters. */
	answerChars?: number;
	agent?: string;
}

const argChars = (args: unknown): number => (typeof args === "string" ? args : JSON.stringify(args ?? {})).length;

export const envelopeMatchers = {
	/** What enters and leaves the model's context stays small: tool results, tool arguments and answers. */
	toKeepEnvelopesUnder(received: unknown, limits: EnvelopeLimits): Result {
		const t = needTrace(received);
		if (limits.toolOutputChars === undefined && limits.toolInputChars === undefined && limits.answerChars === undefined)
			throw new Error("toKeepEnvelopesUnder: set toolOutputChars, toolInputChars or answerChars");
		if (!t.requests.length) return cannot("no requests (is the gateway sharing this trace?)");
		const mine = (agent: string): boolean => limits.agent === undefined || agent === limits.agent;
		const over: string[] = [];
		if (limits.toolOutputChars !== undefined)
			for (const e of toolEnvelopes(t))
				if (mine(e.agent) && (e.outputChars ?? 0) > limits.toolOutputChars)
					over.push(`${e.name} (${e.agent}, ${e.callId}) returned ${e.outputChars} chars > ${limits.toolOutputChars}`);
		for (const e of t.events) {
			if (!mine(e.agent)) continue;
			if (
				limits.toolInputChars !== undefined &&
				e.kind === "model_tool_call" &&
				argChars(e.args) > limits.toolInputChars
			)
				over.push(`#${e.seq} ${e.name} (${e.agent}) was sent ${argChars(e.args)} chars > ${limits.toolInputChars}`);
			if (limits.answerChars !== undefined && e.kind === "answer") {
				const chars = (typeof e.data === "string" ? e.data : textOf(e.data)).length;
				if (chars > limits.answerChars)
					over.push(`answer #${e.seq} (${e.agent}) ${chars} chars > ${limits.answerChars}`);
			}
		}
		return {
			pass: over.length === 0,
			message: () =>
				over.length
					? `envelopes over the limit:\n  ${over.join("\n  ")}`
					: `expected an envelope over ${JSON.stringify(limits)}, but every one was within it`,
		};
	},
};
