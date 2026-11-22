import { normalizeTitle } from "../query.ts";

/**
 * Which extracted bullets are worth queueing as memory candidates: a whole sentence that states a decision, a standing
 * preference or a gotcha that is still true. A heading cut off at a colon, a child's remark about its own run, a
 * resolved item and a run's status say nothing a later session needs, and a near-repeat of a queued line is the same
 * lesson.
 */

/** A shorter line is a label, not a sentence. */
const MIN_WORDS = 4;

/** The child's own run: what it did or did not do, found or left alone. */
const CHATTER =
	/^(?:i|we)\s+(?:did\s*n[o']t|didn['’]t|have\s*n[o']t|haven['’]t|only|just|also|ran|read|checked|left|touched|made|found no)\b/i;
/** A resolved item or per-run progress: it was true of one run only. */
const RESOLVED =
	/^(?:fixed|resolved|done|completed|landed|merged|committed|verified|addressed|closed)\b|^(?:next|todo|status|progress|pending|in progress)\s*:/i;
const RESOLVED_TAIL = /[\s—-]\(?(?:fixed|resolved|done|completed|landed|merged)\)?\.?$/i;
const PASSING = /\b(?:now\s+|all\s+)?(?:pass(?:es|ed)?|green|clean)\.?$/i;
const NOTHING = /^(?:nothing|no\s+\w+(?:\s+\w+)?\s+(?:found|noticed|to report))\b/i;

/** Whether `text` (one line, markup stripped) states something durable as a whole sentence. */
export function isDurable(text: string): boolean {
	if (/[:;,]$/.test(text)) return false;
	if (text.split(/\s+/).length < MIN_WORDS) return false;
	const words = text.split(/\s+/).length;
	return !(
		CHATTER.test(text) ||
		NOTHING.test(text) ||
		RESOLVED.test(text) ||
		RESOLVED_TAIL.test(text) ||
		(words <= 6 && PASSING.test(text))
	);
}

/** Words that carry the meaning of a lesson: the rest of a rewording changes nothing. */
const FILLER = new Set([
	"the",
	"a",
	"an",
	"and",
	"or",
	"to",
	"of",
	"is",
	"are",
	"it",
	"that",
	"since",
	"because",
	"so",
]);
const SAME = 0.7;

export function lessonWords(text: string): Set<string> {
	return new Set(
		normalizeTitle(text)
			.split(" ")
			.filter((word) => word && !FILLER.has(word)),
	);
}

/** Whether two lessons share most of their meaningful words (Jaccard overlap of at least 0.7). */
export function sameLesson(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	if (a.size === 0 || b.size === 0) return false;
	let shared = 0;
	for (const word of a) if (b.has(word)) shared++;
	return shared / (a.size + b.size - shared) >= SAME;
}
