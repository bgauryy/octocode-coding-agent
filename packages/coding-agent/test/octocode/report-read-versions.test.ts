import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ReadReports } from "../../src/octocode/subagents/handoff/scratch.ts";
import { snapshotReport } from "../../src/octocode/shared/report-artifact.ts";
import { tmp } from "./helpers.ts";

function saved(text: string, scratch = tmp()) {
	const file = path.join(scratch, "report.md");
	fs.writeFileSync(file, text);
	return { file, scratch, artifact: snapshotReport(file) };
}
function observe(reads: ReadReports, file: string, digest: string) {
	reads.observe("mcp__octocode__localFetch", {}, path.dirname(file), {
		localReads: [{ file, sha256: digest, size: fs.statSync(file).size, whole: true }],
	});
}

describe("report read acknowledgements", () => {
	it("acknowledges a verified read of the exact immutable report version", () => {
		const { scratch, artifact } = saved("done: current");
		const reads = new ReadReports();
		reads.track("worker", scratch);
		observe(reads, artifact.path!, artifact.sha256);
		expect(reads.consume("worker", artifact)).toBe(true);
	});

	it("keeps a newer report unread when the parent only read its predecessor", () => {
		const first = saved("done: old");
		const reads = new ReadReports();
		reads.track("worker", first.scratch);
		observe(reads, first.artifact.path!, first.artifact.sha256);
		const next = saved("done: new", first.scratch);
		expect(reads.consume("worker", next.artifact)).toBe(false);
	});

	it("does not acknowledge a short correction from a stale canonical report read", () => {
		const first = saved("done: old");
		const reads = new ReadReports();
		reads.track("worker", first.scratch);
		observe(reads, first.file, first.artifact.sha256);
		expect(reads.consume("worker", { sha256: "a".repeat(64) })).toBe(false);
	});

	it("credits a canonical report read only when its verified digest matches this version", () => {
		const current = saved("done: current");
		const reads = new ReadReports();
		reads.track("worker", current.scratch);
		observe(reads, current.file, current.artifact.sha256);
		expect(reads.consume("worker", current.artifact)).toBe(true);
	});
});
