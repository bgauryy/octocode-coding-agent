import { renderInstruction } from "../../core/prompt-template.ts";
import { StringEnum } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { type AgentDb, type TimerRow, timers } from "../../../../db/src/api.ts";
import type { ExtensionContext, ToolDefinition } from "../../core/features/index.ts";
import { resultBlock, toolHeader } from "../shared/render.ts";
import { clip } from "../shared/render/text.ts";
import { contentText, textResult } from "../shared/util.ts";
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
				},
				{ additionalProperties: false },
			),
		),
		maxRuns: Type.Optional(Type.Integer({ description: "default 20" })),
		deadline: Type.Optional(Type.Number({ description: "seconds; until: 3600" })),
		id: Type.Optional(Type.Integer({ description: "cancel" })),
		all: Type.Optional(Type.Boolean({ description: "list: ended too" })),
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
			"Wake this session with a note (arrives as a message): once after seconds, every seconds, or once until holds. Survives resume.",
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
				if (params.id === undefined) throw new Error("cancel needs the timer's id (timer list shows it).");
				const timer = timers.cancel(db, params.id, session, now);
				if (!timer) throw new Error(`No active timer ${params.id} in this session.`);
				host.changed(ctx);
				return textResult(`Cancelled ${timerLine(timer, now)}`, { timer });
			}
			if (timers.activeCount(db, session) >= MAX_ACTIVE)
				throw new Error(`This session has ${MAX_ACTIVE} active timers, the most it may hold: cancel one first.`);
			const agent = host.agent();
			const timer = timers.insert(
				db,
				timerFields(params, now, {
					workspaceId: host.workspaceId(ctx),
					sessionId: session,
					...(agent ? { agent } : {}),
					toolCallId,
					cwd: ctx.cwd,
				}),
			);
			host.changed(ctx, timer);
			return textResult(`Set ${timerLine(timer, now)}`, { timer });
		},
		renderCall(args, theme, context) {
			const until = args.until?.unlocked ? `until ${args.until.unlocked} unlocked` : args.until?.command ? "until" : "";
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
