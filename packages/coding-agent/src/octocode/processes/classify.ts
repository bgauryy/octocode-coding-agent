import type { OwnedChild, ProcessSample } from "../../../../db/src/api.ts";
import { isProcessTitle, parseTitle } from "./title.ts";
import type { ProcessRow } from "./table.ts";

/**
 * Turns the process table plus the samples every Octocode process recorded into what `/processes` shows: the live
 * Octocode processes with the children each owns, the orphans, and memory that keeps growing. Pure: the table and the
 * records are arguments, so the rules are testable without a process.
 */

/** After an owner reported a graceful shutdown, its children get this long to exit before they count as orphans. */
export const ORPHAN_GRACE_MS = 15_000;

const MB = 1024 * 1024;
/** Memory counts as growing when the newest samples rise like this: at least 4 samples over 15 minutes, each at most 5% below the one before, and a total rise of 64 MB and 25%. */
const GROWTH_WINDOW = 12;
const GROWTH_MIN_SAMPLES = 4;
const GROWTH_MIN_SPAN_MS = 15 * 60_000;
const GROWTH_MIN_RISE = 64 * MB;
const GROWTH_MIN_RATIO = 0.25;
const GROWTH_MAX_DIP = 0.05;

export interface Growth {
	/** Bytes at the start and end of the window. */
	from: number;
	to: number;
	spanMs: number;
}

/** Whether a series of memory samples (bytes, any order) shows steady growth; see the constants above for the rule. */
export function growthOf(series: ReadonlyArray<{ at: number; rss: number }>): Growth | undefined {
	const window = [...series].sort((a, b) => a.at - b.at).slice(-GROWTH_WINDOW);
	if (window.length < GROWTH_MIN_SAMPLES) return undefined;
	const first = window[0];
	const last = window[window.length - 1];
	const spanMs = last.at - first.at;
	if (spanMs < GROWTH_MIN_SPAN_MS) return undefined;
	for (let i = 1; i < window.length; i += 1)
		if (window[i].rss < window[i - 1].rss * (1 - GROWTH_MAX_DIP)) return undefined;
	const rise = last.rss - first.rss;
	if (rise < GROWTH_MIN_RISE || rise < first.rss * GROWTH_MIN_RATIO) return undefined;
	return { from: first.rss, to: last.rss, spanMs };
}

interface ChildEntry {
	pid: number;
	ppid: number;
	started: string;
	kind: string;
	label: string;
	rssKb: number;
	ageMs: number;
	growth?: Growth;
}

export interface ProcessEntry {
	pid: number;
	ppid: number;
	started: string;
	role: string;
	id: string;
	title: string;
	sessionId: string | null;
	rssKb: number;
	ageMs: number;
	ownerPid: number | null;
	/** Whether the Octocode that started this process still runs; undefined for a process nobody owns (a main session). */
	ownerAlive: boolean | undefined;
	children: ChildEntry[];
	growth?: Growth;
	self: boolean;
	/** The id `octocode-api` and `/agents external` reach it by; undefined while its API is off. */
	apiId?: string;
}

export interface Orphan {
	pid: number;
	/** Recorded start time (`processStartTime`): with the pid it names the one process that may be stopped. */
	started: string;
	kind: string;
	label: string;
	rssKb: number;
	ageMs: number;
	ownerPid: number;
	ownerLabel: string;
	reason: "owner-gone" | "reparented";
}

export interface ProcessReport {
	processes: ProcessEntry[];
	orphans: Orphan[];
}

export interface ClassifyInput {
	table: readonly ProcessRow[];
	/** Samples from the retention window, any order, from every process. */
	samples: readonly ProcessSample[];
	now: number;
	selfPid?: number;
	/** The running API instances, by the pid that serves each. */
	apiIds?: ReadonlyMap<number, string>;
}

const key = (pid: number, started: string | null) => `${pid}:${started ?? ""}`;
const label = (command: string) => (command.length > 100 ? `${command.slice(0, 99)}…` : command);

export function classifyProcesses({ table, samples, now, selfPid, apiIds }: ClassifyInput): ProcessReport {
	const byPid = new Map(table.map((row) => [row.pid, row]));
	const children = new Map<number, ProcessRow[]>();
	for (const row of table) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
	const same = (pid: number, started: string | null): boolean =>
		started !== null && started !== "" && byPid.get(pid)?.started === started;

	const latest = new Map<string, ProcessSample>();
	const series = new Map<string, ProcessSample[]>();
	for (const sample of samples) {
		const id = key(sample.pid, sample.started);
		series.set(id, [...(series.get(id) ?? []), sample]);
		if ((latest.get(id)?.at ?? -1) <= sample.at) latest.set(id, sample);
	}

	// The live Octocode processes: recorded ones that still run, and processes whose title says they are one.
	const identities = new Map<
		number,
		Pick<ProcessEntry, "role" | "id" | "title" | "sessionId" | "ownerPid"> & { record?: ProcessSample }
	>();
	for (const row of table) {
		const record = latest.get(key(row.pid, row.started));
		if (record) {
			identities.set(row.pid, {
				role: record.role,
				id: record.id,
				title: record.title,
				sessionId: record.sessionId,
				ownerPid: record.ownerPid,
				record,
			});
			continue;
		}
		const named = isProcessTitle(row.command) ? parseTitle(row.command) : undefined;
		if (named)
			identities.set(row.pid, { ...named, title: row.command.split(/\s/, 1)[0], sessionId: null, ownerPid: null });
	}

	const childrenOf = (
		root: number,
		recorded: ReadonlyMap<string, OwnedChild>,
		growth: ReadonlyMap<string, Growth>,
	): ChildEntry[] => {
		const found: ChildEntry[] = [];
		const walk = (parent: number, inherited: string) => {
			for (const row of children.get(parent) ?? []) {
				if (identities.has(row.pid)) continue; // another Octocode process owns its own tree
				const known = recorded.get(key(row.pid, row.started));
				const kind = known?.kind ?? inherited;
				const entry: ChildEntry = {
					pid: row.pid,
					ppid: row.ppid,
					started: row.started,
					kind,
					label: label(row.command),
					rssKb: row.rssKb,
					ageMs: now - Number(row.started) * 1000,
				};
				const grown = growth.get(key(row.pid, row.started));
				if (grown) entry.growth = grown;
				found.push(entry);
				walk(row.pid, kind);
			}
		};
		walk(root, "child");
		return found;
	};

	const processes: ProcessEntry[] = [];
	for (const [pid, identity] of identities) {
		const row = byPid.get(pid)!;
		const history = (series.get(key(pid, row.started)) ?? []).filter((sample) => !sample.ended);
		const recorded = new Map((identity.record?.children ?? []).map((child) => [key(child.pid, child.started), child]));
		const childGrowth = new Map<string, Growth>();
		for (const child of recorded.values()) {
			const grown = growthOf(
				history.flatMap((sample) => {
					const point = sample.children.find((each) => each.pid === child.pid && each.started === child.started);
					return point ? [{ at: sample.at, rss: point.rss }] : [];
				}),
			);
			if (grown) childGrowth.set(key(child.pid, child.started), grown);
		}
		const entry: ProcessEntry = {
			pid,
			ppid: row.ppid,
			started: row.started,
			role: identity.role,
			id: identity.id,
			title: identity.title,
			sessionId: identity.sessionId,
			rssKb: row.rssKb,
			ageMs: now - Number(row.started) * 1000,
			ownerPid: identity.ownerPid,
			ownerAlive:
				identity.ownerPid === null
					? undefined
					: identity.record?.ownerStarted
						? same(identity.ownerPid, identity.record.ownerStarted)
						: byPid.has(identity.ownerPid),
			children: childrenOf(pid, recorded, childGrowth),
			self: pid === selfPid,
		};
		const growth = growthOf(history);
		if (growth) entry.growth = growth;
		const apiId = apiIds?.get(pid);
		if (apiId) entry.apiId = apiId;
		processes.push(entry);
	}
	processes.sort((a, b) => Number(a.started) - Number(b.started) || a.pid - b.pid);

	const orphans = new Map<number, Orphan>();
	for (const record of latest.values()) {
		const owner = `${record.role}-${record.id}`;
		const ownerAlive = same(record.pid, record.started);
		const row = byPid.get(record.pid);
		const settling = record.ended && now - record.at < ORPHAN_GRACE_MS;
		if (
			ownerAlive &&
			!settling &&
			record.ownerPid !== null &&
			record.ownerStarted &&
			!same(record.ownerPid, record.ownerStarted)
		) {
			orphans.set(record.pid, {
				pid: record.pid,
				started: record.started!,
				kind: "subagent",
				label: record.title,
				rssKb: row!.rssKb,
				ageMs: now - Number(row!.started) * 1000,
				ownerPid: record.ownerPid,
				ownerLabel: `a parent Octocode (pid ${record.ownerPid})`,
				reason: "owner-gone",
			});
		}
		for (const child of record.children) {
			const live = byPid.get(child.pid);
			if (!live || !same(child.pid, child.started) || identities.has(child.pid) || orphans.has(child.pid)) continue;
			let reason: Orphan["reason"] | undefined;
			if (!ownerAlive) reason = settling ? undefined : "owner-gone";
			else if (child.kind !== "subagent" && live.ppid !== child.ppid && (live.ppid === 1 || !byPid.has(child.ppid)))
				reason = "reparented";
			if (!reason) continue;
			orphans.set(child.pid, {
				pid: child.pid,
				started: child.started!,
				kind: child.kind,
				label: label(live.command),
				rssKb: live.rssKb,
				ageMs: now - Number(live.started) * 1000,
				ownerPid: record.pid,
				ownerLabel: owner,
				reason,
			});
		}
	}
	return { processes, orphans: [...orphans.values()].sort((a, b) => a.pid - b.pid) };
}
