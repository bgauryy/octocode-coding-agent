import fs from "node:fs";
import { atomicWriteFileSync } from "@octocodeai/octocode-common/atomic-file";
import { claims, type Report } from "./pending.ts";

/** Brings a report's recovery copy up to date with the wake and content it now has. */
export function rewriteClaim(report: Report): void {
	const claim = claims.get(report);
	if (!claim) return;
	try {
		const saved = JSON.parse(fs.readFileSync(claim.claim, "utf8")) as Report;
		atomicWriteFileSync(
			claim.claim,
			JSON.stringify({ ...saved, wake: report.wake, content: report.content, superseded: report.superseded }),
			{ mode: 0o600 },
		);
	} catch {
		// Keep live delivery working if recovery storage became unavailable.
	}
}
