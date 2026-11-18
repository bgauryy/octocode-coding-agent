import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { type AgentDb, type TimerRow, timers } from "../../../../db/src/api.ts";
import type { CommandContext } from "../../core/features/index.ts";
import { builtinDescription } from "../../core/slash-commands.ts";
import { formatSpan } from "../shared/format.ts";
import { say, type Subcommand, wordCompletions } from "../shared/commands.ts";
import { cronOf, cronSetText, describeCron, settledDue } from "./cron.ts";
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
							const spec = cronOf(row)!;
							return `#${row.id} cron ${describeCron(spec)} · next in ${formatSpan(row.due_at - now)} · run ${row.runs}/${row.max_runs ?? "∞"} · ${row.note.split("\n", 1)[0]}`;
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

/** `/loop <interval> <prompt>`: a scheduled task that runs the prompt every interval, set by the user, so with no further confirmation. */
export function loopCommand(host: CronCommandHost): Subcommand {
	return {
		description: builtinDescription("loop"),
		argumentHint: "<5m|1h|1d> <prompt>",
		async handler(args, ctx) {
			const match = /^(\d+)([mhd])\s+(\S[\s\S]*)$/.exec(args);
			if (!match) return say(ctx, "Usage: /loop <interval such as 10m, 2h or 1d> <prompt>", "warning");
			const session = ctx.sessionManager.getSessionId();
			const { db } = host.db();
			if (timers.activeCount(db, session) >= MAX_ACTIVE)
				return say(
					ctx,
					`This session already has ${MAX_ACTIVE} active waits, the most it may hold: delete one first.`,
					"warning",
				);
			const schedule = loopSchedule(Number(match[1]), match[2] as "m" | "h" | "d");
			const now = host.now();
			const agent = host.agent();
			let inserted: TimerRow;
			try {
				inserted = timers.insert(
					db,
					timerFields({ cron: schedule.cron, note: match[3].trim() }, now, {
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
			say(ctx, `Every ${schedule.every}: ${cronSetText(row, cronOf(row)!, now, host.cap())}`);
		},
	};
}
