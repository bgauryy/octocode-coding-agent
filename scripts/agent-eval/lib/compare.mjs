/**
 * Compare two result folders and apply the ship gate: correctness no worse AND cost per task lower. Octocode share is
 * reported and decides nothing. The verdict words follow the octocode-eval-benchmark skill.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { seededRandom } from "./suite.mjs";

const BOOTSTRAP_ROUNDS = 2000;

export function loadRun(dir) {
	const manifest = JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
	const rows = readFileSync(join(dir, "results.jsonl"), "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line));
	return { dir, manifest, rows };
}

const mean = (values) => (values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);

/** Per task: its pass rate and mean cost over repeats. Failures stay in the denominator and their cost counts. */
function byTask(rows) {
	const tasks = new Map();
	for (const row of rows) {
		if (!tasks.has(row.taskId)) tasks.set(row.taskId, []);
		tasks.get(row.taskId).push(row);
	}
	return new Map(
		[...tasks].map(([id, trials]) => [
			id,
			{
				id,
				split: trials[0].split,
				delegates: trials[0].delegates,
				passRate: mean(trials.map((trial) => (trial.grade === "pass" ? 1 : 0))),
				cost: mean(trials.map((trial) => trial.total.cost)),
			},
		]),
	);
}

function totals(rows) {
	const sum = (read) => rows.reduce((total, row) => total + read(row), 0);
	const tasks = [...byTask(rows).values()];
	const passes = rows.filter((row) => row.grade === "pass").length;
	const tokens = (key) => sum((row) => row.total.tokens[key]);
	const prompt = tokens("input") + tokens("cacheRead") + tokens("cacheWrite");
	const octocode = sum((row) => row.total.tools.octocode);
	const bashRead = sum((row) => row.total.tools.bashRead);
	return {
		trials: rows.length,
		passes,
		correctness: rows.length > 0 ? passes / rows.length : 0,
		costPerTask: mean(tasks.map((task) => task.cost)),
		costPerPass: passes > 0 ? sum((row) => row.total.cost) / passes : null,
		turns: rows.length > 0 ? sum((row) => row.total.turns) / rows.length : 0,
		requests: rows.length > 0 ? sum((row) => row.total.requests) / rows.length : 0,
		cacheHitRate: prompt > 0 ? tokens("cacheRead") / prompt : null,
		octocodeShare: octocode + bashRead > 0 ? octocode / (octocode + bashRead) : null,
		octocode,
		bashRead,
		multiCallTurnShare:
			sum((row) => row.total.turns) > 0 ? sum((row) => row.total.multiCallTurns) / sum((row) => row.total.turns) : null,
		skillLoads: sum((row) => row.total.skillLoads.length),
		childCost: sum((row) => row.children.reduce((total, child) => total + child.cost, 0)),
	};
}

/** Roles and the models they ran on, with requests and cost: shows whether children took their real routes. */
function routes(rows) {
	const table = new Map();
	for (const row of rows) {
		for (const child of row.children) {
			const entry = table.get(child.role) ?? { role: child.role, runs: 0, requests: 0, cost: 0, models: {} };
			entry.runs++;
			entry.requests += child.requests;
			entry.cost += child.cost;
			for (const [model, count] of Object.entries(child.models))
				entry.models[model] = (entry.models[model] ?? 0) + count;
			table.set(child.role, entry);
		}
	}
	return [...table.values()].sort((a, b) => a.role.localeCompare(b.role));
}

/** Why these two folders cannot decide anything. */
export function invalidReasons(baseline, candidate) {
	const reasons = [];
	const a = baseline.manifest;
	const b = candidate.manifest;
	for (const key of ["suiteHash", "harnessHash", "ref", "model", "thinking", "seed", "split", "tasks", "runs"]) {
		if (a[key] !== b[key]) reasons.push(`${key} differs: ${a[key]} against ${b[key]}`);
	}
	for (const [label, run] of [
		["baseline", baseline],
		["candidate", candidate],
	]) {
		if (run.manifest.status !== "complete") reasons.push(`${label} run is ${run.manifest.status}`);
		const seen = new Set(run.rows.map((row) => row.trialId));
		const missing = run.manifest.plannedTrials.filter((id) => !seen.has(id));
		if (missing.length > 0) reasons.push(`${label} is missing ${missing.length} planned trials: ${missing.join(", ")}`);
		for (const row of run.rows) {
			if (row.status === "infra-error") reasons.push(`${label} ${row.trialId}: infrastructure error`);
			if (row.grade === "error") reasons.push(`${label} ${row.trialId}: a grader could not decide`);
			if (row.total.leakCalls > 0) reasons.push(`${label} ${row.trialId}: a tool call named the eval kit`);
			if (row.total.missingCost > 0)
				reasons.push(`${label} ${row.trialId}: ${row.total.missingCost} requests have no cost`);
		}
	}
	return reasons;
}

/**
 * Paired bootstrap over tasks of the candidate-minus-baseline mean: the 95% interval. Tasks are the unit, since repeats
 * of one task are not independent.
 */
export function pairedInterval(differences, seed = 1) {
	if (differences.length === 0) return null;
	const random = seededRandom(seed);
	const means = [];
	for (let round = 0; round < BOOTSTRAP_ROUNDS; round++) {
		let total = 0;
		for (let index = 0; index < differences.length; index++) {
			total += differences[Math.floor(random() * differences.length)];
		}
		means.push(total / differences.length);
	}
	means.sort((x, y) => x - y);
	return { low: means[Math.floor(BOOTSTRAP_ROUNDS * 0.025)], high: means[Math.floor(BOOTSTRAP_ROUNDS * 0.975)] };
}

/** The whole comparison; `decision.verdict` is Accept, Revert, Inconclusive or Invalid. */
export function compareRuns(baseline, candidate) {
	const a = totals(baseline.rows);
	const b = totals(candidate.rows);
	const baseTasks = byTask(baseline.rows);
	const candTasks = byTask(candidate.rows);
	const shared = [...baseTasks.keys()].filter((id) => candTasks.has(id));
	const pairs = shared.map((id) => ({ id, base: baseTasks.get(id), cand: candTasks.get(id) }));
	const costInterval = pairedInterval(pairs.map((pair) => pair.cand.cost - pair.base.cost));
	const correctnessInterval = pairedInterval(pairs.map((pair) => pair.cand.passRate - pair.base.passRate));
	const regressions = pairs.filter((pair) => pair.cand.passRate < pair.base.passRate).map((pair) => pair.id);
	const improvements = pairs.filter((pair) => pair.cand.passRate > pair.base.passRate).map((pair) => pair.id);
	const correctnessHolds = b.correctness >= a.correctness;
	const costLower = b.costPerTask < a.costPerTask;
	const gate = correctnessHolds && costLower;
	const heldOutRun = pairs.some((pair) => pair.base.split === "heldout");
	const reasons = invalidReasons(baseline, candidate);
	if (pairs.length === 0) reasons.push("no task ran in both arms");
	const decision = { gate, correctnessHolds, costLower, reasons: [], verdict: "Accept" };
	if (reasons.length > 0) {
		decision.verdict = "Invalid";
		decision.reasons = reasons;
	} else if (!gate) {
		decision.verdict = "Revert";
		if (!correctnessHolds) decision.reasons.push("correctness is worse");
		if (!costLower) decision.reasons.push("cost per task is not lower");
	} else if (costInterval.high >= 0) {
		decision.verdict = "Inconclusive";
		decision.reasons.push("the gate holds on means, but the 95% interval on the cost change includes no saving");
	} else if (!heldOutRun) {
		decision.verdict = "Inconclusive";
		decision.reasons.push("no held-out task ran: development evidence cannot accept a change");
	}
	const slice = (filter) => ({
		baseline: totals(baseline.rows.filter(filter)),
		candidate: totals(candidate.rows.filter(filter)),
	});
	return {
		baseline: a,
		candidate: b,
		costInterval,
		correctnessInterval,
		regressions,
		improvements,
		slices: {
			dev: slice((row) => row.split === "dev"),
			heldout: slice((row) => row.split === "heldout"),
			delegating: slice((row) => row.delegates),
			direct: slice((row) => !row.delegates),
		},
		routes: { baseline: routes(baseline.rows), candidate: routes(candidate.rows) },
		tasks: pairs.map((pair) => ({
			id: pair.id,
			split: pair.base.split,
			baselinePass: pair.base.passRate,
			candidatePass: pair.cand.passRate,
			baselineCost: pair.base.cost,
			candidateCost: pair.cand.cost,
		})),
		decision,
	};
}

const percent = (value) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);
const money = (value) => (value === null ? "n/a" : `$${value.toFixed(3)}`);
const fixed = (value) => value.toFixed(1);

function metricRows(a, b) {
	return [
		[
			"Correctness",
			`${a.passes}/${a.trials} (${percent(a.correctness)})`,
			`${b.passes}/${b.trials} (${percent(b.correctness)})`,
		],
		["Cost per task", money(a.costPerTask), money(b.costPerTask)],
		["Cost per passing trial", money(a.costPerPass), money(b.costPerPass)],
		["Turns per trial", fixed(a.turns), fixed(b.turns)],
		["Requests per trial", fixed(a.requests), fixed(b.requests)],
		["Cache hit rate", percent(a.cacheHitRate), percent(b.cacheHitRate)],
		[
			"Octocode share (reported only)",
			`${percent(a.octocodeShare)} (${a.octocode}/${a.octocode + a.bashRead})`,
			`${percent(b.octocodeShare)} (${b.octocode}/${b.octocode + b.bashRead})`,
		],
		["Multi-call turn share", percent(a.multiCallTurnShare), percent(b.multiCallTurnShare)],
		["Skill loads", String(a.skillLoads), String(b.skillLoads)],
		["Spent on children", money(a.childCost), money(b.childCost)],
	];
}

function table(rows) {
	const header = ["", "baseline", "candidate"];
	const all = [header, ...rows];
	const widths = header.map((_, column) => Math.max(...all.map((row) => row[column].length)));
	return all
		.map((row) =>
			row
				.map((cell, column) => cell.padEnd(widths[column]))
				.join("  ")
				.trimEnd(),
		)
		.join("\n");
}

function routeLines(label, list) {
	if (list.length === 0) return [`  ${label}: no children ran`];
	return list.map((route) => {
		const models = Object.entries(route.models)
			.map(([model, count]) => `${model} x${count}`)
			.join(", ");
		return `  ${label} ${route.role}: ${route.runs} runs, ${route.requests} requests, ${money(route.cost)}; ${models}`;
	});
}

export function formatComparison(result) {
	const { baseline: a, candidate: b, decision } = result;
	const interval = (range, format) => (range ? `${format(range.low)} to ${format(range.high)}` : "n/a");
	const lines = [table(metricRows(a, b)), ""];
	lines.push(
		`Cost change per task: ${money(b.costPerTask - a.costPerTask)} (95% interval over tasks: ${interval(result.costInterval, money)})`,
	);
	lines.push(
		`Correctness change: ${percent(b.correctness - a.correctness)} (95% interval over tasks: ${interval(result.correctnessInterval, percent)})`,
	);
	lines.push(`Regressed tasks: ${result.regressions.join(", ") || "none"}`);
	lines.push(`Improved tasks: ${result.improvements.join(", ") || "none"}`);
	for (const [name, slice] of Object.entries(result.slices)) {
		if (slice.baseline.trials === 0 && slice.candidate.trials === 0) continue;
		lines.push(
			`Slice ${name}: correctness ${percent(slice.baseline.correctness)} -> ${percent(slice.candidate.correctness)}, cost per task ${money(slice.baseline.costPerTask)} -> ${money(slice.candidate.costPerTask)}`,
		);
	}
	lines.push(
		"Child routes:",
		...routeLines("baseline", result.routes.baseline),
		...routeLines("candidate", result.routes.candidate),
	);
	lines.push("Per task (pass rate, cost):");
	for (const task of result.tasks) {
		lines.push(
			`  ${task.id} [${task.split}]  ${percent(task.baselinePass)} ${money(task.baselineCost)} -> ${percent(task.candidatePass)} ${money(task.candidateCost)}`,
		);
	}
	lines.push("");
	lines.push(
		`Gate (correctness no worse AND cost per task lower): ${decision.gate ? "PASS" : "FAIL"} [correctness ${decision.correctnessHolds ? "holds" : "worse"}, cost ${decision.costLower ? "lower" : "not lower"}]`,
	);
	lines.push(`Verdict: ${decision.verdict}`);
	for (const reason of decision.reasons) lines.push(`  - ${reason}`);
	return lines.join("\n");
}

export const VERDICT_EXIT = { Accept: 0, Revert: 1, Inconclusive: 2, Invalid: 3 };
