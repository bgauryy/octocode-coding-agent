import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { profileMarkdown, summarizeProfile } from "./replay-profile.mjs";

const frame = (functionName, line) => ({
	functionName,
	url: "file:///repo/packages/coding-agent/src/octocode/demo/a.ts",
	lineNumber: line,
	columnNumber: 0,
});

/** root > f > g > f (recursion): f runs 10 ms, then 20 ms in the inner call, g 30 ms. */
const profile = {
	nodes: [
		{ id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: -1, columnNumber: -1 }, children: [2] },
		{ id: 2, callFrame: frame("f", 0), children: [3] },
		{ id: 3, callFrame: frame("g", 10), children: [4] },
		{ id: 4, callFrame: frame("f", 0) },
	],
	samples: [2, 3, 4],
	// Sample i lasted until sample i + 1.
	timeDeltas: [0, 10_000, 30_000, 20_000],
};

function summarize() {
	const dir = mkdtempSync(join(tmpdir(), "replay-profile-"));
	try {
		const file = join(dir, "x.cpuprofile");
		writeFileSync(file, JSON.stringify(profile));
		const summary = summarizeProfile(file);
		return { summary, markdown: profileMarkdown(file, summary) };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("reports self and inclusive time per function, counting recursion once", () => {
	const { summary } = summarize();
	const byName = Object.fromEntries(summary.hotspots.map((row) => [row.name, row]));
	assert.equal(summary.totalMs, 60);
	assert.deepEqual([byName.f.ms, byName.f.totalMs, byName.f.totalPct], [30, 60, 100]);
	assert.deepEqual([byName.g.ms, byName.g.totalMs, byName.g.totalPct], [30, 50, 83.3]);
});

test("the Markdown table has self and total columns", () => {
	const { markdown } = summarize();
	assert.match(markdown, /\| self ms \| self % \| total ms \| total % \|/);
	assert.match(markdown, /\| `g` \|.*\| 30 \| 50 \| 50 \| 83\.3 \|/);
});
