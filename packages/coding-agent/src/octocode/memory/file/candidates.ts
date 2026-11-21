import { storedText } from "@octocodeai/octocode-common/sanitize";
import {
	CONSTRAINTS_HEADING,
	DECISIONS_HEADING,
	ERRORS_HEADING,
	summarySection,
} from "../../../core/compaction/summary-format.ts";
import { clipText } from "../../shared/util.ts";
import { MemoryError } from "../errors.ts";
import { normalizeTitle } from "../query.ts";
import type { Memory, MemoryKind } from "../record.ts";
import type { MemoryStore } from "../store.ts";
import { CANDIDATE_TAG, isCandidate, isQuarantined, QUARANTINE_TAG } from "./candidate-tags.ts";

/**
 * The queue of lesson candidates: the bullets of a checkpoint's "Constraints & Preferences", "Key Decisions" and "Errors
 * & Fixes", and the `Noticed:` lines of a child's report, kept as notes of the repository (`project` scope) tagged
 * `memory-candidate`. A checkpoint holds task-scoped detail, so a candidate never reaches a MEMORY.md file by itself: a
 * reflection or consolidation pass (`reflect.ts`) decides, and a consolidation pass drops what it considered. Recall and the
 * store's duplicate check leave candidates out (`candidate-tags.ts`).
 */

/** Candidates a repository keeps queued; past it the oldest pending ones go. */
const MAX_QUEUED = 120;
/** Notes read when looking for candidates; candidates are a small share of a repository's notes. */
const SCAN = 600;
const MAX_TEXT = 400;
/** A shorter bullet ("Tests pass.") carries no lesson. */
const MIN_TEXT = 16;

type CandidateOrigin = "checkpoint" | "child" | "reflection";

export interface CandidateInput {
	text: string;
	kind: MemoryKind;
	origin: CandidateOrigin;
	/** Where it came from: `session <id>, entry <id>`. */
	evidence: string;
	/** Why it is quarantined (`quarantine.ts`); a quarantined candidate is never shown to a pass. */
	quarantine?: string;
}

/** Every candidate of the repository, newest first: pending and quarantined. */
export function listCandidates(store: Pick<MemoryStore, "list">): Memory[] {
	return store.list("project", SCAN).filter(isCandidate);
}

/** The candidates a pass may use: newest first, the quarantined left out. */
export const pendingCandidates = (all: readonly Memory[]): Memory[] => all.filter((memory) => !isQuarantined(memory));

const EMPTY = /^\(?none\)?\.?$/i;
/** A ledger bullet's carried id (`[C3] `), and a lift the summarizer wrote (`Lifted [C3]: …`), which is no rule. */
const LEDGER_ID = /^\[[CD]\d+\]\s*/;
const LIFT = /^(?:lifted|superseded|withdrawn)\b|^\[[CD]\d+\]\s*(?:lifted|superseded|withdrawn)\b/i;

/** A bullet as candidate text: one line, ledger id and bold markup gone; undefined for `(none)`, a lift or a fragment. */
function candidateText(raw: string): string | undefined {
	const text = storedText(raw)
		.replace(/^[-*]\s+/, "")
		.replace(/^\[[ xX]\]\s+/, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!text || EMPTY.test(text) || LIFT.test(text)) return undefined;
	const plain = text
		.replace(LEDGER_ID, "")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/__([^_]+)__/g, "$1")
		.trim();
	return plain.length < MIN_TEXT ? undefined : clipText(plain, MAX_TEXT);
}

/** The bullets of the section headed `heading` in `summary`: a `- ` line starts one, any other line continues it. */
function bullets(summary: string, heading: string): string[] {
	const out: string[] = [];
	for (const line of summarySection(summary, heading)) {
		if (/^[-*]\s+/.test(line) || out.length === 0) out.push(line);
		else out[out.length - 1] += ` ${line}`;
	}
	return out;
}

/** The candidates a checkpoint holds: its standing rules, decisions, and failures with their lessons. */
export function checkpointCandidates(summary: string): Array<{ text: string; kind: MemoryKind }> {
	const sections: Array<[string, MemoryKind]> = [
		[CONSTRAINTS_HEADING, "preference"],
		[DECISIONS_HEADING, "decision"],
		[ERRORS_HEADING, "gotcha"],
	];
	return sections.flatMap(([heading, kind]) =>
		bullets(summary, heading).flatMap((bullet) => {
			const text = candidateText(bullet);
			return text ? [{ text, kind }] : [];
		}),
	);
}

/** `Noticed:` as a report writes it, bold, bulleted or as a heading (`subagent/report.md`), and the text after it. */
const NOTICED = /^[\s*_#>-]*noticed[\s*_]*:[\s*_]*(.*)$/i;

/** The `Noticed:` text of a child's report: the line's own text and the bullets right under it, `none` left out. */
export function noticedLines(report: string): string[] {
	const out: string[] = [];
	let inside = false;
	for (const raw of report.split(/\r?\n/)) {
		const line = raw.trim();
		const noticed = NOTICED.exec(line);
		const text = noticed
			? candidateText(noticed[1])
			: inside && /^[-*]\s+/.test(line)
				? candidateText(line)
				: undefined;
		// Bullets right under the label belong to it; anything else (a blank line, another label, prose) ends it.
		inside = noticed !== null || (inside && /^[-*]\s+/.test(line));
		if (text) out.push(text);
	}
	return out;
}

/**
 * Queues `items` as candidates of the session `session`. Text already queued, a secret, and text a saved note already
 * holds (the store's duplicate check) are skipped. Past `MAX_QUEUED` the oldest pending candidates go. Returns how many
 * were queued.
 */
export function queueCandidates(
	store: Pick<MemoryStore, "list" | "set" | "delete">,
	items: readonly CandidateInput[],
	session: string,
	now = Date.now(),
): number {
	if (items.length === 0) return 0;
	const queued = listCandidates(store);
	const known = new Set(queued.map((memory) => normalizeTitle(memory.title)));
	let added = 0;
	for (const item of items) {
		const key = normalizeTitle(item.text);
		if (!key || known.has(key)) continue;
		known.add(key);
		try {
			store.set(
				{
					title: item.text,
					body: item.quarantine ? `${item.evidence}. Quarantined: ${item.quarantine}.` : `${item.evidence}.`,
					kind: item.kind,
					scope: "project",
					keywords: [item.quarantine ? QUARANTINE_TAG : CANDIDATE_TAG, item.origin].join(" "),
					author: item.origin === "reflection" ? "reflection" : "agent",
					sourceSession: session,
				},
				now,
			);
			added++;
		} catch (error) {
			// A secret, or a note that already holds it: nothing to queue.
			if (!(error instanceof MemoryError)) throw error;
		}
	}
	if (added > 0) {
		const pending = pendingCandidates(listCandidates(store));
		dropCandidates(
			store,
			pending.slice(MAX_QUEUED).map((memory) => memory.id),
		);
	}
	return added;
}

/** Removes candidates a pass considered (or the queue's bound pushed out); one already gone is skipped. */
export function dropCandidates(store: Pick<MemoryStore, "delete">, ids: readonly number[]): void {
	for (const id of ids) {
		try {
			store.delete(id);
		} catch (error) {
			if (!(error instanceof MemoryError)) throw error;
		}
	}
}
