import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { compareRuns, loadRun } from "../lib/compare.mjs";

const KIT = resolve(import.meta.dirname, "..");
const RUN = join(KIT, "run.mjs");
const FAKE = join(KIT, "test", "fake-cli.mjs");
const REF = "refs/octocode/test-tree";

function sandbox(t) {
	const dir = mkdtempSync(join(tmpdir(), "oc-run-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** A tiny source repository, a suite over it and a catalog, so nothing touches the real tree or a provider. */
function suiteFixture(dir, tasks) {
	const repo = join(dir, "repo");
	mkdirSync(repo);
	const git = (...args) =>
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
			cwd: repo,
			stdio: "pipe",
		});
	git("init", "-q");
	writeFileSync(join(repo, "file.txt"), "one\n");
	git("add", "-A");
	git("commit", "-q", "-m", "init");
	git("update-ref", REF, "HEAD");
	const suiteDir = join(dir, "suite");
	mkdirSync(join(suiteDir, "fixtures", "checks"), { recursive: true });
	writeFileSync(
		join(suiteDir, "fixtures", "checks", "file.check.mjs"),
		'import { readFileSync } from "node:fs";\nprocess.exit(readFileSync("file.txt", "utf8") === "two\\n" ? 0 : 1);\n',
	);
	const tasksFile = join(suiteDir, "tasks.json");
	writeFileSync(tasksFile, JSON.stringify({ ref: REF, preamble: "Preamble.", tasks }));
	const catalog = join(dir, "catalog");
	mkdirSync(catalog);
	writeFileSync(
		join(catalog, "anthropic.json"),
		JSON.stringify({
			"anthropic-messages": {
				"chat:fake-main": { cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } },
				"chat:claude-sonnet-5-5": { cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 } },
				"chat:claude-haiku-5-5": { cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 } },
			},
		}),
	);
	return { repo, tasksFile, catalog };
}

const FACT_TASK = {
	id: "q-1",
	split: "dev",
	kind: "question",
	prompt: "Say right.",
	graders: [{ type: "facts", all: ["right"] }],
};

function run(args, env = {}) {
	return spawnSync(process.execPath, [RUN, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
}

function live(fixture, out, scenario, dir, extra = []) {
	const scenarioFile = join(dir, `scenario-${readdirSync(dir).length}.json`);
	writeFileSync(scenarioFile, JSON.stringify(scenario));
	return run(
		[
			"--live",
			"--max-usd",
			"5",
			"--cli",
			FAKE,
			"--model",
			"fake-main",
			"--out",
			out,
			"--tasks-file",
			fixture.tasksFile,
			"--repo",
			fixture.repo,
			"--catalog-dir",
			fixture.catalog,
			"--pass-env",
			"FAKE_CLI_SCENARIO",
			"--poll-ms",
			"20",
			...extra,
		],
		{
			FAKE_CLI_SCENARIO: scenarioFile,
			EVAL_SECRET_TEST: "leak-me",
			OCTOCODE_AGENT_ID: "outer",
			OCTOCODE_PARENT_SESSION: "outer",
		},
	);
}

const readRows = (out) =>
	readFileSync(join(out, "results.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));

test("refuses without an explicit mode or limit, and starts nothing", (t) => {
	const dir = sandbox(t);
	const marker = join(dir, "started");
	const cli = join(dir, "cli.mjs");
	writeFileSync(cli, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "x");\n`);
	const base = ["--cli", cli, "--model", "m", "--out", join(dir, "out")];
	for (const [args, pattern] of [
		[base, /spend money/],
		[["--live", ...base], /--max-usd/],
		[["--live", "--max-usd", "0", ...base], /positive/],
		[["--live", "--max-usd=-1", ...base], /positive/],
		[["--live", "--max-usd", "-1", ...base], /ambiguous/],
		[["--live", "--max-usd", "lots", ...base], /positive/],
		[["--live", "--dry-run", "--max-usd", "1", ...base], /exclude/],
		[["--live", "--max-usd", "1", "--model", "m"], /--cli/],
		[["--live", "--max-usd", "1", "--model", "m", "--cli", cli], /--out/],
		[
			["--live", "--max-usd", "1", "--model", "m", "--out", join(dir, "o"), "--cli", join(dir, "absent")],
			/does not exist/,
		],
		[["--dry-run"], /--model/],
		[["--unknown"], /Unknown option/i],
	]) {
		const result = run(args);
		assert.equal(result.status, 2, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
		assert.match(result.stderr, pattern);
		assert.ok(!existsSync(marker), `${args.join(" ")} started the agent`);
		assert.ok(!existsSync(join(dir, "out")));
	}
});

test("refuses a used output folder", (t) => {
	const dir = sandbox(t);
	const out = join(dir, "out");
	mkdirSync(out);
	writeFileSync(join(out, "run.json"), "{}");
	const result = run(["--live", "--max-usd", "1", "--cli", FAKE, "--model", "m", "--out", out]);
	assert.equal(result.status, 2);
	assert.match(result.stderr, /not empty/);
});

test("a dry run prints the plan and range and starts nothing", (t) => {
	const dir = sandbox(t);
	const fixture = suiteFixture(dir, [FACT_TASK]);
	const result = run([
		"--dry-run",
		"--model",
		"fake-main",
		"--runs",
		"3",
		"--tasks-file",
		fixture.tasksFile,
		"--catalog-dir",
		fixture.catalog,
	]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Trials per arm: 3/);
	assert.match(result.stdout, /Estimated cost, one arm: +\$\d+\.\d+ to \$\d+\.\d+/);
	assert.match(result.stdout, /measured from/);
	assert.match(result.stdout, /assumed until a live run/);
	assert.match(result.stdout, /nothing was spent/);
});

test("the real suite's dry run covers its tasks, with catalog prices", (t) => {
	const dir = sandbox(t);
	const { catalog } = suiteFixture(dir, [FACT_TASK]);
	const result = run(["--dry-run", "--model", "fake-main", "--split", "all", "--catalog-dir", catalog]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Trials per arm: 12 \(12 tasks, 5 delegating/);
	assert.match(result.stdout, /anthropic\.json chat:claude-sonnet-5-5/);
});

function checkFakeRun(t, build) {
	const dir = sandbox(t);
	const tasks = [
		{
			id: "q-2",
			split: "dev",
			kind: "edit",
			delegates: "researcher",
			prompt: "Change the file.",
			graders: [
				{ type: "child", role: "researcher" },
				{ type: "changedPaths", allow: ["^file\\.txt$"], require: ["^file\\.txt$"] },
				{ type: "command", cmd: ["node", "{{checks}}/file.check.mjs"] },
				{ type: "facts", all: ["done"] },
			],
		},
	];
	const fixture = suiteFixture(dir, tasks);
	const out = join(dir, "out");
	const envDump = join(dir, "env.json");
	const result = live(
		fixture,
		out,
		{
			answer: "done",
			baseline: build === "baseline",
			requests: 3,
			costPerRequest: 0.1,
			envDump,
			writes: { "file.txt": "two\n" },
			children: [{ name: "brisk-otter", role: "researcher", cost: 0.05, model: "fake-small" }],
		},
		dir,
	);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	const [row] = readRows(out);
	assert.equal(row.status, "completed");
	assert.equal(row.grade, "pass", JSON.stringify(row.verdicts));
	assert.equal(row.main.requests, 3);
	assert.equal(row.total.requests, 5, "children count in the total");
	assert.ok(Math.abs(row.total.cost - 0.4) < 1e-9);
	assert.equal(row.total.tools.octocode, 2);
	assert.equal(row.total.tools.bashRead, 3);
	assert.equal(row.main.multiCallTurnShare, 1);
	assert.equal(row.children[0].role, "researcher");
	assert.deepEqual(row.children[0].models, { "fake-small": 2 });

	const trial = join(out, "trials", "q-2-r1");
	assert.ok(existsSync(join(trial, "transcripts", "main", "main.jsonl")));
	assert.ok(existsSync(join(trial, "transcripts", "children", "brisk-otter", "child.jsonl")));
	assert.match(readFileSync(join(trial, "final.diff"), "utf8"), /\+two/);
	assert.equal(readFileSync(join(trial, "answer.txt"), "utf8"), "done");
	assert.match(readFileSync(join(trial, "prompt.txt"), "utf8"), /^Preamble\.\n\nChange the file\.$/);

	const { env, cwd, args } = JSON.parse(readFileSync(envDump, "utf8"));
	assert.ok(env.HOME.includes("oc-trial-"));
	assert.ok(env.OCTOCODE_HOME.startsWith(env.HOME));
	assert.notEqual(env.HOME, process.env.HOME);
	assert.equal(env.OCTOCODE_MEMORY_AUTO, "0");
	assert.equal(env.OCTOCODE_PERMISSION, "full");
	for (const name of [
		"EVAL_SECRET_TEST",
		"OCTOCODE_AGENT_ID",
		"OCTOCODE_PARENT_SESSION",
		"CLAUDE_CONFIG_DIR",
		"ANTHROPIC_API_KEY",
	]) {
		assert.equal(env[name], undefined, name);
	}
	assert.ok(args.includes("--trust") && args.includes("-p") && args.includes("--session-dir"));
	assert.ok(!existsSync(cwd), "the workspace is removed");
	const manifest = JSON.parse(readFileSync(join(out, "run.json"), "utf8"));
	assert.equal(manifest.status, "complete");
	assert.equal(manifest.ref, REF);
}

for (const build of ["candidate", "baseline"]) {
	test(`a fake ${build} run checks isolation, grading, children and evidence`, (t) => checkFakeRun(t, build));
}

test("the trial workspace has no history and copied config stays in the isolated home", (t) => {
	const dir = sandbox(t);
	const fixture = suiteFixture(dir, [FACT_TASK]);
	const secret = join(dir, "auth.json");
	writeFileSync(secret, '{"k":"v"}');
	const check = join(dir, "inspect.mjs");
	const report = join(dir, "inspect.json");
	writeFileSync(
		check,
		`import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const count = execFileSync("git", ["rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim();
const remotes = execFileSync("git", ["remote"], { encoding: "utf8" }).trim();
const home = process.env.OCTOCODE_HOME;
writeFileSync(${JSON.stringify(report)}, JSON.stringify({ count, remotes, copied: existsSync(join(home, "auth.json")) }));
const sessions = process.argv[process.argv.indexOf("--session-dir") + 1];
const usage = { input: 1, output: 1, cost: { total: 0.01 } };
writeFileSync(join(sessions, "m.jsonl"), JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop", usage, content: [{ type: "text", text: "right" }] } }) + "\\n");
`,
	);
	const out = join(dir, "out");
	const result = run([
		"--live",
		"--max-usd",
		"1",
		"--cli",
		check,
		"--model",
		"m",
		"--out",
		out,
		"--tasks-file",
		fixture.tasksFile,
		"--repo",
		fixture.repo,
		"--catalog-dir",
		fixture.catalog,
		"--copy-config",
		secret,
	]);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.deepEqual(JSON.parse(readFileSync(report, "utf8")), { count: "1", remotes: "", copied: true });
	assert.equal(readRows(out)[0].grade, "pass");
	const copies = spawnSync("grep", ["-rl", '"k":"v"', out], { encoding: "utf8" });
	assert.equal(copies.status, 1, `the secret reached the run folder: ${copies.stdout}`);
});

test("stops when the cumulative cost reaches the limit, mid-trial and before the next", (t) => {
	const dir = sandbox(t);
	const second = { ...FACT_TASK, id: "q-9" };
	const fixture = suiteFixture(dir, [FACT_TASK, second]);
	const out = join(dir, "out");
	const scenario = { answer: "right", requests: 200, costPerRequest: 1, sleepMs: 50 };
	const result = live(fixture, out, scenario, dir);
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.match(result.stdout, /limit of \$5 was reached/);
	const manifest = JSON.parse(readFileSync(join(out, "run.json"), "utf8"));
	assert.equal(manifest.status, "stopped-budget");
	const rows = readRows(out);
	assert.equal(rows.length, 1, "the second trial never started");
	assert.equal(rows[0].status, "budget-stopped");
	assert.equal(rows[0].grade, "fail");
	assert.ok(manifest.spentUsd >= 5, `spent ${manifest.spentUsd}`);
	assert.ok(manifest.spentUsd < 50, `spent ${manifest.spentUsd}: the agent was not killed`);
});

test("a cost that reaches the limit between trials stops the next one", (t) => {
	const dir = sandbox(t);
	const second = { ...FACT_TASK, id: "q-9" };
	const fixture = suiteFixture(dir, [FACT_TASK, second]);
	const out = join(dir, "out");
	const result = live(fixture, out, { answer: "right", requests: 2, costPerRequest: 1 }, dir, ["--max-usd", "2"]);
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.match(result.stdout, /Stopped/);
	assert.equal(JSON.parse(readFileSync(join(out, "run.json"), "utf8")).status, "stopped-budget");
	assert.equal(readRows(out).length, 1);
});

test("an agent that reaches no model stops the run as an infrastructure failure", (t) => {
	const dir = sandbox(t);
	const fixture = suiteFixture(dir, [FACT_TASK, { ...FACT_TASK, id: "q-9" }]);
	const out = join(dir, "out");
	const result = live(fixture, out, { exitWithoutTranscript: true }, dir);
	assert.equal(result.status, 1);
	const manifest = JSON.parse(readFileSync(join(out, "run.json"), "utf8"));
	assert.equal(manifest.status, "failed");
	const rows = readRows(out);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].status, "infra-error");
});

test("a tree that holds the kit is refused before any trial", (t) => {
	const dir = sandbox(t);
	const fixture = suiteFixture(dir, [FACT_TASK]);
	const git = (...args) =>
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
			cwd: fixture.repo,
			stdio: "pipe",
		});
	mkdirSync(join(fixture.repo, "scripts", "agent-eval"), { recursive: true });
	writeFileSync(join(fixture.repo, "scripts", "agent-eval", "tasks.json"), "{}");
	git("add", "-A");
	git("commit", "-q", "-m", "leak");
	git("update-ref", REF, "HEAD");
	const out = join(dir, "out");
	const result = live(fixture, out, { answer: "right" }, dir);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /would reach the solver/);
	assert.equal(JSON.parse(readFileSync(join(out, "run.json"), "utf8")).status, "failed");
});

test("two fake arms compare end to end", (t) => {
	const dir = sandbox(t);
	const fixture = suiteFixture(dir, [{ ...FACT_TASK, split: "heldout" }]);
	const baseline = join(dir, "baseline");
	const candidate = join(dir, "candidate");
	const flags = ["--split", "heldout"];
	assert.equal(live(fixture, baseline, { answer: "right", requests: 4, costPerRequest: 0.2 }, dir, flags).status, 0);
	assert.equal(live(fixture, candidate, { answer: "right", requests: 2, costPerRequest: 0.2 }, dir, flags).status, 0);
	const result = compareRuns(loadRun(baseline), loadRun(candidate));
	assert.deepEqual(result.decision.reasons, []);
	assert.equal(result.decision.verdict, "Accept");
});
