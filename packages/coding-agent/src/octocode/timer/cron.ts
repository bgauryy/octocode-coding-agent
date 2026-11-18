import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { Cron } from "croner";
import type { NewTimer, TimerRow } from "../../../../db/src/api.ts";
import { renderPrompt } from "../../core/prompt-template.ts";
import { formatSpan } from "../shared/format.ts";

const MINUTE_MS = 60_000;
/** The closest two runs of a cron schedule may be: a run is a model turn. */
export const MIN_CRON_INTERVAL_MS = 5 * MINUTE_MS;
/** How long a cron timer lives without a `deadline` of its own. */
export const CRON_EXPIRY_SECONDS = 7 * 24 * 3600;
/** Runs of a cron timer without its own maxRuns. */
const CRON_DEFAULT_MAX_RUNS = 20;
/** The most a run may be delayed to spread many sessions' `:00` runs apart. */
const MAX_JITTER_MS = 30 * MINUTE_MS;
/** How many upcoming runs are compared to find the closest two. */
const GAP_WINDOW = 60;

/** A cron schedule as stored in the row's `baseline`: five fields, an optional IANA zone (local when absent), and the session cost when it was set. */
export interface CronSpec {
	expr: string;
	tz?: string;
	usd: number;
}

const fail = (file: string, values: Record<string, string | number> = {}): never => {
	throw new Error(renderPrompt(`notices/timer/${file}.md`, values));
};

const evaluator = (spec: Pick<CronSpec, "expr" | "tz">): Cron =>
	new Cron(spec.expr, { paused: true, mode: "5-part", ...(spec.tz ? { timezone: spec.tz } : {}) });

/** The schedule stored in `row`, or undefined for any other timer. Only cron rows keep JSON in `baseline` of an `every` row. */
export function cronOf(row: Pick<TimerRow, "kind" | "baseline">): CronSpec | undefined {
	if (row.kind !== "every" || !row.baseline?.startsWith("{")) return undefined;
	const value: unknown = JSON.parse(row.baseline);
	if (typeof value !== "object" || value === null || typeof (value as { cron?: unknown }).cron !== "string")
		return undefined;
	const stored = value as { cron: string; tz?: unknown; usd?: unknown };
	return {
		expr: stored.cron,
		...(typeof stored.tz === "string" ? { tz: stored.tz } : {}),
		usd: typeof stored.usd === "number" ? stored.usd : 0,
	};
}

const encode = (spec: CronSpec): string =>
	JSON.stringify({ cron: spec.expr, ...(spec.tz ? { tz: spec.tz } : {}), usd: spec.usd });

/** `0 9 * * 1-5`, or with its zone: `0 9 * * 1-5 Europe/Paris`. */
export const describeCron = (spec: Pick<CronSpec, "expr" | "tz">): string =>
	spec.tz ? `${spec.expr} ${spec.tz}` : spec.expr;

/** The first mark of the schedule strictly after `after` (epoch ms), or undefined when it has none. */
export function nextMark(spec: Pick<CronSpec, "expr" | "tz">, after: number): number | undefined {
	return evaluator(spec).nextRun(new Date(after))?.getTime();
}

function hash(text: string): number {
	let value = 0x811c9dc5;
	for (let index = 0; index < text.length; index++) value = Math.imul(value ^ text.charCodeAt(index), 0x01000193);
	return value >>> 0;
}

/** How late job `id` runs after a mark whose next mark is `period` away: fixed per job, up to half the period and 30 minutes, and none when the period is the minimum. */
export function jitterMs(id: number, period: number): number {
	if (period <= MIN_CRON_INTERVAL_MS) return 0;
	return hash(String(id)) % Math.floor(Math.min(period / 2, MAX_JITTER_MS));
}

/** When job `id` next runs after `after`: the next mark and its jitter. */
export function nextRunAt(spec: Pick<CronSpec, "expr" | "tz">, id: number, after: number): number | undefined {
	const mark = nextMark(spec, after);
	if (mark === undefined) return undefined;
	const following = nextMark(spec, mark);
	return mark + (following === undefined ? 0 : jitterMs(id, following - mark));
}

/** Checks the expression and zone; returns the spec to store. Throws, with the reason in text for the model, when it is not usable. */
export function parseCron(expr: unknown, tz: unknown, now: number, usd = 0): CronSpec {
	if (typeof expr !== "string") return fail("cron-invalid", { expr: String(expr), why: "it is not text." });
	const text = expr.trim().replace(/\s+/g, " ");
	const fields = text.split(" ");
	if (fields.length !== 5)
		return fail("cron-invalid", { expr: text, why: `it has ${fields.length} field${fields.length === 1 ? "" : "s"}.` });
	const bad = fields.find((field) => !/^[\d*,/-]+$/.test(field));
	if (bad !== undefined)
		return fail("cron-invalid", { expr: text, why: `\`${bad}\` uses characters other than digits and \`*,-/\`.` });
	if (tz !== undefined && (typeof tz !== "string" || tz.trim() === ""))
		return fail("cron-zone", { tz: JSON.stringify(tz) });
	const zone = typeof tz === "string" ? tz.trim() : undefined;
	if (zone !== undefined) {
		try {
			new Intl.DateTimeFormat("en", { timeZone: zone });
		} catch {
			// Not an IANA zone: the model is told to name one.
			return fail("cron-zone", { tz: zone });
		}
	}
	const spec: CronSpec = { expr: text, ...(zone ? { tz: zone } : {}), usd };
	let runs: Date[];
	try {
		runs = evaluator(spec).nextRuns(GAP_WINDOW, new Date(now));
	} catch (error) {
		return fail("cron-invalid", { expr: text, why: `${errorMessage(error)}.` });
	}
	if (runs.length === 0) return fail("cron-never", { expr: text });
	let closest = Infinity;
	for (let index = 1; index < runs.length; index++)
		closest = Math.min(closest, runs[index].getTime() - runs[index - 1].getTime());
	if (closest < MIN_CRON_INTERVAL_MS)
		return fail("cron-too-frequent", {
			expr: text,
			gap: formatSpan(closest),
			minutes: MIN_CRON_INTERVAL_MS / MINUTE_MS,
		});
	return spec;
}

/** The `set` arguments a cron timer takes. */
export interface CronInput {
	cron?: string;
	tz?: string;
	note?: string;
	after?: number;
	every?: number;
	until?: unknown;
	once?: boolean;
	maxRuns?: number;
}

/**
 * The stored fields of a cron timer: an `every` row whose `interval_ms` is the schedule's period (at least the minimum, so
 * a build that does not know cron reads it as a slow interval), `baseline` the schedule, `deadline_at` its expiry. Its first
 * due time uses id 0 for jitter: `settleCron` places it by the id the insert returned. `deadline` is validated seconds.
 */
export function cronFields(
	input: CronInput,
	now: number,
	deadline: number | undefined,
	base: Pick<NewTimer, "workspaceId" | "sessionId" | "agent" | "toolCallId" | "note" | "at">,
	usd: number,
): NewTimer {
	if (input.cron === undefined) return fail("cron-tz-alone");
	if (input.after !== undefined || input.every !== undefined || input.until !== undefined || input.once !== undefined)
		return fail("cron-conflict");
	const spec = parseCron(input.cron, input.tz, now, usd);
	const first = nextRunAt(spec, 0, now);
	const mark = nextMark(spec, now);
	const following = mark === undefined ? undefined : nextMark(spec, mark);
	if (first === undefined) return fail("cron-never", { expr: spec.expr });
	return {
		...base,
		kind: "every",
		dueAt: first,
		intervalMs: Math.max(MIN_CRON_INTERVAL_MS, following === undefined ? 0 : following - mark!),
		maxRuns: input.maxRuns ?? CRON_DEFAULT_MAX_RUNS,
		deadlineAt: now + (deadline ?? CRON_EXPIRY_SECONDS) * 1000,
		baseline: encode(spec),
	};
}

/** The due time of a just-inserted cron timer: its first run with the jitter of its own id, which `cronFields` could not know. */
export function settledDue(row: TimerRow, now: number): number {
	const spec = cronOf(row);
	return (spec && nextRunAt(spec, row.id, now)) ?? row.due_at;
}

/** What the model reads when a cron timer is due. */
export function cronWakeText(row: TimerRow, spec: CronSpec): string {
	const last = row.status !== "active";
	return renderPrompt("notices/timer/cron-fire.md", {
		id: row.id,
		schedule: describeCron(spec),
		run: row.runs,
		limit: row.max_runs ?? undefined,
		note: row.note,
		last,
		ended: row.stop_reason ?? "ended",
	});
}

/** `cron 0 9 * * 1-5`, the run it is on and its limit: the row of the footer and the team panel, and a `list` line. */
export function cronSummary(row: TimerRow, spec: CronSpec): string {
	return `cron ${describeCron(spec)} · run ${row.runs + 1}${row.max_runs !== null ? ` of ${row.max_runs}` : ""}`;
}

/** The text `set` answers with: id, schedule, first run, limits and the rules a run follows. */
export function cronSetText(row: TimerRow, spec: CronSpec, now: number, cap: number): string {
	return renderPrompt("notices/timer/cron-set.md", {
		id: row.id,
		schedule: describeCron(spec),
		next: new Date(row.due_at).toString(),
		in: formatSpan(row.due_at - now),
		limit: row.max_runs ?? CRON_DEFAULT_MAX_RUNS,
		expires: new Date(row.deadline_at ?? row.due_at).toString(),
		cap: cap.toFixed(2),
	});
}
