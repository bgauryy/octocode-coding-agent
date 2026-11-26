import path from "node:path";
import { textResultDisplay } from "../../../render/display.ts";
import { renderPrompt } from "../../../../core/prompt-template.ts";
import { StringEnum } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { type AgentDb, type TimerRow, timers } from "../../../../../../db/src/api.ts";
import type { FeatureContext, ToolDefinition } from "../../../../core/features/index.ts";
import { timedTool } from "../../../render/rows.ts";
import { resultBlock, toolHeader } from "../../../render/tool.ts";
import { notifyNote, notifyState, notifySummary, notifyTitle } from "./row.ts";
import { contentText, textResult } from "../../../shared/util.ts";
import { batchEntries } from "../../../shared/batch.ts";
import { withReason } from "../../../shared/reason.ts";
import type { ConditionDeps } from "../../../timer/conditions/types.ts";
import { CHECK_CAPS } from "../../../timer/judge.ts";
import { armUntil, parseUntil } from "../../../timer/conditions/index.ts";
import {
	listeningLine,
	MAX_ACTIVE,
	MIN_CHECK_SECONDS,
	MIN_EVERY_SECONDS,
	type TimerSetInput,
	timerFields,
	timerLine,
} from "../../../timer/model.ts";
import { cronOf, cronSetText, describeCron, nextRunAt, parseCron, settledDue } from "../../../timer/cron.ts";
import { type EventFilter, LISTEN_EVENTS, untilOfEvent } from "../../../timer/on.ts";
import type { LiveJob } from "../../../timer/job-poll.ts";
import { type NotifyAliases, normalizeNotify } from "../../../timer/normalize.ts";

const text = (description: string) => Type.Optional(Type.String({ description }));

const parameters = Type.Object(
	{
		op: StringEnum(["set", "on", "off", "list"] as const),
		note: text("What to do on the notice"),
		after: Type.Optional(Type.Number({ description: "set: notify once after N seconds" })),
		every: Type.Optional(
			Type.Number({
				description: `set: repeat every N seconds (min ${MIN_EVERY_SECONDS}); on: check interval (min ${MIN_CHECK_SECONDS})`,
			}),
		),
		event: Type.Optional(StringEnum(LISTEN_EVENTS, { description: "on: event" })),
		filter: Type.Optional(
			Type.Object(
				{
					ref: text("Item ids, comma-separated"),
					state: text("todo, ongoing, done, closed, or ready (deps done)"),
					path: Type.Optional(Type.String()),
					agent: Type.Optional(Type.String()),
					epic: text("item.changed: under this epic"),
					change: text("item.changed: kinds, comma-separated"),
					command: text("Shell command; notifies at exit 0"),
					perCoreBelow: Type.Optional(Type.Number({ description: "machine.load: load per core below this" })),
					perCoreAbove: Type.Optional(Type.Number({ description: "machine.load: load per core above this" })),
					for: Type.Optional(Type.Integer({ description: "machine.load: samples in a row (1)" })),
				},
				{ additionalProperties: false },
			),
		),
		check: text("on: a small model judges"),
		cron: text("set: 5-field local cron; replaces after/every"),
		tz: text("cron: IANA zone"),
		once: Type.Optional(Type.Boolean({ description: "on: first notice only; false: keep listening" })),
		maxRuns: Type.Optional(Type.Integer({ description: "Stop after N notices (20)" })),
		deadline: Type.Optional(Type.Number({ description: "Seconds to expiry (on: 3600)" })),
		id: Type.Optional(Type.Integer({ description: "off: notify id" })),
		all: Type.Optional(Type.Boolean({ description: "list: with ended; off: every one" })),
		items: Type.Optional(
			Type.Unsafe<object[]>({
				type: "array",
				items: { type: "object" },
				description: "batch entries",
			}),
		),
	},
	{ additionalProperties: false },
);

/**
 * What a call is validated against: the declared fields, with each `items` entry held to the single call's fields, so a
 * batch is checked as strictly as one call while the declared schema stays short.
 */
const validation = (() => {
	const { op: _op, items: _items, ...declared } = parameters.properties;
	// Shapes models send for declared fields: accepted here and mapped by `normalizeNotify`, so the declared schema stays short.
	const single = {
		...declared,
		delay: Type.Optional(Type.Number()),
		seconds: Type.Optional(Type.Number()),
		interval: Type.Optional(Type.Number()),
		filter: Type.Optional(
			Type.Object(
				{
					...(declared.filter as unknown as { properties: Record<string, never> }).properties,
					job: Type.Optional(Type.String()),
					name: Type.Optional(Type.String()),
				},
				{ additionalProperties: false },
			),
		),
	};
	return withReason(
		Type.Object(
			{
				...single,
				op: parameters.properties.op,
				items: Type.Optional(Type.Array(Type.Object(single, { additionalProperties: false }), { minItems: 1 })),
			},
			{ additionalProperties: false },
		),
	);
})();

type Params = Omit<TimerSetInput, "until"> &
	NotifyAliases & {
		op: "set" | "on" | "off" | "list";
		event?: string;
		filter?: EventFilter;
		check?: string;
		id?: number;
		all?: boolean;
		/** set, on or off: several entries of the single-call fields, each run as its own call. */
		items?: object[];
	};

/** Where the tool reads and writes: the shared database, this workspace and the owner session. */
export interface TimerHost {
	db: () => AgentDb;
	workspaceId: (ctx: FeatureContext) => string;
	agent: () => string | undefined;
	now: () => number;
	/** What conditions read from the host: `set` asks it whether a named agent ended or an item exists. */
	deps: ConditionDeps;
	/** Before a `check` wait is set: why it may not be (off, declined, no cheaper model), or undefined. */
	checkRefusal: (ctx: FeatureContext) => Promise<string | undefined>;
	/** The background jobs whose end wakes the session: `on` refuses a command that polls one. Omitted: none. */
	jobs?: (ctx: FeatureContext) => readonly LiveJob[];
	/** The names of the running children, for an `agent.ended` that names none. Omitted: none. */
	children?: () => readonly string[];
	/** What wakes the session without a wait (its running children and background jobs), one line, or empty. */
	implicit: () => string;
	/** Before a cron wait is set: why it may not be (subagent, no screen to confirm, declined), or undefined; asks the user once per session. */
	cronRefusal: (ctx: FeatureContext, schedule: string, firstRun: number) => Promise<string | undefined>;
	/** Spend this session may add through cron waits, in USD, for the text `set` answers with. */
	cronCap: () => number;
	/** The session's cost so far in USD: a cron wait's spending is counted from it. */
	sessionUsd: (ctx: FeatureContext) => number;
	/** After a set (with the new timer) or off: the session's scheduler rereads its next due time. */
	changed: (ctx: FeatureContext, set?: TimerRow) => void;
}

export interface TimerToolDetails {
	timer?: TimerRow;
	shown?: number;
}

export function timerTool(host: TimerHost): ToolDefinition<typeof parameters, TimerToolDetails> {
	/** One set, on or off: the checks each kind of wait needs, then its row; off cancels. */
	async function write(sent: Params, toolCallId: string, signal: AbortSignal | undefined, ctx: FeatureContext) {
		signal?.throwIfAborted();
		const meant = sent.op === "off" ? undefined : normalizeNotify(sent, host.children?.() ?? []);
		if (meant?.kind === "implicit")
			return textResult(
				`You are already notified when ${meant.job} ends, with its exit and log: nothing was set. Keep working or end your turn.`,
				{},
			);
		const params = (meant?.params ?? sent) as Params;
		const { db } = host.db();
		const session = ctx.sessionManager.getSessionId();
		const now = host.now();
		if (params.op === "off") {
			const result = cancelTimers(db, session, now, params);
			if (result.changed) host.changed(ctx);
			return textResult(result.text, result.details);
		}
		const listening = params.op === "on";
		if (!listening && [params.event, params.filter, params.check].some((value) => value !== undefined))
			throw new Error("event, filter and check belong to on; set wakes after or every seconds.");
		const given = listening
			? untilOfEvent(params.event, params.filter, params.check, { jobs: host.jobs?.(ctx) ?? [], cwd: ctx.cwd })
			: undefined;
		const backlog = host.deps.backlog;
		// A backlog wait hears only what changes after it starts: the audit cursor of this moment is stored in it.
		const until = given && backlog ? armUntil(given, () => backlog.head()) : given;
		if (timers.activeCount(db, session) >= MAX_ACTIVE)
			throw new Error(`This session has ${MAX_ACTIVE} active notifications, the most it may hold: turn one off first.`);
		const agent = host.agent();
		const condition = parseUntil(until);
		const ended = condition?.kind === "agent" ? host.deps.agentEnd(condition.name) : undefined;
		if (condition?.kind === "agent" && ended)
			throw new Error(
				`${condition.name} already ended (${ended.reason}), so there is nothing to ask for: you are already notified when it ends. Nothing was set.`,
			);
		const missing =
			condition?.kind === "item" ? condition.ref.split(",").filter((ref) => host.deps.item(ref) === undefined) : [];
		if (missing.length) throw new Error(`No backlog item ${missing.join(", ")} in this workspace. Nothing was set.`);
		if (condition?.kind === "landed" && host.deps.item(condition.ref) === undefined)
			throw new Error(`No backlog item ${condition.ref} in this workspace. Nothing was set.`);
		if (condition?.kind === "changed") {
			const unknown = condition.ref?.split(",").filter((ref) => host.deps.item(ref) === undefined) ?? [];
			if (unknown.length) throw new Error(`No backlog item ${unknown.join(", ")} in this workspace. Nothing was set.`);
			if (params.once === false)
				throw new Error("item.changed wakes once: set it again after each wake, from the cursor you read then.");
		}
		if (
			condition?.kind === "landed" &&
			condition.path !== undefined &&
			host.deps.reservation(path.resolve(ctx.cwd, condition.path), condition.path) === undefined
		)
			throw new Error(
				`No other agent reserves ${condition.path}, so its release would notify you at once: drop path and ask about the item. Nothing was set.`,
			);
		if (condition?.kind === "check") {
			const refusal = await host.checkRefusal(ctx);
			if (refusal) throw new Error(refusal);
		}
		if (params.cron !== undefined) {
			const spec = parseCron(params.cron, params.tz, now);
			const refusal = await host.cronRefusal(ctx, describeCron(spec), nextRunAt(spec, 0, now) ?? now);
			if (refusal) throw new Error(refusal);
		}
		signal?.throwIfAborted();
		const inserted = timers.insert(
			db,
			timerFields({ ...params, ...(until ? { until } : {}) }, now, {
				workspaceId: host.workspaceId(ctx),
				sessionId: session,
				...(agent ? { agent } : {}),
				toolCallId,
				cwd: ctx.cwd,
				...(params.cron !== undefined ? { sessionUsd: host.sessionUsd(ctx) } : {}),
			}),
		);
		const spec = cronOf(inserted);
		if (spec) timers.reschedule(db, inserted.id, settledDue(inserted, now));
		const timer = spec ? (timers.get(db, inserted.id) ?? inserted) : inserted;
		host.changed(ctx, timer);
		const caps =
			condition?.kind === "check"
				? `\nJudging is capped: ${CHECK_CAPS.perWaitChecks} judgments and $${CHECK_CAPS.perWaitUsd.toFixed(2)} per request, $${CHECK_CAPS.perCheckUsd.toFixed(2)} per judgment, $${CHECK_CAPS.perSessionUsd.toFixed(2)} per session, 30s apart.`
				: "";
		const head = spec
			? cronSetText(timer, spec, now, host.cronCap())
			: listening
				? listeningLine(timer, now)
				: `Set ${timerLine(timer, now)}`;
		return textResult(`${head}${caps}`, { timer });
	}

	return timedTool({
		name: "notify",
		label: "Notify",
		promptSnippet: renderPrompt("tools/notify/snippet.md"),
		description:
			"Receive scheduled or event notices. set a delay or interval in seconds, or a cron; repeats run until off. on filters by agent, item, path, load or check result. filter.command polls free and notifies on exit 0. check calls a paid model each time. list shows notices; off cancels by id.",
		parameters,
		validationParameters: validation,
		async execute(toolCallId, params: Params, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			if (params.op === "list") {
				const { db } = host.db();
				const session = ctx.sessionManager.getSessionId();
				const now = host.now();
				const rows = timers.forSession(db, session, params.all === true);
				const implicit = host.implicit();
				const text = [
					rows.length
						? rows.map((row) => timerLine(row, now)).join("\n")
						: `No ${params.all ? "" : "active "}notifications.`,
					...(implicit ? [`You are notified without asking: ${implicit}`] : []),
				].join("\n");
				return textResult(text, { shown: rows.length });
			}
			const { items, op, ...shared } = params;
			if (items === undefined) return write(params, toolCallId, signal, ctx);
			if (Object.values(shared).some((value) => value !== undefined))
				throw new Error("items carries each entry's fields: move the others into the entries.");
			const batch = await batchEntries(
				items,
				(entry, index) => ("id" in entry && typeof entry.id === "number" ? `notify ${entry.id}` : `items[${index}]`),
				(entry) => write({ ...(entry as Omit<Params, "op">), op }, toolCallId, signal, ctx),
				{ operation: op, verb: op === "off" ? "Cancelled" : "Set", signal },
			);
			return textResult<TimerToolDetails>(contentText(batch.content), {});
		},
		display(input) {
			const { args, status } = input;
			const summary = [notifySummary(args), notifyNote(args, 200)].filter(Boolean).join(" ");
			const state = notifyState(args, status === "failed");
			return textResultDisplay(
				{
					title: notifyTitle(args),
					...(summary ? { summary } : {}),
					kind: "other",
					...(state ? { state } : {}),
					blocks: [],
				},
				input,
			);
		},
		renderCall(args, theme, context) {
			const target = [notifySummary(args), notifyNote(args, 80)].filter(Boolean).join(" ");
			const state = notifyState(args, context.isError);
			return toolHeader(theme, context, notifyTitle(args), target, state ? { state } : {});
		},
		renderResult(result, _options, theme, context) {
			const text = contentText(result.content);
			const [summary = "", ...rest] = text.split("\n");
			return resultBlock(theme, context, { summary, body: rest.join("\n") });
		},
	});
}

/** The active waits' ids, for an off that named none or a wrong one. */
const activeIds = (db: AgentDb["db"], session: string): string => {
	const ids = timers.forSession(db, session).map((row) => row.id);
	return ids.length ? `Active: ${ids.join(", ")}.` : "Nothing is active.";
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
					`Cancelled ${rows.length} notification${rows.length === 1 ? "" : "s"}:`,
					...rows.map((row) => timerLine(row, now)),
				].join("\n")
			: "No active notifications to turn off.";
		return { text, details: { shown: rows.length }, changed: rows.length > 0 };
	}
	if (params.id === undefined)
		throw new Error(`off needs the id that set or on returned, or all: true. ${activeIds(db, session)}`);
	const timer = timers.cancel(db, params.id, session, now);
	if (timer) return { text: `Cancelled ${timerLine(timer, now)}`, details: { timer }, changed: true };
	const ended = timers.get(db, params.id);
	if (ended?.session_id !== session)
		throw new Error(`No notification ${params.id} in this session. ${activeIds(db, session)}`);
	return {
		text: `Notification ${ended.id} already ended, nothing to turn off: ${timerLine(ended, now)}`,
		details: { timer: ended },
		changed: false,
	};
}
