import type { ProfileFinding } from "@octocodeai/octocode-contracts";
import { span } from "../../model/format.ts";
import { formatCost, formatTokens } from "../profiler-model.ts";
import {
	CHECK_LABELS,
	evidenceLabel,
	evidenceSelection,
	groupFindings,
	orderFindings,
	summarizeFindings,
} from "./insight-model.ts";
import type { ProfileSelection } from "./panel-props.ts";

export interface InsightsPanelProps {
	findings: ProfileFinding[] | undefined;
	/** Opens the first evidence (or the one picked) in the shared drawer. */
	onSelect: (selection: ProfileSelection) => void;
	/** The finding the person is looking at: the Trace rings all of its evidence. */
	onEvidence?: (finding: ProfileFinding) => void;
}

function costChip(finding: ProfileFinding): string {
	return [
		finding.cost !== undefined && formatCost(finding.cost),
		finding.tokens !== undefined && `${formatTokens(finding.tokens)} tokens`,
		finding.waitedMs !== undefined && `${span(finding.waitedMs)} waited`,
	]
		.filter(Boolean)
		.join(" \u00B7 ");
}

function Finding({
	finding,
	onSelect,
	onEvidence,
}: { finding: ProfileFinding } & Omit<InsightsPanelProps, "findings">) {
	const first = finding.evidence[0];
	const open = (selection: ProfileSelection | undefined) => {
		onEvidence?.(finding);
		if (selection) onSelect(selection);
	};
	const chip = costChip(finding);
	return (
		<li className={`pf-i-row is-${finding.severity}`}>
			<button type="button" className="pf-i-head" onClick={() => open(first && evidenceSelection(first))}>
				<span className={`pf-pill is-sev-${finding.severity}`}>{finding.severity}</span>
				<span className="pf-i-title">{finding.title}</span>
				{chip ? <span className="pf-i-cost">{chip}</span> : null}
				{finding.agentId ? <span className="pf-i-agent">{finding.agentId}</span> : null}
				<span className="pf-i-detail">{finding.detail}</span>
			</button>
			{finding.evidence.length > 0 ? (
				<p className="pf-i-evidence">
					<span className="muted">Evidence</span>
					{finding.evidence.map((item) => (
						<button
							key={`${item.agentId}:${item.request ?? ""}:${item.event ?? ""}`}
							type="button"
							className="pf-t-btn"
							onClick={() => open(evidenceSelection(item))}
						>
							{evidenceLabel(item)}
						</button>
					))}
				</p>
			) : null}
		</li>
	);
}

/**
 * Findings like a Lighthouse audit: failed first, a one-line summary, repeated kinds folded into groups, and the checks
 * that passed folded away. Clicking a finding opens its evidence in the drawer and rings it in the Trace.
 */
export function InsightsPanel({ findings, onSelect, onEvidence }: InsightsPanelProps) {
	if (!findings) return <output className="muted">Loading insights…</output>;
	const summary = summarizeFindings(findings);
	const passedLine = `${summary.passed.length} ${summary.passed.length === 1 ? "check" : "checks"} passed`;
	const line = [
		summary.issues ? `${summary.issues} ${summary.issues === 1 ? "issue" : "issues"}` : "No issues found",
		summary.cost > 0 && `${formatCost(summary.cost)} avoidable`,
		summary.waitedMs > 0 && `${span(summary.waitedMs)} waited`,
		passedLine,
	]
		.filter(Boolean)
		.join(" \u00B7 ");
	const entries = groupFindings(orderFindings(findings));
	const rowProps = { onSelect, onEvidence };
	return (
		<section className="pf-insights" aria-label="Insights">
			<details className="pf-i-summary" open={!summary.issues}>
				<summary>{line}</summary>
				<ul className="pf-i-checks" aria-label="Checks that passed">
					{summary.passed.map((kind) => (
						<li key={kind}>
							<span aria-hidden="true">{"\u2713"}</span> {CHECK_LABELS[kind]}
						</li>
					))}
				</ul>
			</details>
			{summary.issues ? (
				<ul className="pf-i-list" aria-label="Findings, most costly first">
					{entries.map((entry) =>
						entry.type === "finding" ? (
							<Finding key={entry.finding.id} finding={entry.finding} {...rowProps} />
						) : (
							<li key={`group:${entry.kind}`} className="pf-i-group">
								<details>
									<summary>
										{CHECK_LABELS[entry.kind]} <span className="pf-chip">{entry.findings.length}</span>
									</summary>
									<ul className="pf-i-list">
										{entry.findings.map((finding) => (
											<Finding key={finding.id} finding={finding} {...rowProps} />
										))}
									</ul>
								</details>
							</li>
						),
					)}
				</ul>
			) : (
				<p className="pf-i-empty muted">Every check ran on this session and found nothing to change.</p>
			)}
		</section>
	);
}
