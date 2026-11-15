/**
 * How many sessions declared, called, loaded or were refused on each tool, per day and role group, in one small JSON
 * file beside `tool-use.json` (`tool-usage.json`, kept 7 days):
 *
 * `{ "days": { "<YYYY-MM-DD UTC>": { "<group>": { "<tool>": { declared, called, loaded, refused, used } } } },
 *    "snapshots": { "<group>": { "at": <ms>, "tools": ["<tool>"] } } }`
 *
 * `group` is `main` (a main or coordinator session) or `subagent`. `declared`, `called`, `loaded` (the full description
 * read through the `mcp` tool) and `used` (called or loaded) count a session once; `refused` counts each call a deferred
 * tool's schema rejected, so a tool whose callers need more than one try stands out. A tool is `<server>/<tool>` or
 * `native/<tool>`, as in `tool-use.json`.
 *
 * The promotion snapshot (`usageSnapshot`) is the tools worth declaring in full, computed from these counts at most
 * once an hour per group.
 *
 * Like `tool-use.json` the file is a hint, never a source of truth: an unreadable or malformed file reads as "no data",
 * two processes writing at once can lose an update (the file is replaced whole), and nothing here throws. A lost update
 * only makes a tool look less used until the next snapshot.
 */

import fs from "node:fs";
import { atomicWriteFileSync } from "./atomic-file.ts";
import { envFlag, SUBAGENT_ENV } from "./env.ts";

export const USAGE_FILE_NAME = "tool-usage.json";
/** Days of counts kept; the rate is taken over all of them. */
export const USAGE_RETENTION_DAYS = 7;
/** A saved snapshot older than this is computed again at the next session start. */
export const SNAPSHOT_MAX_AGE_MS = 60 * 60 * 1000;
/** A tool is promoted at this share of declaring sessions that called or loaded it... */
export const PROMOTE_MIN_RATE = 0.1;
/** ...once this many sessions of its role group declared it. */
export const PROMOTE_MIN_DECLARED = 20;
/** A tool is also promoted when refusals exceed this many per session that used it. */
export const PROMOTE_MAX_REFUSALS_PER_USE = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

export type UsageGroup = "main" | "subagent";
export const USAGE_GROUPS: readonly UsageGroup[] = ["main", "subagent"];
/** The role group of the process the environment describes: a subagent child, else main. */
export const usageGroupOf = (env: NodeJS.ProcessEnv = process.env): UsageGroup =>
	envFlag(env, SUBAGENT_ENV) ? "subagent" : "main";
export type UsageKind = "declared" | "called" | "loaded" | "refused" | "used";
export type UsageCounts = Record<UsageKind, number>;
export type UsageByTool = Record<string, UsageCounts>;

interface Snapshot {
	at: number;
	tools: string[];
}
interface UsageFile {
	days: Record<string, Partial<Record<UsageGroup, UsageByTool>>>;
	snapshots: Partial<Record<UsageGroup, Snapshot>>;
}

const KINDS: readonly UsageKind[] = ["declared", "called", "loaded", "refused", "used"];
const dayKey = (at: number): string => new Date(at).toISOString().slice(0, 10);
const emptyCounts = (): UsageCounts => ({ declared: 0, called: 0, loaded: 0, refused: 0, used: 0 });
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function load(file: string): UsageFile {
	const usage: UsageFile = { days: {}, snapshots: {} };
	try {
		const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!isRecord(value)) return usage;
		if (isRecord(value.days))
			for (const [day, groups] of Object.entries(value.days)) {
				if (!isRecord(groups)) continue;
				const kept: Partial<Record<UsageGroup, UsageByTool>> = {};
				for (const group of USAGE_GROUPS) {
					const tools = groups[group];
					if (!isRecord(tools)) continue;
					const byTool: UsageByTool = {};
					for (const [name, counts] of Object.entries(tools)) {
						if (!isRecord(counts)) continue;
						const each = emptyCounts();
						for (const kind of KINDS) {
							const n = counts[kind];
							if (typeof n === "number" && Number.isFinite(n) && n > 0) each[kind] = n;
						}
						byTool[name] = each;
					}
					kept[group] = byTool;
				}
				usage.days[day] = kept;
			}
		if (isRecord(value.snapshots))
			for (const group of USAGE_GROUPS) {
				const snap = value.snapshots[group];
				if (!isRecord(snap) || typeof snap.at !== "number" || !Array.isArray(snap.tools)) continue;
				usage.snapshots[group] = {
					at: snap.at,
					tools: snap.tools.filter((tool): tool is string => typeof tool === "string"),
				};
			}
	} catch {
		// Unreadable reads as no data.
	}
	return usage;
}

/** Drops days outside the retention window, then replaces the file. Never throws. */
function save(file: string, usage: UsageFile, now: number): void {
	try {
		const oldest = dayKey(now - (USAGE_RETENTION_DAYS - 1) * DAY_MS);
		const days = Object.fromEntries(Object.entries(usage.days).filter(([day]) => day >= oldest));
		atomicWriteFileSync(file, `${JSON.stringify({ days, snapshots: usage.snapshots })}\n`);
	} catch {
		// A hint: the next update tries again.
	}
}

/** The counts of each tool in `group` over the retained days ending at `now`. Empty when there is no data. */
export function usageCounts(file: string, group: UsageGroup, now: number = Date.now()): UsageByTool {
	const usage = load(file);
	const oldest = dayKey(now - (USAGE_RETENTION_DAYS - 1) * DAY_MS);
	const total: UsageByTool = {};
	for (const [day, groups] of Object.entries(usage.days)) {
		if (day < oldest) continue;
		for (const [name, counts] of Object.entries(groups[group] ?? {})) {
			const sum = total[name] ?? emptyCounts();
			total[name] = sum;
			for (const kind of KINDS) sum[kind] += counts[kind];
		}
	}
	return total;
}

/** The last retained day (`YYYY-MM-DD`, UTC) each tool of `group` was used by a session. A tool never used is absent. */
export function usageLastUsed(file: string, group: UsageGroup, now: number = Date.now()): Map<string, string> {
	const oldest = dayKey(now - (USAGE_RETENTION_DAYS - 1) * DAY_MS);
	const last = new Map<string, string>();
	for (const [day, groups] of Object.entries(load(file).days)) {
		if (day < oldest) continue;
		for (const [name, counts] of Object.entries(groups[group] ?? {}))
			if (counts.used > 0 && day > (last.get(name) ?? "")) last.set(name, day);
	}
	return last;
}

/** Whether counts promote a tool: enough declaring sessions at a high enough rate, or many refusals per using session. */
export function isPromoted(counts: UsageCounts): boolean {
	if (counts.used > 0 && counts.refused / counts.used > PROMOTE_MAX_REFUSALS_PER_USE) return true;
	return counts.declared >= PROMOTE_MIN_DECLARED && counts.used / counts.declared >= PROMOTE_MIN_RATE;
}

/** The tools the counts of `group` promote. Nothing when there is no data. */
export function promotedTools(file: string, group: UsageGroup, now: number = Date.now()): Set<string> {
	return new Set(
		Object.entries(usageCounts(file, group, now))
			.filter(([, counts]) => isPromoted(counts))
			.map(([name]) => name),
	);
}

/**
 * The promotion snapshot for `group`: the saved one when it is under an hour old, else the tools the counts promote now,
 * saved for the next session. Sessions read it once at start and keep it.
 */
export function usageSnapshot(file: string, group: UsageGroup, now: number = Date.now()): Set<string> {
	const usage = load(file);
	const saved = usage.snapshots[group];
	if (saved && now >= saved.at && now - saved.at < SNAPSHOT_MAX_AGE_MS) return new Set(saved.tools);
	const tools = promotedTools(file, group, now);
	usage.snapshots[group] = { at: now, tools: [...tools].sort() };
	save(file, usage, now);
	return tools;
}

/**
 * Counts one session's declarations, calls, loads and refusals. A session counts each tool once per kind (refusals
 * excepted); `reset` starts a new session. Each update is one rewrite of the file.
 */
export class UsageRecorder {
	readonly #file: () => string;
	readonly #group: () => UsageGroup;
	#seen = new Set<string>();

	constructor(file: () => string, group: () => UsageGroup) {
		this.#file = file;
		this.#group = group;
	}

	/** A new session: counts again whatever the last one counted. */
	reset(): void {
		this.#seen = new Set();
	}

	/** Counts `kind` for each name once per session. `called` and `loaded` also count `used`. Never throws. */
	record(kind: UsageKind, names: Iterable<string>, now: number = Date.now()): void {
		const bumps = new Map<string, UsageKind[]>();
		for (const name of names) {
			const kinds: UsageKind[] = kind === "called" || kind === "loaded" ? [kind, "used"] : [kind];
			const fresh = kinds.filter((each) => {
				if (each === "refused") return true;
				const key = `${each}\0${name}`;
				if (this.#seen.has(key)) return false;
				this.#seen.add(key);
				return true;
			});
			if (fresh.length > 0) bumps.set(name, fresh);
		}
		if (bumps.size === 0) return;
		try {
			const file = this.#file();
			const usage = load(file);
			const groups = usage.days[dayKey(now)] ?? {};
			usage.days[dayKey(now)] = groups;
			const byTool = groups[this.#group()] ?? {};
			groups[this.#group()] = byTool;
			for (const [name, kinds] of bumps) {
				const counts = byTool[name] ?? emptyCounts();
				byTool[name] = counts;
				for (const each of kinds) counts[each] += 1;
			}
			save(file, usage, now);
		} catch {
			// A hint: a failed update is lost.
		}
	}
}
