import { agentCall } from "../shared/agent-call.ts";
import { fileChanges } from "../shared/file-input.ts";
import { visibleWidth } from "@octocodeai/octocode-tui";
import { redactSecrets, sanitizeTerminalText } from "../../../../common/src/sanitize.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/index.ts";
import { setRunClock } from "../../modes/interactive/components/status-indicator.ts";
import { dialogsWaiting, onDialogsChange, promptTitle } from "../shared/locks.ts";
import { setRowsAnimate } from "./chrome.ts";
import { clipColumns, queryTarget } from "../shared/render/text.ts";
import { asRecord, isRecord } from "@octocodeai/octocode-contracts/guards";
import { Thought } from "../shared/thought.ts";
import { firstLine, toolHint } from "../shared/util.ts";

/** What the model is doing between tool runs. */
type Phase = "idle" | "model" | "thinking" | "writing" | "calling";

interface RunningTool {
	name: string;
	hint: string;
	/** Queries of the call beyond the one `hint` names. */
	more: number;
	startedAt: number;
	/** Its `tool_call` checks (reservations, the bash guard, PreToolUse hooks) run now; set while they do. */
	checkingSince?: number;
}

/** A consequential call's line is replaced at most this often; calls inside the window count into it (`+3`). */
const ACTION_LINE_MS = 1_000;
/** Octocode's working line wraps, and a wrap moves the editor: every line stays within this many columns. */
const LINE_MAX = 70;
/** The working line's budget: wide enough for any terminal row, which the renderer clips. */
const WORKING_LINE_MAX = 240;
/** A parallel batch names this many tools, then counts the rest. */
const BATCH_NAMES = 2;

/** `mcp__octocode__localSearch` → `localSearch`: the server prefix only costs width. */
export function shortToolName(name: string): string {
	return name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "");
}

/** Text for the working line and the shared team database: no terminal controls, one line, no URL credentials or secrets. */
function safeText(text: string): string {
	return redactSecrets(firstLine(sanitizeTerminalText(text)).replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, "$1"));
}

/**
 * What a call works on: the goal of an `agent` call, the first query's target of a batched call (`file` and the
 * Octocode tools take `{queries: [...]}`) with the count of the others, else the top-level argument `toolHint` picks.
 */
export function callTarget(name: string, args: unknown): { hint: string; more: number } {
	const input = name === "agent" ? agentCall(args).input : asRecord(args);
	if (shortToolName(name) === "agent" && typeof input.goal === "string") return { hint: safeText(input.goal), more: 0 };
	const queries =
		name === "file" ? fileChanges(input) : Array.isArray(input.queries) ? input.queries.filter(isRecord) : [];
	if (queries.length > 0) return { hint: safeText(queryTarget(queries[0])), more: queries.length - 1 };
	return { hint: safeText(toolHint(args)), more: 0 };
}

/** `head` then `detail` clipped to the columns LINE_MAX leaves, then `tail`; `sep` joins head and a non-empty detail. */
function fitWithin(head: string, sep: string, detail: string, tail: string, lineMax = LINE_MAX): string {
	if (!detail) return `${head}${tail}`;
	const room = lineMax - visibleWidth(head) - visibleWidth(sep) - visibleWidth(tail);
	return `${head}${sep}${clipColumns(detail, Math.max(room, 12))}${tail}`;
}

/** A tool as its row titles it: `Bash`, `File`, `localSearch`; the `agent` tool is a subagent. */
function toolLabel(name: string): string {
	if (name === "agent") return "subagent";
	return /^[a-z]+$/.test(name) ? `${name[0].toUpperCase()}${name.slice(1)}` : name;
}

/** The first `BATCH_NAMES` distinct tool names of a parallel batch with their counts (`web ×2`). */
function batchNames(running: readonly RunningTool[], label: (tool: RunningTool) => string): string {
	const counts = new Map<string, number>();
	for (const tool of running) counts.set(label(tool), (counts.get(label(tool)) ?? 0) + 1);
	return [...counts]
		.slice(0, BATCH_NAMES)
		.map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
		.join(" · ");
}

/** ` +2` for the calls of a batch beyond the names shown, or nothing. */
function batchRest(running: readonly RunningTool[]): string {
	const counts = new Map<string, number>();
	for (const tool of running) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
	const shown = [...counts].slice(0, BATCH_NAMES).reduce((sum, [, count]) => sum + count, 0);
	return running.length > shown ? ` +${running.length - shown}` : "";
}

/**
 * The agent's state for a run, from Octocode's events: model phase, the top-level tool calls running now (parallel calls all
 * count; nested calls a tool makes are part of it), and a blocking user prompt. Pure state: `describe` renders it.
 */
export class Activity {
	phase: Phase = "idle";
	private phaseAt = 0;
	private readonly tools = new Map<string, RunningTool>();
	private prompt: { title: string; at: number } | undefined;
	/** The latest consequential call the permission check let through, while its tool runs (`id`: that call, when its check was running). */
	private action: { id?: string; head: string; text: string; warn: boolean; at: number; more: number } | undefined;
	private readonly thought = new Thought();

	start(now: number): void {
		this.tools.clear();
		this.action = undefined;
		this.prompt = undefined;
		this.thought.reset();
		this.setPhase("model", now);
	}

	end(): void {
		this.tools.clear();
		this.action = undefined;
		this.prompt = undefined;
		this.thought.reset();
		this.phase = "idle";
	}

	/** An assistant streaming event (`thinking_delta` with its `delta`, `text_start`, `toolcall_delta`, …); true when the line changed. */
	stream(type: string, now: number, delta?: string): boolean {
		if (this.phase === "idle") return false;
		const phase: Phase | undefined = type.startsWith("thinking")
			? "thinking"
			: type.startsWith("text")
				? "writing"
				: type.startsWith("toolcall")
					? "calling"
					: undefined;
		if (type === "thinking_start") this.thought.reset();
		const thought = type === "thinking_delta" && typeof delta === "string" && this.thought.add(delta);
		if (phase && phase !== this.phase) {
			this.setPhase(phase, now);
			return true;
		}
		return thought && this.phase === "thinking";
	}

	/** The assistant message is complete: its tools run next, or the run ends. */
	messageDone(now: number): void {
		if (this.phase !== "idle") this.setPhase("model", now);
	}

	toolStart(id: string, name: string, args: unknown, now: number): void {
		// A truncated reply's calls start too, under whatever name the model wrote.
		this.tools.set(id, { name: shortToolName(safeText(name)), ...callTarget(name, args), startedAt: now });
	}

	toolEnd(id: string, now: number): void {
		const ended = this.tools.delete(id);
		// A call that ends (even one another handler blocked after the permission check) takes its own line with it.
		if (this.action?.id === id || (ended && this.tools.size === 0)) this.action = undefined;
		if (ended && this.tools.size === 0 && this.phase !== "idle") this.setPhase("model", now);
	}

	/**
	 * A call the permission check let through (`what` is its first target). The line changes at most once per
	 * `ACTION_LINE_MS`: a burst inside the window only raises the `+n` count, except a ⚠ call, which always shows itself.
	 */
	consequential(action: string, what: string, warn: boolean, now: number): void {
		const held = this.action;
		if (held && now - held.at < ACTION_LINE_MS && !(warn && !held.warn)) {
			held.more += 1;
			return;
		}
		const checked = [...this.tools].find(([, tool]) => tool.checkingSince !== undefined)?.[0];
		this.action = {
			...(checked === undefined ? {} : { id: checked }),
			head: action,
			text: what,
			warn,
			at: now,
			more: 0,
		};
	}

	/** A call's `tool_call` checks started (`active`) or ended. Octocode checks the calls of a batch one at a time. */
	checking(id: string, active: boolean, now: number): void {
		const tool = this.tools.get(id);
		if (!tool) return;
		if (active) tool.checkingSince = now;
		else delete tool.checkingSince;
	}

	promptStart(title: string | undefined, now: number): void {
		this.prompt = { title: title ? safeText(title) : "", at: now };
	}

	promptEnd(): void {
		this.prompt = undefined;
	}

	/**
	 * One line for the state, or undefined when there is nothing to say (the team panel stores it). It carries no clock:
	 * the line changes only when the state does. `lineMax` budgets it: the stored line keeps `LINE_MAX`.
	 */
	describe(queuedDialogs = 0, lineMax = LINE_MAX): string | undefined {
		const fitLine = (head: string, sep: string, detail: string, tail: string) =>
			fitWithin(head, sep, detail, tail, lineMax);
		if (this.phase === "idle") return undefined;
		if (this.prompt) {
			const queued = queuedDialogs > 0 ? ` (+${queuedDialogs} queued)` : "";
			return fitLine("Waiting for you", ": ", this.prompt.title, queued);
		}
		if (this.action && this.tools.size > 0)
			return fitLine(
				`${this.action.warn ? "⚠ " : ""}${this.action.head}`,
				": ",
				this.action.text,
				this.action.more > 0 ? ` +${this.action.more}` : "",
			);
		const running = [...this.tools.values()];
		const call = (verb: string, tool: RunningTool) =>
			fitLine(`${verb} ${tool.name}`, " ", tool.hint, tool.more > 0 ? ` +${tool.more}` : "");
		const checking = running.find((tool) => tool.checkingSince !== undefined);
		if (checking) return call("Checking", checking);
		if (running.length === 1) return call("Running", running[0]);
		if (running.length > 1)
			return fitLine(
				`Running ${running.length} tools`,
				": ",
				batchNames(running, (tool) => tool.name),
				batchRest(running),
			);
		if (this.phase === "thinking") return fitLine("Thinking", ": ", this.thought.gist ?? "", "");
		if (this.phase === "writing") return "Writing";
		if (this.phase === "calling") return "Preparing tool calls";
		return undefined;
	}

	/**
	 * The working line: what the agent is doing, with no clock (the indicator shows the run's elapsed time in a fixed
	 * place). A single tool is named without its command, which its own row already shows; a subagent shows its goal;
	 * permission class ids (`shell`, `agent.spawn`) stay out of it. A ⚠ call keeps its warning and its target.
	 */
	working(queuedDialogs = 0): string | undefined {
		if (this.phase === "idle") return undefined;
		const fit = (head: string, sep: string, detail: string, tail = "") =>
			fitWithin(head, sep, detail, tail, WORKING_LINE_MAX);
		if (this.prompt) {
			const queued = queuedDialogs > 0 ? ` (+${queuedDialogs} queued)` : "";
			return fit("Waiting for you", ": ", this.prompt.title, queued);
		}
		const running = [...this.tools.values()];
		const warn = this.action?.warn && running.length > 0 ? this.action : undefined;
		const mark = warn ? "⚠ " : "";
		const one = (verb: string, tool: RunningTool) => {
			const more = tool.more > 0 ? ` +${tool.more}` : "";
			if (tool.name === "agent") return fit(`${mark}${verb} ${toolLabel(tool.name)}`, " ", tool.hint, more);
			return warn && running.length === 1
				? fit(`${mark}${verb} ${toolLabel(tool.name)}${more}`, ": ", warn.text)
				: `${mark}${verb} ${toolLabel(tool.name)}${more}`;
		};
		const checking = running.find((tool) => tool.checkingSince !== undefined);
		if (checking) return one("Checking", checking);
		if (running.length === 1) return one("Running", running[0]);
		if (running.length > 1)
			return fit(
				`${mark}Running ${running.length} tools`,
				": ",
				batchNames(running, (tool) => toolLabel(tool.name)),
				batchRest(running),
			);
		if (this.phase === "thinking") return fit("Thinking", ": ", this.thought.gist ?? "");
		if (this.phase === "writing") return "Writing";
		if (this.phase === "calling") return "Preparing tool calls";
		return "Waiting for model";
	}

	/** Whether a tool call is running: its row animates a spinner of its own. */
	toolsRunning(): boolean {
		return this.tools.size > 0;
	}

	/** Whether a run is under way (the working line shows). */
	ticking(): boolean {
		return this.phase !== "idle";
	}

	private setPhase(phase: Phase, now: number): void {
		this.phase = phase;
		this.phaseAt = now;
	}
}

/**
 * Feed `Activity` from Octocode's events. `onChange` hears the line without elapsed time whenever it changes (the team panel
 * shows it to the parent and teammates). The TUI shows the activity detail; its working indicator counts the run's
 * elapsed time from the clock started here. Settlement clears the display.
 */
interface ActivityControl {
	activity: Activity;
	/** The gate pipeline (src/index.ts) reports a call's `tool_call` checks starting and ending. */
	checking(id: string, active: boolean): void;
	/** A call the permission check let through (`onAction` of the permission state). */
	consequential(action: string, what: string, warn: boolean): void;
}

export function registerActivity(
	api: ExtensionAPI,
	options: { onChange?: (line: string | undefined) => void; workingLine: boolean },
): ActivityControl {
	const activity = new Activity();
	let ctx: ExtensionContext | undefined;
	let shown: string | undefined;
	let reported: string | undefined;
	/** Repaints when interactions queue behind an open dialog; held per session. */
	let unsubscribe: (() => void) | undefined;

	const paint = () => {
		const line = activity.describe(dialogsWaiting());
		if (line !== reported) {
			reported = line;
			options.onChange?.(line);
		}
		// Only the TUI draws a working line (its indicator counts the run's time itself): RPC's setWorkingMessage is a no-op.
		if (!options.workingLine || !ctx?.hasUI || ctx.mode !== "tui") return;
		const working = activity.ticking() ? activity.working(dialogsWaiting()) : undefined;
		setRowsAnimate(ctx, activity.toolsRunning());
		if (working !== shown) {
			shown = working;
			try {
				ctx.ui.setWorkingMessage(working);
			} catch {
				// The session was replaced.
			}
		}
	};
	const stop = () => {
		activity.end();
		setRunClock(undefined);
		paint();
	};

	api.on("session_start", async (_event, next) => {
		ctx = next;
		shown = undefined;
		unsubscribe?.();
		unsubscribe = onDialogsChange(paint);
		stop();
	});
	api.on("session_shutdown", async () => {
		unsubscribe?.();
		unsubscribe = undefined;
		stop();
		ctx = undefined;
	});
	api.on("agent_start", async (_event, next) => {
		ctx = next;

		const now = Date.now();
		activity.start(now);
		if (options.workingLine) setRunClock(now);
		paint();
	});
	api.on("message_update", async (event) => {
		if (event.message.role !== "assistant" || !activity.ticking()) return;
		const update = event.assistantMessageEvent;
		if (activity.stream(update.type, Date.now(), update.type === "thinking_delta" ? update.delta : undefined)) paint();
	});
	api.on("message_end", async (event) => {
		if (!activity.ticking()) return;
		if (event.message.role === "assistant") activity.messageDone(Date.now());
		paint();
	});
	api.on("tool_execution_start", async (event) => {
		if (event.parentToolCallId) return;
		activity.toolStart(event.toolCallId, event.toolName, event.args, Date.now());
		paint();
	});
	api.on("tool_execution_end", async (event) => {
		if (event.parentToolCallId) return;
		activity.toolEnd(event.toolCallId, Date.now());
		paint();
	});
	// A dialog over another (an input after "type my own") is one wait, not two.
	api.on("ui_prompt_start", async (event) => {
		if (event.nested) return;
		activity.promptStart(promptTitle(event), Date.now());
		paint();
	});
	api.on("ui_prompt_end", async (event) => {
		if (event.nested) return;
		activity.promptEnd();
		paint();
	});
	api.on("agent_settled", async () => stop());
	return {
		activity,
		consequential: (action, what, warn) => {
			activity.consequential(action, what, warn, Date.now());
			paint();
		},
		checking: (id, active) => {
			activity.checking(id, active, Date.now());
			paint();
		},
	};
}
