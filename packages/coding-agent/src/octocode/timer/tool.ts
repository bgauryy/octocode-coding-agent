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
import { MAX_ACTIVE, MIN_EVERY_SECONDS, type TimerSetInput, timerFields, timerLine } from "./model.ts";

const parameters = Type.Object(
	{
		op: StringEnum(["set", "list", "cancel"] as const),
		note: Type.Optional(Type.String({ description: "set" })),
		after: Type.Optional(Type.Number({ description: "set: seconds" })),
		every: Type.Optional(
			Type.Number({
				description: `set: seconds, min ${MIN_EVERY_SECONDS}; with until, check interval`,
			}),
		),
		until: Type.Optional(
			Type.Object(
				{
					command: Type.Optional(Type.String({ description: "exit 0" })),
					unlocked: Type.Optional(Type.String({ description: "path" })),
					file: Type.Optional(
						Type.Object(
							{
								path: Type.String(),
								is: Type.Optional(Type.String({ description: "exists|absent|changed (default)" })),
							},
							{ additionalProperties: false },
						),
					),
					item: Type.Optional(
						Type.Object(
							{
								ref: Type.String({ description: "item, or several comma-joined (any fires)" }),
								state: Type.String({ description: "todo|ongoing|done|closed|ready (dependsOn all done)" }),
							},
							{ additionalProperties: false },
						),
					),
					agent: Type.Optional(
						Type.Object({ name: Type.String() }, { additionalProperties: false, description: "ended" }),
					),
					port: Type.Optional(
						Type.Object(
							{ port: Type.Integer(), host: Type.Optional(Type.String({ description: "loopback" })) },
							{ additionalProperties: false },
						),
					),
					check: Type.Optional(
						Type.String({
							description: "question a small model judges once the one other condition fires (paid, capped)",
						}),
					),
				},
				{ additionalProperties: false, description: "one condition" },
			),
		),
		maxRuns: Type.Optional(Type.Integer({ description: "default 20" })),
		deadline: Type.Optional(Type.Number({ description: "seconds; until: 3600" })),
		id: Type.Optional(Type.Integer({ description: "cancel: set's id" })),
		all: Type.Optional(Type.Boolean({ description: "list: ended too; cancel: all" })),
	},
	{ additionalProperties: false },
);

type Params = TimerSetInput & { op: "set" | "list" | "cancel"; id?: number; all?: boolean };

/** Where the tool reads and writes: the shared database, this workspace and the owner session. */
export interface TimerHost {
	db: () => AgentDb;
	workspaceId: (ctx: ExtensionContext) => string;
	agent: () => string | undefined;
	now: () => number;
	/** What conditions read from the host: a file's baseline is taken through it when the timer is set. */
	deps: ConditionDeps;
	/** Before a `check` wait is set: why it may not be (off, declined, no cheaper model), or undefined. */
	checkRefusal: (ctx: ExtensionContext) => Promise<string | undefined>;
	/** After a set (with the new timer) or cancel: the session's scheduler rereads its next due time. */
	changed: (ctx: ExtensionContext, set?: TimerRow) => void;
}

export interface TimerToolDetails {
	timer?: TimerRow;
	shown?: number;
}

export function timerTool(host: TimerHost): ToolDefinition<typeof parameters, TimerToolDetails> {
	return {
		name: "timer",
		label: "Timer",
		promptSnippet: renderInstruction("tools/timer/snippet.md"),
		description:
			"Wake this session with a note (a message): once after seconds, every seconds, or once when one until condition holds (unlocked, file, item, agent, port, command, check). Survives resume.",
		parameters,
		async execute(toolCallId, params: Params, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			const { db } = host.db();
			const session = ctx.sessionManager.getSessionId();
			const now = host.now();
			if (params.op === "list") {
				const rows = timers.forSession(db, session, params.all === true);
				const text = rows.length
					? rows.map((row) => timerLine(row, now)).join("\n")
					: `No ${params.all ? "" : "active "}timers.`;
				return textResult(text, { shown: rows.length });
			}
			if (params.op === "cancel") {
				const result = cancelTimers(db, session, now, params);
				if (result.changed) host.changed(ctx);
				return textResult(result.text, result.details);
			}
			if (timers.activeCount(db, session) >= MAX_ACTIVE)
				throw new Error(`This session has ${MAX_ACTIVE} active timers, the most it may hold: cancel one first.`);
			const agent = host.agent();
			const condition = parseUntil(params.until);
			const ended = condition?.kind === "agent" ? host.deps.agentEnd(condition.name) : undefined;
			if (condition?.kind === "agent" && ended)
				throw new Error(
					`${condition.name} already ended (${ended.reason}), so there is nothing to wait for: its report reaches you without a timer. No timer was set.`,
				);
			const missing =
				condition?.kind === "item" ? condition.ref.split(",").filter((ref) => host.deps.item(ref) === undefined) : [];
			if (missing.length) throw new Error(`No backlog item ${missing.join(", ")} in this workspace. No timer was set.`);
			if (condition?.kind === "check") {
				const refusal = await host.checkRefusal(ctx);
				if (refusal) throw new Error(refusal);
			}
			const timer = timers.insert(
				db,
				timerFields(
					params,
					now,
					{
						workspaceId: host.workspaceId(ctx),
						sessionId: session,
						...(agent ? { agent } : {}),
						toolCallId,
						cwd: ctx.cwd,
					},
					host.deps,
				),
			);
			host.changed(ctx, timer);
			const caps =
				condition?.kind === "check"
					? `\nJudging is capped: ${CHECK_CAPS.perWaitChecks} judgments and $${CHECK_CAPS.perWaitUsd.toFixed(2)} per wait, $${CHECK_CAPS.perCheckUsd.toFixed(2)} per judgment, $${CHECK_CAPS.perSessionUsd.toFixed(2)} per session, 30s apart.`
					: "";
			return textResult(`Set ${timerLine(timer, now)}${caps}\nCancel it with id ${timer.id}.`, { timer });
		},
		display(input) {
			const { args } = input;
			const summary = [
				args.op,
				args.id,
				args.every !== undefined ? `every ${args.every}s` : args.after !== undefined ? `in ${args.after}s` : "",
				untilTarget(args.until),
				// oxlint-disable-next-line typescript/no-unnecessary-type-conversion -- arguments are model output, unvalidated while the call renders
				args.note ? `"${String(args.note)}"` : "",
			]
				.filter((part) => part !== undefined && part !== "")
				.join(" ");
			return textResultDisplay({ title: "Timer", ...(summary ? { summary } : {}), kind: "other", blocks: [] }, input);
		},
		renderCall(args, theme, context) {
			const until = untilTarget(args.until);
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
			return toolHeader(theme, context, "Timer", target);
		},
		renderResult(result, _options, theme, context) {
			const text = contentText(result.content);
			const [summary = "", ...rest] = text.split("\n");
			return resultBlock(theme, context, { summary, body: rest.join("\n") });
		},
	};
}

/** The active timers' ids, for a cancel that named none or a wrong one. */
const activeIds = (db: AgentDb["db"], session: string): string => {
	const ids = timers.forSession(db, session).map((row) => row.id);
	return ids.length ? `Active: ${ids.join(", ")}.` : "No timer is active.";
};

/**
 * `cancel`, as `clearTimeout`: an active timer with `id` stops, one of this session that already ended is a no-op,
 * `all` stops every active one. An id this session never set, or neither field, is an error naming the active ids.
 */
function cancelTimers(
	db: AgentDb["db"],
	session: string,
	now: number,
	params: Pick<Params, "id" | "all">,
): { text: string; details: TimerToolDetails; changed: boolean } {
	if (params.id !== undefined && params.all === true) throw new Error("cancel takes id or all, not both.");
	if (params.all === true) {
		const rows = timers.cancelAll(db, session, now);
		const text = rows.length
			? [
					`Cancelled ${rows.length} timer${rows.length === 1 ? "" : "s"}:`,
					...rows.map((row) => timerLine(row, now)),
				].join("\n")
			: "No active timers to cancel.";
		return { text, details: { shown: rows.length }, changed: rows.length > 0 };
	}
	if (params.id === undefined)
		throw new Error(`cancel needs the id set returned, or all: true. ${activeIds(db, session)}`);
	const timer = timers.cancel(db, params.id, session, now);
	if (timer) return { text: `Cancelled ${timerLine(timer, now)}`, details: { timer }, changed: true };
	const ended = timers.get(db, params.id);
	if (ended?.session_id !== session)
		throw new Error(`No timer ${params.id} in this session. ${activeIds(db, session)}`);
	return {
		text: `Timer ${ended.id} already ended, nothing to cancel: ${timerLine(ended, now)}`,
		details: { timer: ended },
		changed: false,
	};
}

/** The call's `until`, in a few words: arguments are model output and may be malformed while the call renders. */
function untilTarget(until: unknown): string {
	if (typeof until !== "object" || until === null) return "";
	try {
		const condition = parseUntil(until);
		return condition ? `until ${clip(describeCondition(condition), 80)}` : "";
	} catch {
		// Not a valid condition (yet): show only that one was named.
		return "until";
	}
}
