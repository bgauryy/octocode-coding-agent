/**
 * The file behind `usage-counts.ts` (`tool-usage.json`): its types, how it is read (anything
 * malformed read as no data) and written (days and sizes outside the retention window left out), and the one locked,
 * merging update every writer goes through. The format and the rules are described in `usage-counts.ts`.
 */

import { isRecord } from "@octocodeai/octocode-contracts/guards";
import fs from "node:fs";
import { atomicWriteFileSync, ChangedOnDiskError } from "./atomic-file.ts";
import { withFileLockSync } from "./file-write-lock.ts";

/** Days of counts kept; the rate is taken over all of them. */
export const USAGE_RETENTION_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Tries of one update while writers outside the lock keep changing the file. */
const MERGE_ATTEMPTS = 3;
/** Tries to take the lock, 20ms apart: a burst of children starting at once waits up to about half a second. */
const LOCK_ATTEMPTS = 25;

export type UsageGroup = "main" | "subagent";
export const USAGE_GROUPS: readonly UsageGroup[] = ["main", "subagent"];
/** `calledUndeclared`: an on-demand tool called before it was declared; it also counts as `loaded` and `used`. */
export type UsageKind = "declared" | "called" | "loaded" | "calledUndeclared" | "refused" | "used";
export type UsageCounts = Record<UsageKind, number>;
export type UsageByTool = Record<string, UsageCounts>;

export interface Snapshot {
	at: number;
	/** The install that computed it; absent in files written before versions were kept (any version reads it). */
	version?: string;
	/** The byte budget it was computed under; absent when the caller set none. */
	budget?: number;
	tools: string[];
}
/** The bytes promoting a tool adds, as last measured on `day`. */
export interface ToolSize {
	bytes: number;
	day: string;
}
export interface UsageFile {
	days: Record<string, Partial<Record<UsageGroup, UsageByTool>>>;
	sizes: Partial<Record<UsageGroup, Record<string, ToolSize>>>;
	snapshots: Partial<Record<UsageGroup, Snapshot>>;
}

export const KINDS: readonly UsageKind[] = ["declared", "called", "loaded", "calledUndeclared", "refused", "used"];
export const dayKey = (at: number): string => new Date(at).toISOString().slice(0, 10);
export const oldestDay = (now: number): string => dayKey(now - (USAGE_RETENTION_DAYS - 1) * DAY_MS);
export const emptyCounts = (): UsageCounts => ({
	declared: 0,
	called: 0,
	loaded: 0,
	calledUndeclared: 0,
	refused: 0,
	used: 0,
});
const count = (value: unknown): number =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

function parseTools(tools: Record<string, unknown>): UsageByTool {
	const byTool: UsageByTool = {};
	for (const [key, counts] of Object.entries(tools)) {
		if (!isRecord(counts)) continue;
		const each = byTool[key] ?? emptyCounts();
		byTool[key] = each;
		for (const kind of KINDS) each[kind] += count(counts[kind]);
	}
	return byTool;
}

function parseSnapshot(snap: unknown): Snapshot | undefined {
	if (!isRecord(snap) || typeof snap.at !== "number" || !Array.isArray(snap.tools)) return undefined;
	const tools = snap.tools.filter((tool): tool is string => typeof tool === "string");
	return {
		at: snap.at,
		...(typeof snap.version === "string" ? { version: snap.version } : {}),
		...(typeof snap.budget === "number" ? { budget: snap.budget } : {}),
		tools: [...new Set(tools)].sort(),
	};
}

/** The file's content as counts; anything malformed reads as no data. */
function parse(text: string | undefined): UsageFile {
	const usage: UsageFile = { days: {}, sizes: {}, snapshots: {} };
	let value: unknown;
	try {
		value = text === undefined ? undefined : JSON.parse(text);
	} catch {
		return usage;
	}
	if (!isRecord(value)) return usage;
	if (isRecord(value.days))
		for (const [day, groups] of Object.entries(value.days)) {
			if (!isRecord(groups)) continue;
			const kept: Partial<Record<UsageGroup, UsageByTool>> = {};
			for (const group of USAGE_GROUPS) {
				const tools = groups[group];
				if (isRecord(tools)) kept[group] = parseTools(tools);
			}
			usage.days[day] = kept;
		}
	for (const group of USAGE_GROUPS) {
		const sizes = isRecord(value.sizes) ? value.sizes[group] : undefined;
		if (isRecord(sizes)) {
			const kept: Record<string, ToolSize> = {};
			for (const [key, size] of Object.entries(sizes)) {
				if (!isRecord(size) || typeof size.day !== "string") continue;
				if (!kept[key] || size.day > kept[key].day) kept[key] = { bytes: count(size.bytes), day: size.day };
			}
			usage.sizes[group] = kept;
		}
		const snap = parseSnapshot(isRecord(value.snapshots) ? value.snapshots[group] : undefined);
		if (snap) usage.snapshots[group] = snap;
	}
	return usage;
}

/** The file's text, or undefined when it is missing. Any other failure throws: a merge must not start from nothing. */
function readText(file: string): string | undefined {
	try {
		return fs.readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** The counts as a reader takes them: a file it cannot read is no data, like a malformed one, since counts are a hint. */
export function load(file: string): UsageFile {
	let text: string | undefined;
	try {
		text = readText(file);
	} catch {
		// Unreadable (permissions, a folder in its place): no promotion this session; an update throws instead.
	}
	return parse(text);
}

/** The file's text for `usage`, with days and sizes measured outside the retention window left out. */
function serialize(usage: UsageFile, now: number): string {
	const oldest = oldestDay(now);
	const days = Object.fromEntries(Object.entries(usage.days).filter(([day]) => day >= oldest));
	const sizes: UsageFile["sizes"] = {};
	for (const group of USAGE_GROUPS) {
		const kept = Object.entries(usage.sizes[group] ?? {}).filter(([, size]) => size.day >= oldest);
		if (kept.length > 0) sizes[group] = Object.fromEntries(kept);
	}
	return `${JSON.stringify({ days, sizes, snapshots: usage.snapshots })}\n`;
}

/**
 * Applies `mutate` to the file as it is now and replaces it, holding the file's lock. A replacement is committed only
 * while the file still holds the text the merge read; otherwise the merge runs again on the new text. `mutate` returns
 * false to leave the file as it is. Throws when the lock or the write fails.
 */
export function update(file: string, now: number, mutate: (usage: UsageFile) => boolean | void): void {
	withFileLockSync(
		file,
		(assertHeld) => {
			for (let attempt = 1; ; attempt++) {
				const text = readText(file);
				const usage = parse(text);
				if (mutate(usage) === false) return;
				assertHeld();
				try {
					atomicWriteFileSync(file, serialize(usage, now), {
						durability: "none",
						beforeCommit: () => {
							if (readText(file) !== text) throw new ChangedOnDiskError(file);
						},
					});
					return;
				} catch (error) {
					if (!(error instanceof ChangedOnDiskError) || attempt >= MERGE_ATTEMPTS) throw error;
				}
			}
		},
		{ attempts: LOCK_ATTEMPTS },
	);
}

export function totals(usage: UsageFile, group: UsageGroup, now: number): UsageByTool {
	const oldest = oldestDay(now);
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
