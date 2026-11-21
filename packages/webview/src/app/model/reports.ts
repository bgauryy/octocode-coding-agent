import type { ReportSummary, ReportsIndex } from "@octocodeai/octocode-contracts/protocol";
import { hashFor } from "./route.ts";

const REPORT_TABS = ["rfc", "research"] as const;
export type ReportTab = (typeof REPORT_TABS)[number];

/** The kinds each tab lists; research briefs and brainstorms share the Research tab. */
export const TAB_KINDS: Record<ReportTab, readonly ReportSummary["kind"][]> = {
	rfc: ["rfc"],
	research: ["research", "brainstorm"],
};
export const KIND_LABELS: Record<ReportSummary["kind"], string> = {
	rfc: "RFC",
	research: "Research",
	brainstorm: "Brainstorm",
};

const REPORT_PATH =
	/^(?:.*\/)?\.octocode\/agent\/(octocode-rfc-generator|octocode-research|octocode-brainstorming)\/([^/?#]+?)(?:\/([^/?#]+\.md))?\/?$/;
const DIR_INFO = {
	"octocode-rfc-generator": { tab: "rfc", kind: "rfc" },
	"octocode-research": { tab: "research", kind: "research" },
	"octocode-brainstorming": { tab: "research", kind: "brainstorm" },
} as const;

/** Where a files link to a saved report opens: the tab that lists its kind, plus the report id and optional file. */
export function reportLinkDestination(
	linkPath: string,
): { tab: ReportTab; id: string; kind: ReportSummary["kind"]; file?: string } | undefined {
	const match = REPORT_PATH.exec(linkPath.trim());
	if (!match) return undefined;
	const info = DIR_INFO[match[1] as keyof typeof DIR_INFO];
	return { tab: info.tab, kind: info.kind, id: match[2], file: match[3] };
}

/** A link href for a report path, or undefined when the path is not a saved report. */
export function reportLinkHref(linkPath: string): string | undefined {
	const destination = reportLinkDestination(linkPath);
	if (!destination) return undefined;
	return hashFor(
		destination.tab,
		destination.file
			? { id: destination.id, kind: destination.kind, file: destination.file }
			: { id: destination.id, kind: destination.kind },
	);
}

/** Only the kinds a tab lists; the host stays the authority for what exists. */
export function tabReports(index: ReportsIndex, tab: ReportTab): ReportSummary[] {
	return index.reports.filter((report) => TAB_KINDS[tab].includes(report.kind));
}
