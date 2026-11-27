import { isRecord } from "@octocodeai/octocode-contracts/guards";

/**
 * The outcomes of a `file` result that changed a file: each applied (`ok`) outcome with the path it names, whether the
 * call used `queries` or `patch`. The one rule for which paths a `file` call changed.
 */
export function appliedFileOutcomes(details: unknown): Array<Record<string, unknown> & { path: string }> {
	const outcomes = isRecord(details) && Array.isArray(details.outcomes) ? details.outcomes : [];
	return outcomes.filter(
		(outcome): outcome is Record<string, unknown> & { path: string } =>
			isRecord(outcome) && outcome.ok === true && typeof outcome.path === "string",
	);
}
