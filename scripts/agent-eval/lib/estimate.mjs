/**
 * Cost estimate for a dry run. Prices come from the repository's hydrated model catalog, never from this file. Every
 * other number below is labelled: `measured` values come from local transcripts, `assumed` ones are guesses a live run
 * should replace.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** `CACHE_WRITE_1H_INPUT_MULTIPLIER` in packages/ai/src/models/model-helpers.ts; sessions write 1-hour cache entries. */
const CACHE_WRITE_1H_MULTIPLIER = 2;

const BASIS = {
	source: "transcripts of the 7 days to 2026-11-04 (70 main sessions, 10,546 requests; 26 child sessions)",
	measured: {
		// `outputLow` and `outputHigh`: main's median and mean, then the lowest and highest role mean. Cache hit: from the same transcripts.
		main: { cacheHit: 0.981, firstPrompt: 45_000, meanPrompt: 163_000, outputLow: 499, outputHigh: 757 },
		child: { cacheHit: 0.971, firstPrompt: 22_000, meanPrompt: 124_000, outputLow: 650, outputHigh: 1_050 },
		childRequestsHigh: { researcher: 31, implementer: 44, reviewer: 48 }, // researcher median, implementer ~44, reviewer mean.
	},
	assumed: {
		mainMeanPromptLow: 60_000, // A short task's history stays near its first prompt.
		childMeanPromptLow: 40_000,
		mainRequests: { question: [5, 25], edit: [10, 40], delegate: [4, 15] },
		childRequestsLow: { researcher: 8, implementer: 12, reviewer: 10 },
		// Role front matter (`small`, `medium`) as routed in the measured runs under an Opus parent.
		childRoutes: { researcher: "claude-haiku-5-5", implementer: "claude-sonnet-5-5", reviewer: "claude-sonnet-5-5" },
	},
	crossCheck: "observed: 1-2 request sessions about $0.38, mean $0.071 per main request, median session $2.43",
};

/** The catalog entry of a model, by `provider/id` or bare id: that provider's file first, then any other. */
export function readModelCost(catalogDir, modelRef) {
	if (!existsSync(catalogDir))
		throw new Error(`model catalog not found at ${catalogDir}; run yarn run hydrate:model-data`);
	const slash = modelRef.indexOf("/");
	const provider = slash === -1 ? "anthropic" : modelRef.slice(0, slash);
	const id = slash === -1 ? modelRef : modelRef.slice(slash + 1);
	const files = readdirSync(catalogDir)
		.filter((file) => file.endsWith(".json") && !file.startsWith("."))
		.sort((a, b) => Number(b === `${provider}.json`) - Number(a === `${provider}.json`));
	for (const file of files) {
		const groups = JSON.parse(readFileSync(join(catalogDir, file), "utf8"));
		for (const models of Object.values(groups)) {
			const model = models?.[`chat:${id}`];
			if (model?.cost) return { ...model.cost, source: `${file} chat:${id}` };
		}
	}
	throw new Error(`model ${modelRef} is not in the catalog at ${catalogDir}`);
}

/** The rates in force for a prompt of this size, per `activeRates` and `calculateCost` in model-helpers.ts. */
export function ratesFor(cost, promptTokens, now = Date.now()) {
	const lastDay = cost.until === undefined ? Number.NaN : Date.parse(`${cost.until}T00:00:00Z`);
	const active = cost.after && !Number.isNaN(lastDay) && now >= lastDay + 86_400_000 ? cost.after : cost;
	let rates = active;
	let threshold = -1;
	for (const tier of active.tiers ?? []) {
		if (promptTokens > tier.inputTokensAbove && tier.inputTokensAbove > threshold) {
			rates = tier;
			threshold = tier.inputTokensAbove;
		}
	}
	return rates;
}

/**
 * One agent's cost: the first request writes its whole prompt to the cache; each later one reads the cached share at
 * the hit rate and writes the rest; every request pays its output.
 */
export function runCost({ cost, requests, firstPrompt, meanPrompt, output, cacheHit }) {
	const per = 1_000_000;
	const first = ratesFor(cost, firstPrompt);
	const later = ratesFor(cost, meanPrompt);
	const write = (rates) => (rates.cacheWrite > 0 ? rates.input * CACHE_WRITE_1H_MULTIPLIER : rates.input);
	const firstCost = (firstPrompt * write(first)) / per;
	const blended = cacheHit * later.cacheRead + (1 - cacheHit) * write(later);
	const laterCost = (Math.max(0, requests - 1) * meanPrompt * blended) / per;
	return firstCost + laterCost + (requests * output * later.output) / per;
}

function taskRange(task, mainCost, childCost) {
	const { measured, assumed } = BASIS;
	const kind = task.delegates ? "delegate" : task.kind === "edit" ? "edit" : "question";
	const [lowRequests, highRequests] = assumed.mainRequests[kind];
	const common = { cost: mainCost, firstPrompt: measured.main.firstPrompt, cacheHit: measured.main.cacheHit };
	let low = runCost({
		...common,
		requests: lowRequests,
		meanPrompt: assumed.mainMeanPromptLow,
		output: measured.main.outputLow,
	});
	let high = runCost({
		...common,
		requests: highRequests,
		meanPrompt: measured.main.meanPrompt,
		output: measured.main.outputHigh,
	});
	if (task.delegates) {
		const child = {
			cost: childCost(task.delegates),
			firstPrompt: measured.child.firstPrompt,
			cacheHit: measured.child.cacheHit,
		};
		low += runCost({
			...child,
			requests: assumed.childRequestsLow[task.delegates],
			meanPrompt: assumed.childMeanPromptLow,
			output: measured.child.outputLow,
		});
		high += runCost({
			...child,
			requests: measured.childRequestsHigh[task.delegates],
			meanPrompt: measured.child.meanPrompt,
			output: measured.child.outputHigh,
		});
	}
	return { low, high };
}

/** The range for `runs` repetitions of `tasks` in one arm. */
export function estimateSuite({ tasks, runs, model, catalogDir }) {
	const mainCost = readModelCost(catalogDir, model);
	const children = new Map();
	const childCost = (role) => {
		if (!children.has(role)) children.set(role, readModelCost(catalogDir, BASIS.assumed.childRoutes[role]));
		return children.get(role);
	};
	const perTask = tasks.map((task) => ({ id: task.id, ...taskRange(task, mainCost, childCost) }));
	const low = perTask.reduce((sum, row) => sum + row.low, 0) * runs;
	const high = perTask.reduce((sum, row) => sum + row.high, 0) * runs;
	const rate = (cost) =>
		`input ${cost.input}, output ${cost.output}, cache read ${cost.cacheRead}, cache write ${cost.cacheWrite} (${cost.source})`;
	return {
		perTask,
		low,
		high,
		prices: {
			[model]: rate(mainCost),
			...Object.fromEntries(
				[...children].map(([role, cost]) => [`${role} -> ${BASIS.assumed.childRoutes[role]}`, rate(cost)]),
			),
		},
	};
}

export function formatEstimate(estimate, { arms = 2 } = {}) {
	const money = (value) => `$${value.toFixed(2)}`;
	const lines = [
		`Estimated cost, one arm:  ${money(estimate.low)} to ${money(estimate.high)}`,
		`Estimated cost, ${arms} arms:   ${money(estimate.low * arms)} to ${money(estimate.high * arms)}`,
		"Per task (one run):",
		...estimate.perTask.map((row) => `  ${row.id}  ${money(row.low)} to ${money(row.high)}`),
		"Prices, USD per million tokens, from the catalog:",
		...Object.entries(estimate.prices).map(([name, rate]) => `  ${name}: ${rate}`),
		`Basis, measured from ${BASIS.source}:`,
		`  main: cache hit ${BASIS.measured.main.cacheHit}, first prompt ${BASIS.measured.main.firstPrompt}, mean prompt ${BASIS.measured.main.meanPrompt}, output ${BASIS.measured.main.outputLow}-${BASIS.measured.main.outputHigh}`,
		`  child: cache hit ${BASIS.measured.child.cacheHit}, first prompt ${BASIS.measured.child.firstPrompt}, mean prompt ${BASIS.measured.child.meanPrompt}, output ${BASIS.measured.child.outputLow}-${BASIS.measured.child.outputHigh}; requests (high end) ${JSON.stringify(BASIS.measured.childRequestsHigh)}`,
		`Basis, assumed until a live run replaces it:`,
		`  main requests low/high ${JSON.stringify(BASIS.assumed.mainRequests)}; child requests low ${JSON.stringify(BASIS.assumed.childRequestsLow)}`,
		`  low-end mean prompt: main ${BASIS.assumed.mainMeanPromptLow}, child ${BASIS.assumed.childMeanPromptLow}; child routes ${JSON.stringify(BASIS.assumed.childRoutes)}`,
		`Cross-check, ${BASIS.crossCheck}.`,
		"This is a range for planning, not a quote: a task can exceed it, and --max-usd is what stops spending.",
	];
	return lines.join("\n");
}
