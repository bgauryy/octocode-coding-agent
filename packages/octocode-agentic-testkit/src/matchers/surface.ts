import type { IssueKind, SurfaceReport } from "../surface.ts";
import { cannot, type Result } from "./shared.ts";

function asReport(v: unknown): SurfaceReport {
	const r = v as Partial<SurfaceReport> | null;
	if (!r || !Array.isArray(r.items) || !Array.isArray(r.issues) || typeof r.totalChars !== "number")
		return cannot("received value is not a SurfaceReport (build one with analyzeSurface)");
	return r as SurfaceReport;
}

export const surfaceMatchers = {
	toPassSurfaceReview(received: unknown, o: { allow?: IssueKind[] } = {}): Result {
		const report = asReport(received);
		const issues = report.issues.filter((i) => !o.allow?.includes(i.kind));
		const listed = issues.map((i) => `${i.kind} ${i.target}: ${i.detail}`).join("\n  ");
		return {
			pass: issues.length === 0,
			message: () =>
				issues.length
					? `surface issues (${report.totalChars} chars, ~${report.estTokens} tokens):\n  ${listed}`
					: `expected surface issues, found none (${report.totalChars} chars, ~${report.estTokens} tokens)`,
		};
	},
};
