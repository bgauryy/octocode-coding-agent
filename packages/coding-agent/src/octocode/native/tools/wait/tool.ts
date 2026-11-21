import path from "node:path";
import { textResultDisplay } from "../../../render/display.ts";
import { renderPrompt } from "../../../../core/prompt-template.ts";
import { StringEnum } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { type AgentDb, type TimerRow, timers } from "../../../../../../db/src/api.ts";
import type { FeatureContext, ToolDefinition } from "../../../../core/features/index.ts";
import { resultBlock, toolHeader } from "../../../render/tool.ts";
import { clip } from "../../../shared/text.ts";
import { contentText, textResult } from "../../../shared/util.ts";
import { batchEntries } from "../../../shared/batch.ts";
import { withReason } from "../../../shared/reason.ts";
import type { ConditionDeps } from "../../../timer/conditions/types.ts";
import { CHECK_CAPS } from "../../../timer/judge.ts";
import { armUntil, describeCondition, parseUntil } from "../../../timer/conditions/index.ts";
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

const text = (description: string) => Type.Optional(Type.String({ description }));

const parameters = Type.Object(
	{
		op: StringEnum(["set", "on", "off", "list"] as const),
		note: text("set/on: what to do on waking (required)"),
		after: Type.Optional(Type.Number({ description: "set: wake once after N seconds" })),
		every: Type.Optional(
			Type.Number({
				description: `set: repeat every N seconds (min ${MIN_EVERY_SECONDS}); on: event check interval (min ${MIN_CHECK_SECONDS})`,
			}),
		),
		event: Type.Optional(StringEnum(LISTEN_EVENTS, { description: "on: event" })),
		filter: Type.Optional(
			Type.Object(
				{
					ref: text("Item ids, comma-separated; any matches"),
					state: text("todo, ongoing, done, closed, or ready (deps done)"),
					path: Type.Optional(Type.String()),
					agent: Type.Optional(Type.String()),
					epic: text("item.changed: items under this epic"),
					change: text("item.changed: kinds, comma-separated; omit: any"),
					command: text("Shell command; the wake fires when it exits 0"),
				},
				{ additionalProperties: false },
			),
		),
		check: text("on: judged on the event (paid); omit: filter.command alone (free)"),
		cron: text("set: 5-field local-time cron; replaces after/every"),
		tz: text("set with cron: IANA zone, e.g. Europe/Paris"),
		once: Type.Optional(Type.Boolean({ description: "on: first wake only (default); false keeps listening" })),
		maxRuns: Type.Optional(Type.Integer({ description: "Stop after N wakes (default 20)" })),
		deadline: Type.Optional(Type.Number({ description: "Seconds to expiry (on: default 3600)" })),
		id: Type.Optional(Type.Integer({ description: "off: wait id (see list)" })),
		all: Type.Optional(Type.Boolean({ description: "list: include ended; off: remove all" })),
		items: Type.Optional(
			Type.Unsafe<object[]>({
				type: "array",
				items: { type: "object" },
				description: "set/on/off: batch entries",
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
	const { op: _op, items: _items, ...single } = parameters.properties;
	return withReason(
		Type.Object(
			{
				...parameters.properties,
				items: Type.Optional(Type.Array(Type.Object(single, { additionalProperties: false }), { minItems: 1 })),
			},
			{ additionalProperties: false },
		),
	);
})();

type Params = Omit<TimerSetInput, "until"> & {
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
	async function write(params: Params, toolCallId: string, signal: AbortSignal | undefined, ctx: FeatureContext) {
		signal?.throwIfAborted();
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
		const given = listening ? untilOfEvent(params.event, params.filter, params.check) : undefined;
		const backlog = host.deps.backlog;
		// A backlog wait hears only what changes after it starts: the audit cursor of this moment is stored in it.
		const until = given && backlog ? armUntil(given, () => backlog.head()) : given;
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
				`No other agent reserves ${condition.path}, so its release would meet this wait at once: drop path and wait on the item. Nothing was set.`,
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
				? `\nJudging is capped: ${CHECK_CAPS.perWaitChecks} judgments and $${CHECK_CAPS.perWaitUsd.toFixed(2)} per wait, $${CHECK_CAPS.perCheckUsd.toFixed(2)} per judgment, $${CHECK_CAPS.perSessionUsd.toFixed(2)} per session, 30s apart.`
				: "";
		const head = spec
			? cronSetText(timer, spec, now, host.cronCap())
			: listening
				? listeningLine(timer, now)
				: `Set ${timerLine(timer, now)}`;
		return textResult(`${head}${caps}`, { timer });
	}

	return {
		name: "wait",
		label: "Wait",
		promptSnippet: renderPrompt("tools/wait/snippet.md"),
		description:
			"Wake with a note. set: a clock (after/every seconds, cron; repeats blind). on: an event (once:false repeats), filter keys: agent.ended agent; item.state ref+state; item.changed ref|epic|path; peer.landed ref; path.unlocked path; check.result command. Free: filter.command (`test -e path`) wakes at exit 0: poll with it. Paid: check, a question a small model judges. off by id; list shows what wakes you unasked.",
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
					rows.length ? rows.map((row) => timerLine(row, now)).join("\n") : `No ${params.all ? "" : "active "}waits.`,
					...(implicit ? [`Wake you without a wait: ${implicit}`] : []),
				].join("\n");
				return textResult(text, { shown: rows.length });
			}
			const { items, op, ...shared } = params;
			if (items === undefined) return write(params, toolCallId, signal, ctx);
			if (Object.values(shared).some((value) => value !== undefined))
				throw new Error("items carries each entry's fields: move the others into the entries.");
			const batch = await batchEntries(
				items,
				(entry, index) => ("id" in entry && typeof entry.id === "number" ? `wait ${entry.id}` : `items[${index}]`),
				(entry) => write({ ...(entry as Omit<Params, "op">), op }, toolCallId, signal, ctx),
				{ operation: op, verb: op === "off" ? "Cancelled" : "Set", signal },
			);
			return textResult<TimerToolDetails>(contentText(batch.content), {});
		},
		display(input) {
			const { args } = input;
			const summary = [
				args.op,
				args.id,
				args.cron !== undefined
					? `cron ${cronText(args.cron)}`
					: args.every !== undefined
						? `every ${args.every}s`
						: args.after !== undefined
							? `in ${args.after}s`
							: "",
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
				args.cron !== undefined
					? `cron ${cronText(args.cron)}`
					: args.every !== undefined
						? `every ${args.every}s`
						: args.after !== undefined
							? `in ${args.after}s`
							: "",
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

/** The call's schedule in a few words: arguments are model output and may be malformed while the call renders. */
const cronText = (value: unknown): string => (typeof value === "string" ? clip(value, 40) : "");

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
