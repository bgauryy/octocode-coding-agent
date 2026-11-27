#!/usr/bin/env node
/**
 * Run the eval suite against one built agent. See README.md. Spending needs `--live --max-usd <n>`; `--dry-run` prints
 * the plan and an estimated range without starting the agent. Anything else refuses.
 */

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { estimateSuite, formatEstimate } from "./lib/estimate.mjs";
import { gradeTrial } from "./lib/grader.mjs";
import { harnessHash, loadSuite, planTrials, selectTasks, suiteHash } from "./lib/suite.mjs";
import {
	collectTrial,
	exportTree,
	prepareTrial,
	removeTrial,
	runAgent,
	saveWorkspaceState,
	trialStatus,
} from "./lib/trial.mjs";
import { cacheHitRate, multiCallTurnShare, octocodeShare } from "./lib/transcript.mjs";

const KIT = import.meta.dirname;
const REPO = resolve(KIT, "..", "..");
const USAGE = `Usage:
  node scripts/agent-eval/run.mjs --dry-run --model <id> [--runs N] [--split dev|heldout|all] [--tasks id,id]
  node scripts/agent-eval/run.mjs --live --max-usd <n> --cli <path> --model <id> --out <dir> [--runs N] [--split ...]

Options: --tasks-file <file>  --repo <dir>  --catalog-dir <dir>  --seed <n>  --thinking <level>  --timeout-sec <n>
         --copy-config <file> (repeatable; copied into the isolated home)  --pass-env <NAME> (repeatable)  --poll-ms <n>`;

const OPTIONS = {
	"dry-run": { type: "boolean" },
	live: { type: "boolean" },
	"max-usd": { type: "string" },
	cli: { type: "string" },
	model: { type: "string" },
	runs: { type: "string", default: "1" },
	out: { type: "string" },
	split: { type: "string", default: "dev" },
	tasks: { type: "string" },
	"tasks-file": { type: "string", default: join(KIT, "tasks.json") },
	repo: { type: "string", default: REPO },
	"catalog-dir": { type: "string", default: join(REPO, "packages", "ai", "src", "providers", "data") },
	seed: { type: "string", default: "1" },
	thinking: { type: "string" },
	"timeout-sec": { type: "string", default: "1800" },
	"copy-config": { type: "string", multiple: true, default: [] },
	"pass-env": { type: "string", multiple: true, default: [] },
	"poll-ms": { type: "string", default: "5000" },
	help: { type: "boolean", short: "h" },
};

function refuse(message) {
	console.error(`Refused: ${message}\n\n${USAGE}`);
	process.exit(2);
}

function positive(name, value) {
	const number = Number(value);
	if (!Number.isFinite(number) || number <= 0) refuse(`--${name} must be a positive number, got ${value}`);
	return number;
}

/** Decide the mode before anything else: without an explicit limit there is no path to a provider call. */
function parseOptions(argv) {
	let values;
	try {
		({ values } = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false }));
	} catch (error) {
		refuse(error.message);
	}
	if (values.help) {
		console.log(USAGE);
		process.exit(0);
	}
	if (values.live && values["dry-run"]) refuse("--live and --dry-run exclude each other");
	if (!values.live && !values["dry-run"]) {
		refuse("live runs spend money. Pass --dry-run for the plan, or --live --max-usd <n> to spend up to that limit");
	}
	if (values.live && values["max-usd"] === undefined) refuse("--live needs --max-usd <n>");
	if (!values.model) refuse("--model is required");
	if (!["dev", "heldout", "all"].includes(values.split)) refuse("--split must be dev, heldout or all");
	const options = {
		...values,
		runs: positive("runs", values.runs),
		seed: Number(values.seed),
		timeoutSec: positive("timeout-sec", values["timeout-sec"]),
		pollMs: positive("poll-ms", values["poll-ms"]),
		maxUsd: values.live ? positive("max-usd", values["max-usd"]) : undefined,
	};
	if (!Number.isInteger(options.runs)) refuse("--runs must be a whole number");
	if (values.live) {
		if (!values.cli) refuse("--live needs --cli <path>");
		if (!existsSync(values.cli)) refuse(`--cli ${String(values.cli)} does not exist; build that tree first`);
		if (!values.out) refuse("--live needs --out <dir>");
		if (existsSync(values.out) && readdirSync(values.out).length > 0) {
			refuse(`--out ${String(values.out)} is not empty; a run never overwrites another`);
		}
		for (const file of values["copy-config"]) if (!existsSync(file)) refuse(`--copy-config ${file} does not exist`);
	}
	return options;
}

function printPlan(options, suite, tasks, trials) {
	const delegated = tasks.filter((task) => task.delegates);
	console.log(`Suite: ${suite.path}`);
	console.log(`Pinned tree: ${suite.ref}`);
	console.log(`Model: ${options.model}   CLI: ${options.cli ?? "(not given; needed with --live)"}`);
	console.log(
		`Selection: split ${options.split}${options.tasks ? `, tasks ${options.tasks}` : ""}; ${options.runs} run(s); seed ${options.seed}`,
	);
	console.log(
		`Trials per arm: ${trials.length} (${tasks.length} tasks, ${delegated.length} delegating: ${delegated.map((task) => `${task.id} ${task.delegates}`).join(", ") || "none"})`,
	);
	console.log(`Order: ${trials.map((trial) => trial.id).join(" ")}`);
	try {
		console.log(
			formatEstimate(
				estimateSuite({ tasks, runs: options.runs, model: options.model, catalogDir: options["catalog-dir"] }),
			),
		);
	} catch (error) {
		console.log(`No estimate: ${error.message}`);
	}
}

function summaryRow(summary) {
	const { finalText: _finalText, lastStopReason: _stop, errorMessage: _error, ...rest } = summary;
	return {
		...rest,
		octocodeShare: octocodeShare(summary),
		multiCallTurnShare: multiCallTurnShare(summary),
		cacheHitRate: cacheHitRate(summary),
	};
}

async function runSuite(options, suite, trials) {
	const out = resolve(options.out);
	mkdirSync(join(out, "trials"), { recursive: true });
	const results = join(out, "results.jsonl");
	writeFileSync(results, "");
	const manifest = {
		suite: suite.path,
		suiteHash: suiteHash(suite),
		harnessHash: harnessHash(),
		ref: suite.ref,
		cli: resolve(options.cli),
		model: options.model,
		thinking: options.thinking,
		runs: options.runs,
		seed: options.seed,
		split: options.split,
		tasks: options.tasks,
		maxUsd: options.maxUsd,
		node: process.version,
		plannedTrials: trials.map((trial) => trial.id),
		startedAt: new Date().toISOString(),
		status: "running",
		spentUsd: 0,
	};
	const saveManifest = () => writeFileSync(join(out, "run.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	saveManifest();
	const exportDir = mkdtempSync(join(tmpdir(), "oc-tree-"));
	let spent = 0;
	try {
		const archive = exportTree({ repo: options.repo, ref: suite.ref, into: exportDir });
		const checksDir = join(suite.dir, "fixtures", "checks");
		for (const planned of trials) {
			if (spent >= options.maxUsd) {
				manifest.status = "stopped-budget";
				console.log(`Stopped: $${spent.toFixed(2)} reached the limit of $${options.maxUsd}.`);
				break;
			}
			const outDir = join(out, "trials", planned.id);
			mkdirSync(outDir, { recursive: true });
			const trial = prepareTrial({
				archive,
				task: planned.task,
				suiteDir: suite.dir,
				copyConfig: options["copy-config"],
				passEnv: options["pass-env"],
			});
			try {
				const prompt = suite.preamble ? `${suite.preamble}\n\n${planned.task.prompt}` : planned.task.prompt;
				writeFileSync(join(outDir, "prompt.txt"), prompt);
				const run = await runAgent({
					cli: options.cli,
					model: options.model,
					thinking: options.thinking,
					prompt,
					trial,
					outDir,
					timeoutSec: options.timeoutSec,
					maxUsd: options.maxUsd,
					spentBefore: spent,
					pollMs: options.pollMs,
				});
				const collected = collectTrial({ trial, outDir });
				const status = trialStatus(run, collected);
				const grade = gradeTrial(planned.task, {
					trialStatus: status,
					answer: collected.answer,
					children: collected.children,
					workspace: trial.workspace,
					checksDir,
					env: trial.env,
				});
				saveWorkspaceState({ trial, outDir });
				writeFileSync(join(outDir, "answer.txt"), collected.answer);
				spent += collected.total.cost;
				const row = {
					trialId: planned.id,
					taskId: planned.task.id,
					split: planned.task.split,
					kind: planned.task.kind,
					delegates: planned.task.delegates ?? null,
					run: planned.run,
					status,
					exitCode: run.exitCode,
					spawnError: run.spawnError,
					errorMessage: collected.errorMessage,
					durationMs: run.durationMs,
					grade: grade.status,
					verdicts: grade.verdicts,
					total: summaryRow(collected.total),
					main: summaryRow(collected.main),
					children: collected.children.map((child) => ({ name: child.name, role: child.role, ...summaryRow(child) })),
				};
				writeFileSync(join(outDir, "result.json"), `${JSON.stringify(row, null, "\t")}\n`);
				appendFileSync(results, `${JSON.stringify(row)}\n`);
				manifest.spentUsd = spent;
				saveManifest();
				console.log(
					`${planned.id}: ${grade.status} (${status}), $${collected.total.cost.toFixed(3)}, ${collected.total.requests} requests; spent $${spent.toFixed(2)} of $${options.maxUsd}`,
				);
				if (status === "budget-stopped") {
					manifest.status = "stopped-budget";
					console.log(`Stopped during ${planned.id}: the limit of $${options.maxUsd} was reached.`);
					break;
				}
				if (status === "infra-error") {
					manifest.status = "failed";
					manifest.error = `${planned.id} reached no model; see ${outDir}/stderr.txt`;
					console.error(`Stopped: ${manifest.error}`);
					break;
				}
			} finally {
				removeTrial(trial);
			}
		}
		if (manifest.status === "running") manifest.status = "complete";
	} catch (error) {
		manifest.status = "failed";
		manifest.error = error.message;
		console.error(`Failed: ${error.message}`);
	} finally {
		rmSync(exportDir, { recursive: true, force: true });
		manifest.endedAt = new Date().toISOString();
		manifest.spentUsd = spent;
		saveManifest();
	}
	console.log(`Run ${manifest.status}: $${spent.toFixed(2)} spent. Results in ${out}`);
	return manifest.status === "complete" ? 0 : 1;
}

const options = parseOptions(process.argv.slice(2));
const suite = loadSuite(options["tasks-file"]);
const tasks = selectTasks(suite, { split: options.split, ids: options.tasks?.split(",") });
const trials = planTrials(tasks, { runs: options.runs, seed: options.seed });
printPlan(options, suite, tasks, trials);
if (options["dry-run"]) {
	console.log("Dry run: the agent was not started and nothing was spent.");
	process.exit(0);
}
process.exit(await runSuite(options, suite, trials));
