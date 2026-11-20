import fs from "node:fs";
import path from "node:path";
import type { Item } from "./item.ts";
import type { BacklogStore } from "./store.ts";
import { releasable } from "./release.ts";

/**
 * The grooming pass's code half: every check that needs no judgment, so a model reads one short report and decides only
 * the flagged rows (`octocode backlog groom`; the skill's references/grooming.md). Reads only; changes nothing.
 */

const DAY = 86_400_000;
/** Untouched this long, an item is worth a look: proposed ones age fastest, accepted work slower. */
const IDLE_DAYS: Partial<Record<Item["state"], number>> = { backlog: 14, todo: 21, ongoing: 3 };
/** Two titles whose word sets overlap this much (shared ÷ all) name the same work often enough to compare them. */
const DUPLICATE_OVERLAP = 0.6;
const STOP_WORDS = new Set([
	"a",
	"an",
	"and",
	"the",
	"of",
	"to",
	"in",
	"on",
	"for",
	"with",
	"is",
	"it",
	"by",
	"or",
	"at",
]);

interface GroomFinding {
	ref: string;
	title: string;
	detail: string;
}

export interface GroomReport {
	open: number;
	/** Ongoing, holder ended, idle past the release window: the store returns them to todo on its own. */
	releasable: GroomFinding[];
	/** Ongoing, holder ended, still inside the window or worked on by a child. */
	stale: GroomFinding[];
	blocked: GroomFinding[];
	/** Open epics whose items are all finished. */
	epicsToClose: GroomFinding[];
	idle: GroomFinding[];
	/** Every path the item names is gone from the repository. */
	pathsGone: GroomFinding[];
	duplicates: GroomFinding[];
}

const words = (title: string): Set<string> =>
	new Set(
		title
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((word) => word.length > 1 && !STOP_WORDS.has(word))
			// A plural or third-person `s` does not make another word: "drains" and "drain" match.
			.map((word) => (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word)),
	);

function overlap(a: Set<string>, b: Set<string>): number {
	if (!a.size || !b.size) return 0;
	let shared = 0;
	for (const word of a) if (b.has(word)) shared++;
	return shared / (a.size + b.size - shared);
}

const finding = (item: Item, detail: string): GroomFinding => ({ ref: item.ref, title: item.title, detail });

/** Pairs of open items whose titles share most of their words; each item is named once, beside its first match. */
function duplicatePairs(items: readonly Item[]): GroomFinding[] {
	const bags = items.map((item) => ({ item, words: words(item.title) })).filter((entry) => entry.words.size >= 3);
	const seen = new Set<string>();
	const found: GroomFinding[] = [];
	for (let i = 0; i < bags.length; i++) {
		if (seen.has(bags[i].item.ref)) continue;
		for (let j = i + 1; j < bags.length; j++) {
			if (seen.has(bags[j].item.ref) || overlap(bags[i].words, bags[j].words) < DUPLICATE_OVERLAP) continue;
			found.push(finding(bags[i].item, `title overlaps ${bags[j].item.ref} "${bags[j].item.title}"`));
			seen.add(bags[i].item.ref).add(bags[j].item.ref);
			break;
		}
	}
	return found;
}

export function groomReport(store: BacklogStore, repoRoot: string | undefined, now: number): GroomReport {
	const items = store.list({ states: ["backlog", "todo", "ongoing"], limit: 10_000 }).items;
	const marks = store.marks(items);
	const release = new Set(releasable(items, marks, now).map((item) => item.ref));
	const report: GroomReport = {
		open: items.length,
		releasable: [],
		stale: [],
		blocked: [],
		epicsToClose: [],
		idle: [],
		pathsGone: [],
		duplicates: duplicatePairs(items.filter((item) => item.type !== "epic")),
	};
	const openParents = new Set(items.flatMap((item) => item.parentId ?? []));
	// An epic with no items at all is a plan, not finished work.
	const finishedEpic = (epic: Item) =>
		!openParents.has(epic.ref) && store.list({ parentId: epic.ref, states: ["done", "closed"], limit: 1 }).total > 0;
	for (const item of items) {
		const mark = marks.get(item.ref);
		const days = Math.floor((now - item.updatedAt) / DAY);
		if (release.has(item.ref)) report.releasable.push(finding(item, `holder ${item.assignee} ended; idle ${days}d`));
		else if (mark?.stale) report.stale.push(finding(item, `holder ${item.assignee} ended`));
		if (mark?.blockedBy?.length) report.blocked.push(finding(item, `waits on ${mark.blockedBy.join(", ")}`));
		if (item.type === "epic" && finishedEpic(item)) report.epicsToClose.push(finding(item, "every item finished"));
		const limit = IDLE_DAYS[item.state];
		if (limit !== undefined && days >= limit && !mark?.stale)
			report.idle.push(finding(item, `${item.state}, untouched ${days}d`));
		if (repoRoot && item.paths.length && item.paths.every((entry) => !fs.existsSync(path.resolve(repoRoot, entry))))
			report.pathsGone.push(finding(item, `gone: ${item.paths.join(", ")}`));
	}
	return report;
}

const SECTIONS: Array<[key: Exclude<keyof GroomReport, "open">, heading: string, verdict: string]> = [
	["releasable", "Claims to release", "the store returns these to todo on its own"],
	["stale", "Claims whose holder ended", "reassign, or leave for the release window"],
	["epicsToClose", "Epics with every item finished", "close with evidence, or add the missing item"],
	["pathsGone", "Items whose paths are gone", "likely obsolete: check for a rename first"],
	["duplicates", "Possible duplicates", "compare the goals; close one as duplicate"],
	["blocked", "Blocked", "check the prerequisite still applies"],
	["idle", "Idle", "still wanted? reprioritize or close"],
];

/** The report as Markdown: one section per check with findings, each line `B12 title: detail`. */
export function groomText(report: GroomReport): string {
	const lines = [`Groom: ${report.open} open items checked by code; judge only the rows below.`];
	let flagged = 0;
	for (const [key, heading, verdict] of SECTIONS) {
		const rows = report[key];
		if (!rows.length) continue;
		flagged += rows.length;
		lines.push("", `## ${heading} (${rows.length}): ${verdict}`);
		for (const row of rows) lines.push(`- ${row.ref} ${row.title}: ${row.detail}`);
	}
	if (!flagged) lines.push("", "Nothing flagged.");
	return lines.join("\n");
}
