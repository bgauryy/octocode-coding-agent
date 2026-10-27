import type { ExtensionAPI } from "../core/extensions/index.ts";
import { sha256 } from "../utils/atomic-file.ts";
import { argumentsKey } from "./files/dedupe.ts";
import { plainText } from "./files/reads.ts";

/**
 * Repeated calls without progress. The same tool, the same arguments and the same outcome several times in a row means
 * the model is retrying something that will not change: the result gets a short note that says so (never a refusal, the
 * call has run). Thresholds come from the session logs (`docs/native-features.md`): across 12.6 K tool calls the longest
 * run of an identical call with an identical result was 2, so 3 had no false positive; the one real loop (seven broken
 * `file` calls) got a different error text each time, so an error counts by its call alone, not its text.
 */

/** Identical outcomes in a row that earn the first note. */
export const LOOP_NOTE_AT = 3;
/** Identical outcomes in a row that earn the stronger note, and again every `LOOP_REPEAT_EVERY` after it. */
export const LOOP_STOP_AT = 5;
const LOOP_REPEAT_EVERY = 3;

/** Tools whose repeated, identical calls are legitimate: messaging, questions and bookkeeping. */
const EXEMPT = new Set(["agent", "askUser", "backlog", "coordinate", "memory"]);
/** A shell command that waits (polling a job, a log, a port) is expected to repeat. */
const WAITING = /\b(?:sleep|wait|watch|poll)\b|\btail\s+(?:-\S*\s+)*-\S*f/;

/** The note for the `count`-th identical outcome in a row, or undefined when none is due. */
export function loopNote(tool: string, count: number, failed: boolean): string | undefined {
	const outcome = failed ? "failed the same way" : "returned the same result";
	if (count === LOOP_NOTE_AT)
		return `[Loop guard: this ${tool} call has ${outcome} ${count} times in a row. Repeating it will not change the outcome: change the arguments, use a different tool, or tell the user what blocks you.]`;
	if (count >= LOOP_STOP_AT && (count - LOOP_STOP_AT) % LOOP_REPEAT_EVERY === 0)
		return `[Loop guard: ${count} identical ${tool} calls in a row, no progress. Stop calling it this way. Summarize what you tried and report that you are blocked, or ask the user a specific question.]`;
	return undefined;
}

export function registerLoopGuard(pi: ExtensionAPI): void {
	let last: string | undefined;
	let count = 0;
	const reset = () => {
		last = undefined;
		count = 0;
	};
	pi.on("session_start", reset);
	// A new prompt is new information: what follows is not a retry of what came before it.
	pi.on("before_agent_start", reset);
	pi.on("tool_result", async (event) => {
		const command = typeof event.input.command === "string" ? event.input.command : "";
		if (event.parentToolCallId || EXEMPT.has(event.toolName) || (event.toolName === "bash" && WAITING.test(command)))
			return undefined;
		const args = argumentsKey(event.input);
		if (!args) return undefined;
		const outcome = event.isError ? "error" : sha256(plainText(event.content) ?? JSON.stringify(event.content));
		const key = `${event.toolName}\0${args}\0${outcome}`;
		count = key === last ? count + 1 : 1;
		last = key;
		const note = loopNote(event.toolName, count, event.isError);
		if (!note) return undefined;
		return {
			content: [...event.content, { type: "text" as const, text: note }],
			// Replacing `content` alone drops the machine-readable result.
			...(event.structuredContent !== undefined ? { structuredContent: event.structuredContent } : {}),
		};
	});
}
