import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { type AgentDb, type TimerRow, timers } from "../../../../db/src/api.ts";
import type { CommandContext } from "../../core/features/index.ts";
import { builtinDescription } from "../../core/slash-commands.ts";
import { formatClock, formatSpan } from "../shared/format.ts";
import { say, type Subcommand, wordCompletions } from "../shared/commands.ts";
import { cronOf, cronSummary, settledDue } from "./cron.ts";
import { MAX_ACTIVE, timerFields } from "./model.ts";

/** What `/cron` and `/loop` read and write: the shared database and the session that typed the command. */
export interface CronCommandHost {
	db: () => AgentDb;
	workspaceId: (ctx: CommandContext) => string;
	agent: () => string | undefined;
	now: () => number;
	sessionUsd: (ctx: CommandContext) => number;
	cap: () => number;
	/** After a timer was added or removed: the scheduler rereads its next due time. */
	changed: (ctx: CommandContext, row?: TimerRow) => void;
}

const cronRows = (db: AgentDb["db"], session: string) =>
	timers.forSession(db, session).filter((row) => cronOf(row) !== undefined);

/** The closest of `steps` to `wanted`, the smaller first on a tie. */
const nearest = (steps: readonly number[], wanted: number): number =>
	steps.reduce((best, step) => (Math.abs(step - wanted) < Math.abs(best - wanted) ? step : best));

const MINUTE_STEPS = [5, 6, 10, 12, 15, 20, 30];
const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12];

/**
 * The cron schedule that runs every `amount` minutes, hours or days. A step that does not divide its unit evenly (7 minutes,
 * 5 hours) would drift at the unit's end, so it becomes the nearest even one: the caller says which it chose.
 */
export function loopSchedule(amount: number, unit: "m" | "h" | "d"): { cron: string; every: string } {
	if (unit === "m" && amount >= 60) return loopSchedule(Math.round(amount / 60), "h");
	if (unit === "m") {
		const step = nearest(MINUTE_STEPS, amount);
		return { cron: `*/${step} * * * *`, every: `${step}m` };
	}
	if (unit === "h" && amount >= 24) return loopSchedule(Math.round(amount / 24), "d");
	if (unit === "h") {
		const step = nearest(HOUR_STEPS, amount);
		return { cron: step === 1 ? "0 * * * *" : `0 */${step} * * *`, every: `${step}h` };
	}
	const days = Math.min(Math.max(amount, 1), 28);
	return { cron: days === 1 ? "0 0 * * *" : `0 0 */${days} * *`, every: `${days}d` };
}

/** `/cron`: this session's scheduled tasks, and deleting one. */
export function cronCommand(host: CronCommandHost): Subcommand {
	return {
		description: builtinDescription("cron"),
		argumentHint: "[list|delete <id>]",
		complete: (prefix) => wordCompletions(["list", "delete"], prefix),
		async handler(args, ctx) {
			const session = ctx.sessionManager.getSessionId();
			const { db } = host.db();
			const [verb = "list", ...rest] = args.split(/\s+/).filter(Boolean);
			if (verb === "list") {
				const rows = cronRows(db, session);
				if (rows.length === 0) return say(ctx, "No scheduled tasks. Ask for one, or use /loop <interval> <prompt>.");
				const now = host.now();
				return say(
					ctx,
					rows
						.map((row) => {
							// The run it is on, as /jobs, the footer and the team panel count it.
							return `#${row.id} ${cronSummary(row, cronOf(row)!)} · next in ${formatSpan(row.due_at - now)} · ${row.note.split("\n", 1)[0]}`;
						})
						.join("\n"),
				);
			}
			const id = Number(rest[0]?.replace(/^#/, ""));
			if (verb !== "delete" || rest.length !== 1 || !Number.isInteger(id))
				return say(ctx, "Usage: /cron [list|delete <id>]", "warning");
			const row = timers.get(db, id);
			if (!row || cronOf(row) === undefined || row.session_id !== session)
				return say(ctx, `No scheduled task #${id} in this session.`, "warning");
			if (!timers.cancel(db, id, session, host.now())) return say(ctx, `#${id} already ended.`);
			host.changed(ctx);
			say(ctx, `Deleted scheduled task #${id}.`);
		},
	};
}

/**
 * What `/loop` answers, in the user's words: the task, when it runs next, what ends it and the command that stops it.
 * (The `notify` tool's reply, `cronSetText`, names the tool's own fields for the model.)
 */
function loopSetText(row: TimerRow, typed: string, every: string, now: number, cap: number): string {
	const ends = new Date(row.deadline_at ?? row.due_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
	const runs = row.max_runs === null ? "" : `after ${row.max_runs} runs, `;
	const rounded =
		typed === every
			? ""
			: ` (${typed} rounded: a loop runs at least 5m apart, on a step that divides the hour or day evenly)`;
	return [
		`Every ${every}${rounded}: Scheduled task #${row.id} sends "${row.note.split("\n", 1)[0]}" once this session is idle;`,
		`next in ${formatSpan(row.due_at - now)} (${formatClock(row.due_at).slice(0, 5)}).`,
		`It stops ${runs}on ${ends}, or once this session spends $${cap.toFixed(2)}. /cron delete ${row.id} stops it now.`,
	].join(" ");
}

const LOOP_USAGE = "Usage: /loop <interval> <prompt>";

/**
 * The interval and prompt of `/loop` arguments, or the warning that says what is wrong with them: an interval is a whole
 * number of minutes, hours or days (`10m`, `2h`, `1d`) and the prompt is the rest of the line.
 */
function loopArgs(args: string): { amount: number; unit: "m" | "h" | "d"; typed: string; prompt: string } | string {
	const [, typed = "", rest = ""] = /^(\S*)\s*([\s\S]*)$/.exec(args.trim()) ?? [];
	if (!typed) return `${LOOP_USAGE}, the interval a number and m, h or d (10m, 2h, 1d)`;
	const interval = /^([1-9]\d*)([mhd])$/.exec(typed);
	if (!interval)
		return `"${typed}" is not an interval: use a number and m, h or d, such as 10m, 2h or 1d. ${LOOP_USAGE}`;
	if (!rest.trim()) return `/loop ${typed} needs a prompt to run. ${LOOP_USAGE}`;
	return { amount: Number(interval[1]), unit: interval[2] as "m" | "h" | "d", typed, prompt: rest.trim() };
}

/**
 * `/loop <interval> <prompt>`: a scheduled task that runs the prompt every interval. The user typed it, so it asks no
 * question (the consent dialog is for schedules the agent sets); its reply names the schedule, its end and the spend cap.
 */
export function loopCommand(host: CronCommandHost): Subcommand {
	return {
		description: builtinDescription("loop"),
		argumentHint: "<interval> <prompt>",
		async handler(args, ctx) {
			const parsed = loopArgs(args);
			if (typeof parsed === "string") return say(ctx, parsed, "warning");
			const session = ctx.sessionManager.getSessionId();
			const { db } = host.db();
			if (timers.activeCount(db, session) >= MAX_ACTIVE)
				return say(
					ctx,
					`This session already has ${MAX_ACTIVE} active notifications, the most it may hold: delete one first.`,
					"warning",
				);
			const schedule = loopSchedule(parsed.amount, parsed.unit);
			const now = host.now();
			const agent = host.agent();
			let inserted: TimerRow;
			try {
				inserted = timers.insert(
					db,
					timerFields({ cron: schedule.cron, note: parsed.prompt }, now, {
						workspaceId: host.workspaceId(ctx),
						sessionId: session,
						...(agent ? { agent } : {}),
						cwd: ctx.cwd,
						sessionUsd: host.sessionUsd(ctx),
					}),
				);
			} catch (error) {
				return say(ctx, errorMessage(error), "warning");
			}
			timers.reschedule(db, inserted.id, settledDue(inserted, now));
			const row = timers.get(db, inserted.id) ?? inserted;
			host.changed(ctx, row);
			say(ctx, loopSetText(row, parsed.typed, schedule.every, now, host.cap()));
		},
	};
}
