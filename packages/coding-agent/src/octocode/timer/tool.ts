import { textResultDisplay } from "../render/display.ts";
import { renderInstruction } from "../../core/prompt-template.ts";
import { StringEnum } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { type AgentDb, type TimerRow, timers } from "../../../../db/src/api.ts";
import type { ExtensionContext, ToolDefinition } from "../../core/features/index.ts";
import { resultBlock, toolHeader } from "../render/tool.ts";
import { clip } from "../shared/text.ts";
import { contentText, textResult } from "../shared/util.ts";
import type { ConditionDeps } from "./conditions/types.ts";
import { CHECK_CAPS } from "./judge.ts";
import { describeCondition, parseUntil } from "./conditions/index.ts";
import {
	listeningLine,
	MAX_ACTIVE,
	MIN_CHECK_SECONDS,
	MIN_EVERY_SECONDS,
	type TimerSetInput,
	timerFields,
	timerLine,
} from "./model.ts";
import { type EventFilter, LISTEN_EVENTS, untilOfEvent } from "./on.ts";

const text = (description: string) => Type.Optional(Type.String({ description }));

const parameters = Type.Object(
	{
		op: StringEnum(["set", "on", "off", "list"] as const),
		note: text("required: what to do on wake"),
		after: Type.Optional(Type.Number({ description: "set: seconds" })),
		every: Type.Optional(
			Type.Number({
				description: `set: min ${MIN_EVERY_SECONDS}s; on: poll, min ${MIN_CHECK_SECONDS}s`,
			}),
		),
		event: Type.Optional(StringEnum(LISTEN_EVENTS)),
		filter: Type.Optional(
			Type.Object(
				{
					ref: text("comma-joined: any"),
					state: text("todo|ongoing|done|closed|ready (dependsOn all done)"),
					path: Type.Optional(Type.String()),
					agent: Type.Optional(Type.String()),
					command: text("exit 0"),
				},
				{ additionalProperties: false },
			),
		),
		check: text("on: question a small model judges (paid)"),
		once: Type.Optional(Type.Boolean({ description: "on: false repeats" })),
		maxRuns: Type.Optional(Type.Integer({ description: "default 20" })),
		deadline: Type.Optional(Type.Number({ description: "seconds; on: 3600" })),
		id: Type.Optional(Type.Integer({ description: "off: id" })),
		all: Type.Optional(Type.Boolean({ description: "list: ended too; off: all" })),
	},
	{ additionalProperties: false },
);

type Params = Omit<TimerSetInput, "until"> & {
	op: "set" | "on" | "off" | "list";
	event?: string;
	filter?: EventFilter;
	check?: string;
	id?: number;
	all?: boolean;
};

/** Where the tool reads and writes: the shared database, this workspace and the owner session. */
export interface TimerHost {
	db: () => AgentDb;
	workspaceId: (ctx: ExtensionContext) => string;
	agent: () => string | undefined;
	now: () => number;
	/** What conditions read from the host: `set` asks it whether a named agent ended or an item exists. */
	deps: ConditionDeps;
	/** Before a `check` wait is set: why it may not be (off, declined, no cheaper model), or undefined. */
	checkRefusal: (ctx: ExtensionContext) => Promise<string | undefined>;
	/** What wakes the session without a wait (its running children and background jobs), one line, or empty. */
	implicit: () => string;
	/** After a set (with the new timer) or off: the session's scheduler rereads its next due time. */
	changed: (ctx: ExtensionContext, set?: TimerRow) => void;
}

export interface TimerToolDetails {
	timer?: TimerRow;
	shown?: number;
}

export function timerTool(host: TimerHost): ToolDefinition<typeof parameters, TimerToolDetails> {
	return {
		name: "wait",
		label: "Wait",
		promptSnippet: renderInstruction("tools/wait/snippet.md"),
		description:
			"Wake this session with a note: set after/every seconds; on an event (once:false repeats); off by id; list adds what wakes you unasked. check.result runs a command: `test -e path`.",
		parameters,
		async execute(toolCallId, params: Params, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			const { db } = host.db();
			const session = ctx.sessionManager.getSessionId();
			const now = host.now();
			if (params.op === "list") {
				const rows = timers.forSession(db, session, params.all === true);
				const implicit = host.implicit();
				const text = [
					rows.length ? rows.map((row) => timerLine(row, now)).join("\n") : `No ${params.all ? "" : "active "}waits.`,
					...(implicit ? [`Wake you without a wait: ${implicit}`] : []),
				].join("\n");
				return textResult(text, { shown: rows.length });
			}
			if (params.op === "off") {
				const result = cancelTimers(db, session, now, params);
				if (result.changed) host.changed(ctx);
				return textResult(result.text, result.details);
			}
			const listening = params.op === "on";
			if (!listening && [params.event, params.filter, params.check].some((value) => value !== undefined))
				throw new Error("event, filter and check belong to on; set wakes after or every seconds.");
			const until = listening ? untilOfEvent(params.event, params.filter, params.check) : undefined;
			if (timers.activeCount(db, session) >= MAX_ACTIVE)
				throw new Error(`This session has ${MAX_ACTIVE} active waits, the most it may hold: turn one off first.`);
			const agent = host.agent();
			const condition = parseUntil(until);
			const ended = condition?.kind === "agent" ? host.deps.agentEnd(condition.name) : undefined;
			if (condition?.kind === "agent" && ended)
				throw new Error(
					`${condition.name} already ended (${ended.reason}), so there is nothing to wait for: its report reaches you without a wait. Nothing was set.`,
				);
			const missing =
				condition?.kind === "item" ? condition.ref.split(",").filter((ref) => host.deps.item(ref) === undefined) : [];
			if (missing.length) throw new Error(`No backlog item ${missing.join(", ")} in this workspace. Nothing was set.`);
			if (condition?.kind === "check") {
				const refusal = await host.checkRefusal(ctx);
				if (refusal) throw new Error(refusal);
			}
			signal?.throwIfAborted();
			const timer = timers.insert(
				db,
				timerFields({ ...params, ...(until ? { until } : {}) }, now, {
					workspaceId: host.workspaceId(ctx),
					sessionId: session,
					...(agent ? { agent } : {}),
					toolCallId,
					cwd: ctx.cwd,
				}),
			);
			host.changed(ctx, timer);
			const caps =
				condition?.kind === "check"
					? `\nJudging is capped: ${CHECK_CAPS.perWaitChecks} judgments and $${CHECK_CAPS.perWaitUsd.toFixed(2)} per wait, $${CHECK_CAPS.perCheckUsd.toFixed(2)} per judgment, $${CHECK_CAPS.perSessionUsd.toFixed(2)} per session, 30s apart.`
					: "";
			return textResult(`${listening ? listeningLine(timer, now) : `Set ${timerLine(timer, now)}`}${caps}`, { timer });
		},
		display(input) {
			const { args } = input;
			const summary = [
				args.op,
				args.id,
				args.every !== undefined ? `every ${args.every}s` : args.after !== undefined ? `in ${args.after}s` : "",
				eventTarget(args),
				// oxlint-disable-next-line typescript/no-unnecessary-type-conversion -- arguments are model output, unvalidated while the call renders
				args.note ? `"${String(args.note)}"` : "",
			]
				.filter((part) => part !== undefined && part !== "")
				.join(" ");
			return textResultDisplay({ title: "Wait", ...(summary ? { summary } : {}), kind: "other", blocks: [] }, input);
		},
		renderCall(args, theme, context) {
			const until = eventTarget(args);
			const target = [
				args.op,
				args.id,
				args.every !== undefined ? `every ${args.every}s` : args.after !== undefined ? `in ${args.after}s` : "",
				until,
				// oxlint-disable-next-line typescript/no-unnecessary-type-conversion -- arguments are model output, unvalidated while the call renders
				args.note ? `"${clip(String(args.note), 80)}"` : "",
			]
				.filter((part) => part !== undefined && part !== "")
				.join(" ");
			return toolHeader(theme, context, "Wait", target);
		},
		renderResult(result, _options, theme, context) {
			const text = contentText(result.content);
			const [summary = "", ...rest] = text.split("\n");
			return resultBlock(theme, context, { summary, body: rest.join("\n") });
		},
	};
}

/** The active waits' ids, for an off that named none or a wrong one. */
const activeIds = (db: AgentDb["db"], session: string): string => {
	const ids = timers.forSession(db, session).map((row) => row.id);
	return ids.length ? `Active: ${ids.join(", ")}.` : "No wait is active.";
};

/**
 * `off`, as `removeEventListener`: an active wait with `id` stops, one of this session that already ended is a no-op,
 * `all` stops every active one. An id this session never set, or neither field, is an error naming the active ids.
 */
function cancelTimers(
	db: AgentDb["db"],
	session: string,
	now: number,
	params: Pick<Params, "id" | "all">,
): { text: string; details: TimerToolDetails; changed: boolean } {
	if (params.id !== undefined && params.all === true) throw new Error("off takes id or all, not both.");
	if (params.all === true) {
		const rows = timers.cancelAll(db, session, now);
		const text = rows.length
			? [
					`Cancelled ${rows.length} wait${rows.length === 1 ? "" : "s"}:`,
					...rows.map((row) => timerLine(row, now)),
				].join("\n")
			: "No active waits to turn off.";
		return { text, details: { shown: rows.length }, changed: rows.length > 0 };
	}
	if (params.id === undefined)
		throw new Error(`off needs the id that set or on returned, or all: true. ${activeIds(db, session)}`);
	const timer = timers.cancel(db, params.id, session, now);
	if (timer) return { text: `Cancelled ${timerLine(timer, now)}`, details: { timer }, changed: true };
	const ended = timers.get(db, params.id);
	if (ended?.session_id !== session) throw new Error(`No wait ${params.id} in this session. ${activeIds(db, session)}`);
	return {
		text: `Wait ${ended.id} already ended, nothing to turn off: ${timerLine(ended, now)}`,
		details: { timer: ended },
		changed: false,
	};
}

/** The call's event, in a few words: arguments are model output and may be malformed while the call renders. */
function eventTarget(args: { event?: unknown; filter?: unknown; check?: unknown }): string {
	if (args.event === undefined) return "";
	try {
		const condition = parseUntil(untilOfEvent(args.event, args.filter as EventFilter | undefined, undefined));
		return condition ? `on ${clip(describeCondition(condition), 80)}` : "";
	} catch {
		// Not a valid event (yet): show only the name it was given.
		return typeof args.event === "string" ? `on ${clip(args.event, 40)}` : "on";
	}
}
