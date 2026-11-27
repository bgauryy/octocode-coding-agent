import { registerRepeatedProseGuard } from "./repeated-prose.ts";
import { renderPrompt } from "../core/prompt-template.ts";
import { memoryMutation } from "./shared/archive-operation.ts";
import type { FeatureSetup, FeatureContext } from "../core/features/index.ts";
import { sha256 } from "@octocodeai/octocode-common/atomic-file";
import { asRecord, isRecord } from "@octocodeai/octocode-contracts/guards";
import { argumentsKey } from "./files/dedupe.ts";
import { plainText } from "./files/reads.ts";
import { say } from "./shared/commands.ts";
import { limitsFor } from "./compaction/limits.ts";
import type { Gate } from "./permission/judge.ts";

/**
 * Repeated calls without progress. The same tool, the same arguments and the same outcome several times in a row means
 * the model is retrying something that will not change: the result gets a short note that says so. Thresholds come from
 * the session logs (`docs/native-features.md`): across 12.6 K tool calls the longest run of an identical call with an
 * identical result was 2, so 3 had no false positive; the one real loop (seven broken `file` calls) got a different error
 * text each time, so an error counts by its call alone, not its text. Past `LOOP_HALT_AT` the next identical call is
 * refused and ends the run, so a call that keeps failing (a denied command, invalid arguments) cannot repeat forever.
 *
 * Every result is counted from `message_end`, which the agent loop emits in tool-call order for executed, blocked,
 * invalid and unknown calls alike; the outcome of an executed call is hashed earlier, on `tool_result`, before the turn
 * budget may replace its text. The refusal itself is the `loop` step of the `tool_call` pipeline (`permission/judge.ts`),
 * so it is audited like every other refusal; this module only supplies the step's body.
 */

/** Identical outcomes in a row that earn the first note. */
export const LOOP_NOTE_AT = 3;
/** Identical outcomes in a row that earn the stronger note, and again every `LOOP_REPEAT_EVERY` after it. */
export const LOOP_STOP_AT = 5;
const LOOP_REPEAT_EVERY = 3;
/** Identical outcomes in a row after which the same call is refused and the run ends. */
export const LOOP_HALT_AT = 8;

/** Tools whose repeated, identical calls are legitimate: messaging, questions and bookkeeping. */
const EXEMPT = new Set(["agent", "askUser", "backlog", "backlogPlan", "coordinate"]);
/**
 * A shell command that waits (polling a job, a log, a port) is expected to repeat: `sleep`, `wait` or `watch` run as a
 * command (at the start or after `;`, `&&`, `||`, `|`), or `tail -f`. The words inside an argument do not count.
 */
const WAITING = /(?:^|[;&|]\s*)(?:sleep|wait|watch)\b|\btail\s+(?:-\S*\s+)*-\S*f/;

/** The three counts in force: `limits.loop` for the model in use, else the constants above. */
export interface LoopCounts {
	noteAt: number;
	stopAt: number;
	haltAt: number;
}
const BUILT_IN: LoopCounts = { noteAt: LOOP_NOTE_AT, stopAt: LOOP_STOP_AT, haltAt: LOOP_HALT_AT };

/** The note for the `count`-th identical outcome in a row, or undefined when none is due. */
export function loopNote(tool: string, count: number, failed: boolean, at: LoopCounts = BUILT_IN): string | undefined {
	if (count === at.noteAt) return renderPrompt("notices/loop-guard/note.md", { tool, count, failed });
	if (count >= at.stopAt && (count - at.stopAt) % LOOP_REPEAT_EVERY === 0)
		return renderPrompt("notices/loop-guard/stop.md", { tool, count });
	return undefined;
}

/**
 * The call's identity: its tool and arguments without any `reason`, at any depth. `reason` is the model's free text
 * about the goal and is reworded on a retry of the same call. Undefined for a call the guard never counts.
 */
function loopCallKey(toolName: string, input: unknown): string | undefined {
	if (EXEMPT.has(toolName)) return undefined;
	const args = asRecord(input);
	if (toolName === "memory" && memoryMutation(args)) return undefined;
	if (toolName === "bash" && typeof args.command === "string" && WAITING.test(args.command)) return undefined;
	const key = argumentsKey(withoutReasons(args) as Record<string, unknown>);
	return key ? `${toolName}\0${key}` : undefined;
}

/** Deep on purpose, unlike `withoutReason` (top level only, so a tool still receives its nested per-query `reason`): identity ignores rewording anywhere. */
function withoutReasons(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutReasons);
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => key !== "reason")
			.map(([key, item]) => [key, withoutReasons(item)]),
	);
}

/**
 * Counts results and adds the notes; returns the `loop` step's body, which refuses the next identical call past
 * `LOOP_HALT_AT` and ends the run. `tool-gates.ts` runs it first in the pipeline.
 */
export function registerLoopGuard(api: FeatureSetup): Gate {
	registerRepeatedProseGuard(api);
	/** Call key and executed outcome of each top-level call of the current message, by tool call id. */
	const calls = new Map<string, { key?: string; outcome?: string; checked?: boolean }>();
	const readHashes = new Map<string, string>();
	let lastCall: string | undefined;
	let last: string | undefined;
	let lastFailed = false;
	let count = 0;
	const refusal = (tool: string, previous: number) => renderPrompt("notices/loop-guard/refused.md", { tool, previous });
	// A halted run gets no further turn, so nothing the refusal asks of the model happens. In a subagent this notice is what
	// its report carries of the cause; a person sees why the run ended, a headless caller reads it on stderr, and the recorded
	// failure is what its exit code says.
	const halted = (ctx: FeatureContext, tool: string, previous: number) => {
		say(ctx, `Loop guard ended this run: ${previous} identical ${tool} calls with the same outcome.`, "error");
		ctx.failRun("Stopped by the loop guard.");
	};
	const counts = (ctx: Pick<FeatureContext, "model">): LoopCounts => limitsFor(api, ctx.model).loop ?? BUILT_IN;
	const reset = () => {
		calls.clear();
		readHashes.clear();
		lastCall = undefined;
		last = undefined;
		lastFailed = false;
		count = 0;
	};
	api.bus.on("session_start", reset);
	// A new prompt is new information: what follows is not a retry of what came before it.
	api.bus.on("before_agent_start", reset);
	api.bus.on("tool_execution_start", async (event) => {
		if (!event.parentToolCallId) calls.set(event.toolCallId, { key: loopCallKey(event.toolName, event.args) });
	});
	api.bus.on("tool_result", async (event) => {
		const call = event.parentToolCallId ? undefined : calls.get(event.toolCallId);
		if (call && !event.isError) {
			const unchangedOf = isRecord(event.details) ? event.details.unchangedOf : undefined;
			if (typeof unchangedOf === "string" && readHashes.has(unchangedOf)) {
				call.outcome = readHashes.get(unchangedOf);
				return undefined;
			}
			const text = plainText(event.content) ?? JSON.stringify(event.content);
			// A models call itself increases the reported spend. Keep every catalog, price, quota and health change.
			const comparable =
				event.toolName === "models"
					? text.replace(/\bspent (?:≈\$<?[\d.]+(?: \+ n\/a)?(?: · ~\$<?[\d.]+ plan)?|~\$<?[\d.]+ plan)/g, "spent")
					: text;
			const hash = sha256(comparable);
			readHashes.set(event.toolCallId, hash);
			call.outcome = hash;
		}
		return undefined;
	});
	api.bus.on("message_end", async (event, ctx) => {
		const message = event.message;
		if (message.role !== "toolResult") return undefined;
		const call = calls.get(message.toolCallId);
		calls.delete(message.toolCallId);
		if (!call) return undefined;
		if (!call.key) {
			// Exempt bookkeeping may separate retries of a failing call without erasing that failure streak. A successful
			// streak is different: any exempt call is new progress and starts the next comparison fresh.
			if (!lastFailed) {
				lastCall = undefined;
				last = undefined;
				count = 0;
			}
			return undefined;
		}
		const unchangedOf = !message.isError && isRecord(message.details) ? message.details.unchangedOf : undefined;
		const resolvedOutcome = call.outcome ?? (typeof unchangedOf === "string" ? readHashes.get(unchangedOf) : undefined);
		const outcome = message.isError ? "error" : (resolvedOutcome ?? sha256(JSON.stringify(message.content)));
		const key = `${call.key}\0${outcome}`;
		count = key === last ? count + 1 : 1;
		last = key;
		lastFailed = message.isError;
		lastCall = call.key;
		// Unknown tools and schema-invalid arguments never reach tool_call. Their result still ends the run here.
		const at = counts(ctx);
		if (!call.checked && count > at.haltAt && message.isError) {
			halted(ctx, message.toolName, count - 1);
			ctx.abort("internal");
			return {
				message: { ...message, content: [{ type: "text" as const, text: refusal(message.toolName, count - 1) }] },
			};
		}
		const note = loopNote(message.toolName, count, message.isError, at);
		return note
			? { message: { ...message, content: [...message.content, { type: "text" as const, text: note }] } }
			: undefined;
	});
	// The `loop` step: every call that reaches the `tool_call` pipeline passes here first.
	return async (event, ctx) => {
		const call = calls.get(event.toolCallId);
		if (call) call.checked = true;
		if (event.parentToolCallId || count < counts(ctx).haltAt) return undefined;
		// The count keys calls by the arguments the model sent; `event.input` is already validated (and maybe coerced).
		const key = calls.has(event.toolCallId)
			? calls.get(event.toolCallId)?.key
			: loopCallKey(event.toolName, event.input);
		if (key !== lastCall) return undefined;
		if (event.early) return { defer: true };
		halted(ctx, event.toolName, count);
		return { block: true, halt: true, terminate: true, reason: refusal(event.toolName, count) };
	};
}
