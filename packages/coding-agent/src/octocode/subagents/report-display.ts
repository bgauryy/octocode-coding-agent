import { OUTCOME_LABEL, reportOutcome } from "./report-outcome.ts";

/** Where `ReportTracker` joins the reports a child gave one after another (a follow-up message, a failed later turn). */
const SEPARATOR = "\n\n---\n\n";
const FOLLOW_UP = "Follow-up to the report above (";
const FAILED_FOLLOW_UP = "(A later follow-up turn failed:";

/**
 * `report` without the outcome word it opens with, for the screen only: the summary row above it already says `Done`,
 * `Blocked` or `Partial`. The text the model reads keeps the word. A word that starts a sentence (`Done with the audit`)
 * and markup the strip would unbalance stay as written.
 */
export function withoutOutcome(report: string): string {
	const found = reportOutcome(report);
	if (!found) return report;
	const body = report.trim();
	if (found.source === "last") return body.slice(0, Math.max(0, body.lastIndexOf("\n"))).trimEnd();
	const lead = body.replace(OUTCOME_LABEL, "");
	const token = /^\S+/.exec(lead)?.[0] ?? "";
	const marks = /^[*_`]*/.exec(token)?.[0] ?? "";
	const afterWord = token.replace(/^[^\p{L}]+/u, "").replace(/^\p{L}+/u, "");
	const punctuated = /[:.,;!—–-]/u.test(afterWord);
	const alone = !/\S/.test(lead.slice(token.length).split("\n", 1)[0] ?? "");
	if ((marks && !token.slice(marks.length).includes(marks)) || !(punctuated || alone)) return report;
	return lead.slice(token.length).trim();
}

/** A section after the first that starts a report of its own (a follow-up answer) rather than continuing the text before it. */
const startsReport = (section: string) => section.startsWith(FOLLOW_UP) || reportOutcome(section)?.source === "first";

/** A section without its outcome word; the follow-up label (`Follow-up to the report above (…):`) stays only when `label` (the report above is shown). */
function clean(section: string, label: boolean): string {
	if (!section.startsWith(FOLLOW_UP)) return withoutOutcome(section).trim();
	const [head = "", ...rest] = section.split("\n");
	const body = withoutOutcome(rest.join("\n")).trim();
	return label ? `${head}\n${body}`.trim() : body;
}

/**
 * The report as drawn: collapsed, the latest report with its outcome word dropped and `earlier` counting the older
 * ones; expanded, every report, each without its outcome word. A later turn's failure note stays with the latest.
 */
export function displayReport(text: string, expanded: boolean): { text: string; earlier: number } {
	const parts = text.split(SEPARATOR);
	const reports = [parts[0] ?? ""];
	let tail = "";
	for (const [index, part] of parts.slice(1).entries()) {
		if (index === parts.length - 2 && part.startsWith(FAILED_FOLLOW_UP)) tail = part;
		else if (startsReport(part)) reports.push(part);
		else reports[reports.length - 1] += `${SEPARATOR}${part}`;
	}
	const shown = expanded ? reports : reports.slice(-1);
	const cleaned = shown.map((report) => clean(report, expanded));
	const earlier = expanded ? 0 : reports.length - shown.length;
	return { text: [...cleaned, tail].filter(Boolean).join(SEPARATOR), earlier };
}
