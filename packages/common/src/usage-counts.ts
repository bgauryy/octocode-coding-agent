/**
 * How many sessions declared, called, loaded or were refused on each tool, per day and role group, in one small JSON
 * file beside `tool-use.json` (`tool-usage.json`, kept 7 days):
 *
 * `{ "days": { "<YYYY-MM-DD UTC>": { "<group>": { "<tool>": { declared, called, loaded, refused, used } } } },
 *    "sizes": { "<group>": { "<tool>": { "bytes": <bytes>, "day": "<YYYY-MM-DD UTC>" } } },
 *    "snapshots": { "<group>": { "at": <ms>, "version": "<install>", "budget": <bytes>, "tools": ["<tool>"] } } }`
 *
 * `group` is `main` (a main or coordinator session) or `subagent`. `declared` (the tool was declared, or listed by name
 * to load on demand), `called`, `loaded` (the full description read through the `mcp` tool) and `used` (called or
 * loaded) count a session once; `refused` counts each call a deferred tool's schema rejected, so a tool whose callers
 * need more than one try stands out. A tool is `<server>/<tool>` or `native/<tool>`, as in `tool-use.json`.
 *
 * `sizes` holds, per tool, the bytes promoting it adds to a request's tool list (the thin declaration of a tool the
 * configuration leaves on demand) and the last day they were measured; a tool without an entry adds nothing. The promotion snapshot (`usageSnapshot`) is
 * the tools the counts promote, in order of use while their sizes fit the caller's byte budget, computed once per UTC
 * day and install version, so the tool list that leads every request stays the same across a day's sessions.
 *
 * Processes share the file: an update takes the file's lock, re-reads it, merges its own bumps and replaces it only
 * while it still holds what was read (a writer that skips the lock is caught by that check, and the merge runs again).
 * An update that cannot take the lock keeps its bumps for the next one. Like `tool-use.json` the file is a hint, never a
 * source of truth: an unreadable or malformed file reads as "no data", a crash mid-write may leave a file that reads as
 * no data (writes skip the fsync), and nothing here throws.
 */

import { envFlag, SUBAGENT_ENV } from "./env.ts";
import {
	dayKey,
	emptyCounts,
	load,
	oldestDay,
	type Snapshot,
	type ToolSize,
	totals,
	update,
	type UsageByTool,
	type UsageCounts,
	type UsageFile,
	type UsageGroup,
	type UsageKind,
} from "./usage-file.ts";

export {
	USAGE_GROUPS,
	USAGE_RETENTION_DAYS,
	type UsageByTool,
	type UsageCounts,
	type UsageGroup,
	type UsageKind,
} from "./usage-file.ts";

export const USAGE_FILE_NAME = "tool-usage.json";
/** A tool is promoted at this share of declaring sessions that called or loaded it... */
export const PROMOTE_MIN_RATE = 0.1;
/** ...once this many sessions of its role group declared it. Below it the tool has no verdict and keeps its default. */
export const PROMOTE_MIN_DECLARED = 20;
/** A tool is also promoted when refusals exceed this many per session that used it. */
export const PROMOTE_MAX_REFUSALS_PER_USE = 1;

/** Bumps a recorder keeps while it cannot write; the oldest go first past this. */
const MAX_PENDING = 512;

/** The role group of the process the environment describes: a subagent child, else main. */
export const usageGroupOf = (env: NodeJS.ProcessEnv = process.env): UsageGroup =>
	envFlag(env, SUBAGENT_ENV) ? "subagent" : "main";

/** The counts of each tool in `group` over the retained days ending at `now`. Empty when there is no data. */
export function usageCounts(file: string, group: UsageGroup, now: number = Date.now()): UsageByTool {
	return totals(load(file), group, now);
}

/** The last retained day (`YYYY-MM-DD`, UTC) each tool of `group` was used by a session. A tool never used is absent. */
export function usageLastUsed(file: string, group: UsageGroup, now: number = Date.now()): Map<string, string> {
	const oldest = oldestDay(now);
	const last = new Map<string, string>();
	for (const [day, groups] of Object.entries(load(file).days)) {
		if (day < oldest) continue;
		for (const [name, counts] of Object.entries(groups[group] ?? {}))
			if (counts.used > 0 && day > (last.get(name) ?? "")) last.set(name, day);
	}
	return last;
}

/**
 * Whether counts promote a tool: enough declaring sessions at a high enough rate, or many refusals per using session.
 * A tool fewer than `PROMOTE_MIN_DECLARED` sessions declared is not promoted by rate: it keeps its default exposure.
 */
export function isPromoted(counts: UsageCounts): boolean {
	if (counts.used > 0 && counts.refused / counts.used > PROMOTE_MAX_REFUSALS_PER_USE) return true;
	return counts.declared >= PROMOTE_MIN_DECLARED && counts.used / counts.declared >= PROMOTE_MIN_RATE;
}

const rateOf = (counts: UsageCounts): number => (counts.declared > 0 ? counts.used / counts.declared : 1);

/**
 * The promoted tools of `group`, most used first (by rate, then name), kept while the sizes they add fit `budget`; a
 * tool that does not fit is skipped and smaller ones after it may still fit. Sorted by name. No budget keeps every one.
 */
function promotedWithin(usage: UsageFile, group: UsageGroup, now: number, budget?: number): string[] {
	const ranked = Object.entries(totals(usage, group, now))
		.filter(([, counts]) => isPromoted(counts))
		.sort(([a, x], [b, y]) => rateOf(y) - rateOf(x) || (a < b ? -1 : a > b ? 1 : 0));
	const sizes = usage.sizes[group] ?? {};
	let spent = 0;
	const kept: string[] = [];
	for (const [name] of ranked) {
		const cost = sizes[name]?.bytes ?? 0;
		if (budget !== undefined && spent + cost > budget) continue;
		spent += cost;
		kept.push(name);
	}
	return kept.sort();
}

/** The tools the counts of `group` promote, with no budget. Nothing when there is no data. */
export function promotedTools(file: string, group: UsageGroup, now: number = Date.now()): Set<string> {
	return new Set(promotedWithin(load(file), group, now));
}

export interface UsageSnapshotOptions {
	/** The install asking (its version): a snapshot another install computed is computed again. */
	version?: string;
	/** Bytes the promoted tools' sizes may add up to; a snapshot computed under another budget is computed again. */
	budget?: number;
}

/** Whether `saved` holds for `now`: computed the same UTC day, by the same install, under the same budget. */
const holds = (saved: Snapshot, now: number, options: UsageSnapshotOptions): boolean =>
	now >= saved.at &&
	dayKey(saved.at) === dayKey(now) &&
	(options.version === undefined || saved.version === undefined || saved.version === options.version) &&
	(options.budget === undefined || saved.budget === undefined || saved.budget === options.budget);

/**
 * The promotion snapshot for `group`: the saved one while it holds (same UTC day, install and budget), else the tools
 * the counts promote now within `options.budget`. A caller that names its `version` (a session deciding its tools)
 * saves a new one for the day's later sessions; one that names none (a settings view) only reads. Sessions read it once
 * at start and keep it.
 */
export function usageSnapshot(
	file: string,
	group: UsageGroup,
	now: number = Date.now(),
	options: UsageSnapshotOptions = {},
): Set<string> {
	const usage = load(file);
	const saved = usage.snapshots[group];
	if (saved && holds(saved, now, options)) return new Set(saved.tools);
	const { version, budget } = options;
	let tools = promotedWithin(usage, group, now, budget);
	if (version === undefined) return new Set(tools);
	try {
		update(file, now, (latest) => {
			// Another session saved one since: take it, so every session of the day declares the same tools.
			const since = latest.snapshots[group];
			if (since && holds(since, now, options)) {
				tools = since.tools;
				return false;
			}
			tools = promotedWithin(latest, group, now, budget);
			latest.snapshots[group] = { at: now, version, ...(budget === undefined ? {} : { budget }), tools };
		});
	} catch {
		// A hint: the next session computes it again.
	}
	return new Set(tools);
}

interface PendingBump {
	day: string;
	group: UsageGroup;
	name: string;
	kinds: UsageKind[];
}

/**
 * Counts one session's declarations, calls, loads and refusals. A session counts each tool once per kind (refusals
 * excepted); `reset` starts a new session. Each update merges into the file as it is (see the module note).
 */
export class UsageRecorder {
	readonly #file: () => string;
	readonly #group: () => UsageGroup;
	#seen = new Set<string>();
	#pending: PendingBump[] = [];
	#pendingSizes = new Map<string, { group: UsageGroup; name: string; size: ToolSize }>();
	/** The sizes this recorder wrote (`<bytes> <day>`), so an unchanged one is not written again the same day. */
	#writtenSizes = new Map<string, string>();
	/** Whether a last try at process exit is registered for bumps an update could not write. */
	#retryAtExit = false;

	constructor(file: () => string, group: () => UsageGroup) {
		this.#file = file;
		this.#group = group;
	}

	/** A new session: counts again whatever the last one counted. */
	reset(): void {
		this.#seen = new Set();
	}

	/** Counts `kind` for each name once per session. `called` and `loaded` also count `used`; `calledUndeclared` counts `loaded` and `used` too. Never throws. */
	record(kind: UsageKind, names: Iterable<string>, now: number = Date.now()): void {
		const group = this.#group();
		for (const name of names) {
			const kinds: UsageKind[] =
				kind === "calledUndeclared"
					? [kind, "loaded", "used"]
					: kind === "called" || kind === "loaded"
						? [kind, "used"]
						: [kind];
			const fresh = kinds.filter((each) => {
				if (each === "refused") return true;
				const key = `${each}\0${name}`;
				if (this.#seen.has(key)) return false;
				this.#seen.add(key);
				return true;
			});
			if (fresh.length > 0) this.#pending.push({ day: dayKey(now), group, name, kinds: fresh });
		}
		this.#flush(now);
	}

	/** Records the bytes promoting each tool adds (`sizes` in the module note), writing only what changed. Never throws. */
	recordSizes(sizes: Iterable<readonly [string, number]>, now: number = Date.now()): void {
		const group = this.#group();
		const day = dayKey(now);
		for (const [name, bytes] of sizes) {
			const key = `${group}\0${name}`;
			if (this.#writtenSizes.get(key) !== `${bytes} ${day}`)
				this.#pendingSizes.set(key, { group, name, size: { bytes, day } });
		}
		this.#flush(now);
	}

	#flush(now: number): void {
		if (this.#pending.length === 0 && this.#pendingSizes.size === 0) return;
		const bumps = this.#pending;
		const sizes = this.#pendingSizes;
		try {
			update(this.#file(), now, (usage) => {
				for (const { day, group, name, kinds } of bumps) {
					const groups = usage.days[day] ?? {};
					usage.days[day] = groups;
					const byTool = groups[group] ?? {};
					groups[group] = byTool;
					const counts = byTool[name] ?? emptyCounts();
					byTool[name] = counts;
					for (const each of kinds) counts[each] += 1;
				}
				for (const { group, name, size } of sizes.values()) {
					const byTool = usage.sizes[group] ?? {};
					usage.sizes[group] = byTool;
					byTool[name] = size;
				}
			});
			for (const [key, { size }] of sizes) this.#writtenSizes.set(key, `${size.bytes} ${size.day}`);
			this.#pending = [];
			this.#pendingSizes = new Map();
		} catch {
			// A hint: the bumps wait for the next update (or the process's exit), the oldest dropped past the cap.
			if (bumps.length > MAX_PENDING) this.#pending = bumps.slice(-MAX_PENDING);
			if (!this.#retryAtExit) {
				this.#retryAtExit = true;
				process.once("exit", () => this.#flush(Date.now()));
			}
		}
	}
}
