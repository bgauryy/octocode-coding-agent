import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { compareRuns, formatComparison, invalidReasons, pairedInterval, VERDICT_EXIT } from "../lib/compare.mjs";

const summary = (cost, extra = {}) => ({
	cost,
	requests: 10,
	turns: 8,
	multiCallTurns: 2,
	toolCalls: 12,
	missingCost: 0,
	leakCalls: 0,
	skillLoads: [],
	tools: { octocode: 3, bashRead: 1 },
	tokens: { input: 10, cacheRead: 90, cacheWrite: 0, output: 5 },
	...extra,
});

const row = (taskId, grade, cost, extra = {}) => ({
	trialId: `${taskId}-r1`,
	taskId,
	split: "heldout",
	delegates: null,
	status: "completed",
	grade,
	total: summary(cost),
	children: [],
	...extra,
});

const runOf = (rows, manifest = {}) => ({
	dir: "x",
	rows,
	manifest: {
		suiteHash: "s",
		harnessHash: "h",
		ref: "r",
		model: "m",
		seed: 1,
		split: "all",
		runs: 1,
		status: "complete",
		plannedTrials: rows.map((item) => item.trialId),
		...manifest,
	},
});

const costs = (values, grades = values.map(() => "pass"), extra = {}) =>
	runOf(values.map((cost, index) => row(`q-${index}`, grades[index], cost, extra)));

test("Accept: correctness holds, cost is lower on every task, held-out ran", () => {
	const result = compareRuns(costs([1, 2, 3, 4]), costs([0.5, 1.5, 2.5, 3.5]));
	assert.equal(result.decision.gate, true);
	assert.equal(result.decision.verdict, "Accept");
	assert.ok(result.costInterval.high < 0);
	assert.equal(result.baseline.costPerTask, 2.5);
	assert.equal(result.candidate.costPerTask, 2);
});

test("Revert: cheaper but less correct", () => {
	const result = compareRuns(costs([1, 1, 1, 1]), costs([0.1, 0.1, 0.1, 0.1], ["pass", "pass", "pass", "fail"]));
	assert.equal(result.decision.gate, false);
	assert.equal(result.decision.correctnessHolds, false);
	assert.equal(result.decision.verdict, "Revert");
	assert.deepEqual(result.regressions, ["q-3"]);
});

test("Revert: as correct but not cheaper, equal cost included", () => {
	assert.equal(compareRuns(costs([1, 1]), costs([1.5, 1.5])).decision.verdict, "Revert");
	const equal = compareRuns(costs([1, 1]), costs([1, 1]));
	assert.equal(equal.decision.costLower, false);
	assert.equal(equal.decision.verdict, "Revert");
});

test("more correct at higher cost still fails: the gate wants both", () => {
	const result = compareRuns(costs([1, 1], ["fail", "pass"]), costs([2, 2]));
	assert.equal(result.decision.correctnessHolds, true);
	assert.equal(result.decision.verdict, "Revert");
	assert.deepEqual(result.improvements, ["q-0"]);
});

test("Octocode share decides nothing", () => {
	const none = (cost) => row("q-0", "pass", cost, { total: summary(cost, { tools: { octocode: 0, bashRead: 9 } }) });
	const baseline = runOf([row("q-0", "pass", 2), row("q-1", "pass", 2)]);
	const candidate = runOf([none(1), { ...none(1), taskId: "q-1", trialId: "q-1-r1" }]);
	const result = compareRuns(baseline, candidate);
	assert.equal(result.candidate.octocodeShare, 0);
	assert.equal(result.decision.verdict, "Accept");
});

test("Inconclusive: a mean saving the interval does not support", () => {
	const result = compareRuns(costs([1, 1, 1, 1]), costs([0.1, 0.1, 0.1, 2.5]));
	assert.equal(result.decision.gate, true);
	assert.equal(result.decision.verdict, "Inconclusive");
});

test("Inconclusive: development tasks alone cannot accept", () => {
	const dev = (values) =>
		costs(
			values,
			values.map(() => "pass"),
			{ split: "dev" },
		);
	const result = compareRuns(dev([1, 1, 1]), dev([0.5, 0.5, 0.5]));
	assert.equal(result.decision.gate, true);
	assert.equal(result.decision.verdict, "Inconclusive");
	assert.match(result.decision.reasons[0], /held-out/);
});

test("Invalid: arms that cannot be compared, whatever the numbers say", () => {
	const good = () => costs([1, 1]);
	for (const [change, pattern] of [
		[{ suiteHash: "other" }, /suiteHash/],
		[{ harnessHash: "other" }, /harnessHash/],
		[{ ref: "other" }, /ref differs/],
		[{ model: "other" }, /model differs/],
		[{ status: "stopped-budget" }, /stopped-budget/],
		[{ plannedTrials: ["q-0-r1", "q-1-r1", "q-2-r1"] }, /missing 1 planned/],
	]) {
		const candidate = costs([0.1, 0.1]);
		candidate.manifest = { ...candidate.manifest, ...change };
		const result = compareRuns(good(), candidate);
		assert.equal(result.decision.verdict, "Invalid", JSON.stringify(change));
		assert.ok(
			result.decision.reasons.some((reason) => pattern.test(reason)),
			JSON.stringify(result.decision.reasons),
		);
	}
});

test("Invalid: infrastructure errors, grader errors, leaks and unpriced requests", () => {
	const cases = [
		[{ status: "infra-error" }, /infrastructure/],
		[{ grade: "error" }, /grader/],
		[{ total: summary(1, { leakCalls: 1 }) }, /eval kit/],
		[{ total: summary(1, { missingCost: 2 }) }, /no cost/],
	];
	for (const [change, pattern] of cases) {
		const candidate = runOf([row("q-0", "pass", 0.1, change)]);
		const reasons = invalidReasons(runOf([row("q-0", "pass", 1)]), candidate);
		assert.ok(
			reasons.some((reason) => pattern.test(reason)),
			JSON.stringify(reasons),
		);
	}
});

test("a failed trial's cost counts, and repeats average within a task", () => {
	const rows = [
		row("q-0", "pass", 1, { trialId: "q-0-r1" }),
		row("q-0", "fail", 3, { trialId: "q-0-r2" }),
		row("q-1", "pass", 4, { trialId: "q-1-r1" }),
	];
	const result = compareRuns(runOf(rows), runOf(rows));
	assert.equal(result.baseline.costPerTask, 3);
	assert.equal(result.baseline.correctness, 2 / 3);
	assert.equal(result.baseline.costPerPass, 4);
	assert.equal(result.tasks[0].baselinePass, 0.5);
});

test("the interval repeats for a seed and brackets a constant", () => {
	assert.deepEqual(pairedInterval([-1, -1, -1]), { low: -1, high: -1 });
	assert.deepEqual(pairedInterval([-3, 1, 2, -5]), pairedInterval([-3, 1, 2, -5]));
	assert.equal(pairedInterval([]), null);
});

test("the report shows both arms, routes and the verdict", () => {
	const child = { role: "researcher", requests: 7, cost: 0.2, models: { "claude-haiku-5-5": 7 } };
	const baseline = costs([1, 2], undefined, { delegates: "researcher", children: [child] });
	const result = compareRuns(baseline, costs([0.5, 1], undefined, { delegates: "researcher", children: [child] }));
	const report = formatComparison(result);
	for (const text of [
		"Correctness",
		"Cost per task",
		"Turns per trial",
		"Cache hit rate",
		"Octocode share",
		"researcher: 2 runs",
		"claude-haiku-5-5 x14",
		"Slice delegating",
		"Gate (",
		"Verdict: ",
	]) {
		assert.ok(report.includes(text), text);
	}
});

test("the CLI prints the verdict and exits with its code; bad usage exits 64", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "oc-compare-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const write = (name, run) => {
		const folder = join(dir, name);
		spawnSync("mkdir", [folder]);
		writeFileSync(join(folder, "run.json"), JSON.stringify(run.manifest));
		writeFileSync(join(folder, "results.jsonl"), run.rows.map((item) => JSON.stringify(item)).join("\n"));
		return folder;
	};
	const cli = resolve(import.meta.dirname, "..", "compare.mjs");
	const a = write("a", costs([1, 1]));
	const b = write("b", costs([2, 2]));
	const revert = spawnSync(process.execPath, [cli, a, b], { encoding: "utf8" });
	assert.equal(revert.status, VERDICT_EXIT.Revert);
	assert.match(revert.stdout, /Verdict: Revert/);
	const json = spawnSync(process.execPath, [cli, a, b, "--json"], { encoding: "utf8" });
	assert.equal(JSON.parse(json.stdout).decision.verdict, "Revert");
	assert.equal(spawnSync(process.execPath, [cli, a], { encoding: "utf8" }).status, 64);
});
