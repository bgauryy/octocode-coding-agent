import { renderPrompt } from "../prompt-template.ts";
import { restates, type Words, wordsOf } from "./ledger-match.ts";
import {
	CONSTRAINTS_HEADING,
	DECISIONS_HEADING,
	GOAL_HEADING,
	STOPPED_HEADING,
	TLDR_HEADING,
} from "./summary-format.ts";
import { splitSummary } from "./summary-view.ts";

/**
 * The ledger code carries from summary to summary: the bullets of a checkpoint's standing constraints and key decisions,
 * each with a stable id (`[C3]`, `[D2]`). A summarizer rewrites the rest of the checkpoint each time, and left alone it
 * drops standing rules as it condenses. So the update request names the carried bullets with their ids, the model writes
 * only new bullets and lifts (`- Lifted [C3]: reason`), and code puts every carried bullet not lifted back under its
 * heading word for word. A bullet leaves only when the model marks it lifted, and the compaction entry records the lift
 * with its reason. A new bullet that only restates a carried one in other words, or another new one, is not added
 * (`ledger-match.ts`), so paraphrases do not pile up. Past `LEDGER_SOFT_CAP` bullets in a section the request asks the
 * model to lift finished and merged ones; nothing is dropped without a lift. A summary written before the ledger has
 * bullets without ids: they get ids in order when read.
 */

/** One section the ledger carries: its heading, its id prefix, and the word that lifts one of its bullets. */
interface LedgerSection {
	key: "constraints" | "decisions";
	heading: string;
	prefix: "C" | "D";
	lift: "Lifted" | "Superseded";
}

const SECTIONS: readonly LedgerSection[] = [
	{ key: "constraints", heading: CONSTRAINTS_HEADING, prefix: "C", lift: "Lifted" },
	{ key: "decisions", heading: DECISIONS_HEADING, prefix: "D", lift: "Superseded" },
];

interface LedgerBullet {
	id: string;
	text: string;
}

/** What a checkpoint hands the next one: the bullets of its ledger sections, and its Goal section's lines verbatim. */
type Ledger = Record<LedgerSection["key"], LedgerBullet[]> & { goal: string[] };

/** A bullet the model lifted this time, kept in the compaction entry's `details` so its leaving can be audited. */
export interface LiftedBullet extends LedgerBullet {
	reason: string;
}

/** The compaction entry's `details` key that lists the bullets lifted by that compaction. */
export const LIFTED_DETAILS = "lifted";
/** The compaction entry's `details` key that counts the bullets its summary carries, per section. */
const LEDGER_DETAILS = "ledger";

/** Bullets in one section past which the update request asks the model to consolidate (lift finished and merged ones). */
export const LEDGER_SOFT_CAP = 25;

const EMPTY = /^\(?none\)?\.?$/i;
const ID = /^[*_`]*\[([CD]\d+)\][*_`]*[:.]?\s*/i;
/**
 * `Lifted [C3]: why`, `Lifted [C1], [C2]: why`, `Superseded [D2] - why`, `**Lifted [C3]**: why`, or `[C3] lifted: why`.
 */
const MULTI_LIFT =
	/^\**(?:lifted|superseded|withdrawn)\s*:?\s*((?:[*_`]*\[[CD]\d+\][*_`]*(?:\s*(?:,|and|&)\s*)?)+)\**\s*[:—–-]?\s*(.*)$/i;
const POST_LIFT = /^\**\[([CD]\d+)\]\**\s*(?:lifted|superseded|withdrawn)(?=\s*[:—–-])\s*[:—–-]?\s*(.*)$/i;

function parseLift(bullet: string): { ids: string[]; reason: string } | undefined {
	const multi = MULTI_LIFT.exec(bullet);
	if (multi) {
		const ids = [...multi[1].matchAll(/\[([CD]\d+)\]/gi)].map((m) => m[1].toUpperCase());
		if (ids.length > 0) return { ids, reason: multi[2].trim() };
	}
	const post = POST_LIFT.exec(bullet);
	if (post) return { ids: [post[1].toUpperCase()], reason: post[2].trim() };
	return undefined;
}

const normalize = (text: string): string =>
	text
		.replace(/\s+/g, " ")
		.replace(/[.;\s]+$/, "")
		.trim()
		.toLowerCase();

/** The line range of the section headed `heading`: from its heading to the next `## ` heading or tag line. */
function sectionRange(lines: readonly string[], heading: string): { start: number; end: number } | undefined {
	const start = lines.findIndex((line) => line.trim() === heading);
	if (start < 0) return undefined;
	const after = lines.findIndex((line, index) => index > start && /^(?:## |<)/.test(line));
	return { start, end: after < 0 ? lines.length : after };
}

/** The section's bullets: a top-level `- ` or `* ` line starts one, any other non-empty line continues the last. */
function bulletsOf(lines: readonly string[]): string[] {
	const bullets: string[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		const bullet = /^[-*]\s+(.*)$/.exec(line);
		if (bullet) bullets.push(bullet[1].trim());
		else if (bullets.length > 0 && /^\s/.test(line)) bullets[bullets.length - 1] += `\n${line.trimEnd()}`;
		else bullets.push(line.trim());
	}
	return bullets;
}

function sectionBullets(text: string, heading: string): string[] {
	const lines = text.split("\n");
	const range = sectionRange(lines, heading);
	return range ? bulletsOf(lines.slice(range.start + 1, range.end)) : [];
}

/** The lines of a Goal section that says something: none for a missing section, an empty one or `(none)`. */
function goalLines(text: string): string[] {
	const lines = text.split("\n");
	const range = sectionRange(lines, GOAL_HEADING);
	const body = range ? lines.slice(range.start + 1, range.end) : [];
	const said = body.some((line) => line.trim() && !EMPTY.test(line.trim()));
	return said ? body : [];
}

const idNumber = (id: string): number => Number(id.slice(1));

/** The carried bullets of a checkpoint body (excluding `## User Messages`); a bullet without an id gets the next one. */
export function ledgerOf(body: string | undefined): Ledger {
	const ledger: Ledger = { constraints: [], decisions: [], goal: [] };
	if (!body) return ledger;
	const clean = splitSummary(body).body;
	ledger.goal = goalLines(clean);
	for (const section of SECTIONS) {
		const seen = new Set<string>();
		const raw = sectionBullets(clean, section.heading).filter((bullet) => !EMPTY.test(bullet));
		let next = Math.max(
			0,
			...raw
				.map((bullet) => ID.exec(bullet)?.[1]?.toUpperCase())
				.flatMap((id) => (id?.startsWith(section.prefix) ? [idNumber(id)] : [])),
		);
		for (const bullet of raw) {
			const match = ID.exec(bullet);
			const upper = match?.[1].toUpperCase();
			const given = upper?.startsWith(section.prefix) && !seen.has(upper) ? upper : undefined;
			const id = given ?? `${section.prefix}${++next}`;
			seen.add(id);
			ledger[section.key].push({ id, text: given ? bullet.slice(match![0].length) : bullet });
		}
	}
	return ledger;
}

const renderBullets = (bullets: readonly LedgerBullet[]): string =>
	bullets.map((bullet) => `[${bullet.id}] ${bullet.text}`).join("\n");

/** What the update request says about the carried bullets; empty when there are none. Past the soft cap it asks for consolidation. */
export function ledgerPrompt(ledger: Ledger): string {
	if (ledger.constraints.length === 0 && ledger.decisions.length === 0) return "";
	return renderPrompt("workflows/compaction/ledger.md", {
		constraints: renderBullets(ledger.constraints),
		decisions: renderBullets(ledger.decisions),
		constraintsHeading: CONSTRAINTS_HEADING,
		decisionsHeading: DECISIONS_HEADING,
		crowded: ledger.constraints.length > LEDGER_SOFT_CAP || ledger.decisions.length > LEDGER_SOFT_CAP,
		constraintCount: ledger.constraints.length,
		decisionCount: ledger.decisions.length,
		cap: LEDGER_SOFT_CAP,
	});
}

/**
 * What a compaction entry's `details` record of its ledger: the bullets lifted, and how many each section of `text`
 * (the summary as written back) carries, so growth across compactions is read from the entries. Each only when non-empty.
 */
export function ledgerDetails(text: string, lifted: readonly LiftedBullet[]): Record<string, unknown> {
	const { constraints, decisions } = ledgerOf(text);
	return {
		...(lifted.length > 0 ? { [LIFTED_DETAILS]: lifted } : {}),
		...(constraints.length + decisions.length > 0
			? { [LEDGER_DETAILS]: { constraints: constraints.length, decisions: decisions.length } }
			: {}),
	};
}

/** Where a missing section goes: constraints after the goal, decisions before where the work stopped. */
function insertAt(lines: readonly string[], section: LedgerSection): number {
	if (section.key === "constraints") {
		const goal = lines.findIndex((line) => line.trim() === GOAL_HEADING);
		if (goal < 0) return 0;
		const next = lines.findIndex((line, index) => index > goal && line.startsWith("## "));
		return next < 0 ? lines.length : next;
	}
	for (const heading of [STOPPED_HEADING, TLDR_HEADING]) {
		const at = lines.findIndex((line) => line.trim() === heading);
		if (at >= 0) return at;
	}
	return lines.length;
}

/** The lifts the model wrote under either heading (`- Lifted [C3]: why`), by the id they name, with their reasons. */
function liftsOf(lines: readonly string[]): Map<string, string> {
	const lifts = new Map<string, string>();
	for (const section of SECTIONS) {
		const range = sectionRange(lines, section.heading);
		if (!range) continue;
		for (const bullet of bulletsOf(lines.slice(range.start + 1, range.end))) {
			const parsed = parseLift(bullet);
			if (parsed) {
				for (const id of parsed.ids) lifts.set(id, parsed.reason);
			}
		}
	}
	return lifts;
}

/**
 * `text` (a summary the model just wrote) with each ledger section rebuilt by code: every carried bullet not lifted,
 * word for word with its id, then the bullets the model added, each with a new id. A bullet the model restated (with
 * its id, the same words, or other words for the same rule: `ledger-match.ts`) is not added again, neither is a
 * restatement of a bullet added just before it, and a lift line is never kept as a bullet. A restatement of a lifted
 * bullet is its replacement and is added. A section the model left out is put back when it has bullets to carry.
 * The Goal section rides along: a new summary with no goal, or an empty one, gets the previous goal word for word; a
 * goal the model wrote replaces it.
 */
export function applyLedger(text: string, carried: Ledger): { text: string; lifted: LiftedBullet[] } {
	let lines = text.split("\n");
	// A goal the model wrote wins; without one the previous checkpoint's stays, so the open goal is never lost.
	if (goalLines(text).length === 0 && carried.goal.length > 0) {
		const range = sectionRange(lines, GOAL_HEADING);
		const block = [GOAL_HEADING, ...carried.goal];
		lines = range ? [...lines.slice(0, range.start), ...block, ...lines.slice(range.end)] : [...block, ...lines];
	}
	const lifts = liftsOf(lines);
	const lifted: LiftedBullet[] = [];
	for (const section of SECTIONS) {
		const previous = carried[section.key];
		const known = new Set(previous.map((bullet) => bullet.id));
		const range = sectionRange(lines, section.heading);
		const written = range ? bulletsOf(lines.slice(range.start + 1, range.end)) : [];
		const added: string[] = [];
		// What a new bullet may only restate: the carried bullets that stay, then each one added before it.
		const staying = previous.filter((bullet) => !lifts.has(bullet.id));
		const seen = new Set(staying.map((bullet) => normalize(bullet.text)));
		const standing: Words[] = staying.map((bullet) => wordsOf(bullet.text));
		for (const bullet of written) {
			if (EMPTY.test(bullet) || parseLift(bullet)) continue;
			const id = ID.exec(bullet);
			const normalizedId = id?.[1].toUpperCase();
			if (normalizedId && known.has(normalizedId)) continue;
			const body = id ? bullet.slice(id[0].length) : bullet;
			if (!body.trim() || seen.has(normalize(body))) continue;
			const words = wordsOf(body);
			if (standing.some((other) => restates(words, other))) continue;
			seen.add(normalize(body));
			standing.push(words);
			added.push(body);
		}
		let next = Math.max(0, ...previous.map((bullet) => idNumber(bullet.id)));
		for (const bullet of previous) {
			const reason = lifts.get(bullet.id);
			if (reason !== undefined) lifted.push({ ...bullet, reason });
		}
		const bullets = [...staying, ...added.map((body) => ({ id: `${section.prefix}${++next}`, text: body }))];
		if (!range && bullets.length === 0) continue;
		const rendered = bullets.length > 0 ? bullets.map((bullet) => `- [${bullet.id}] ${bullet.text}`) : ["- (none)"];
		const block = [section.heading, ...rendered];
		if (range) {
			const trailing = range.end < lines.length && lines[range.end - 1]?.trim() === "" ? [""] : [];
			lines = [...lines.slice(0, range.start), ...block, ...trailing, ...lines.slice(range.end)];
		} else {
			const at = insertAt(lines, section);
			const before = at > 0 && lines[at - 1].trim() !== "" ? [""] : [];
			const after = at < lines.length ? [""] : [];
			lines = [...lines.slice(0, at), ...before, ...block, ...after, ...lines.slice(at)];
		}
	}
	return { text: lines.join("\n"), lifted };
}

/** The ledger step of one summary: the carried ledger read from `previous`, and the summary's text rebuilt over it. */
export function carryLedger(text: string, previous: string | undefined): { text: string; lifted: LiftedBullet[] } {
	return applyLedger(text, ledgerOf(previous));
}
