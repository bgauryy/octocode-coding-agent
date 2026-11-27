/**
 * The shipped tasks, checked without any model: each reference answer passes its graders, each plausible wrong answer
 * fails, each fact is re-read from the pinned tree, and each edit check fails before its reference fix and passes after.
 * Tests that read the pinned tree skip where the local ref is absent (a fresh clone or CI does not fetch it).
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { gradeChangedPaths, gradeCommand, gradeFacts } from "../lib/grader.mjs";
import { harnessHash, loadSuite, planTrials, selectTasks, suiteHash } from "../lib/suite.mjs";
import { exportTree, prepareTrial, removeTrial } from "../lib/trial.mjs";

const KIT = resolve(import.meta.dirname, "..");
const REPO = resolve(KIT, "..", "..");
const suite = loadSuite(join(KIT, "tasks.json"));
const hasRef = spawnSync("git", ["-C", REPO, "rev-parse", "--verify", "-q", suite.ref]).status === 0;
const skipNoRef = hasRef ? false : `${suite.ref} is not in this clone`;

test("the suite mixes kinds, splits and delegated roles", () => {
	assert.equal(suite.tasks.length, 12);
	const delegated = suite.tasks.filter((task) => task.delegates).map((task) => task.delegates);
	for (const role of ["researcher", "implementer", "reviewer"]) assert.ok(delegated.includes(role), role);
	assert.ok(suite.tasks.filter((task) => task.split === "heldout").length >= 3);
	assert.ok(suite.tasks.some((task) => task.kind === "edit" && !task.delegates));
	for (const task of suite.tasks) {
		if (!task.delegates) continue;
		assert.ok(
			task.graders.some((grader) => grader.type === "child" && grader.role === task.delegates),
			task.id,
		);
		assert.ok(
			task.prompt.includes(`\`${task.delegates}\` profile`),
			`${task.id}: the prompt must ask for the role it grades`,
		);
	}
});

test("a task's id and prompt do not give away its answer", () => {
	for (const task of suite.tasks) {
		assert.match(task.id, /^q-\d{3}$/);
		for (const grader of task.graders) {
			if (grader.type !== "facts") continue;
			const leaked = (grader.all ?? []).filter((source) => new RegExp(source, grader.flags ?? "i").test(task.prompt));
			assert.deepEqual(leaked, [], `${task.id}: the prompt already satisfies these`);
		}
	}
});

for (const task of suite.tasks.filter((item) => item.reference?.answer)) {
	test(`${task.id}: the reference answer passes, wrong answers fail`, () => {
		const facts = task.graders.filter((grader) => grader.type === "facts");
		assert.ok(facts.length > 0);
		for (const grader of facts) {
			assert.deepEqual(gradeFacts(grader, task.reference.answer).evidence, {}, "reference");
		}
		assert.ok(task.reference.wrong.length > 0);
		for (const wrong of task.reference.wrong) {
			assert.ok(
				facts.some((grader) => gradeFacts(grader, wrong).status === "fail"),
				`accepted: ${wrong}`,
			);
		}
		assert.ok(
			facts.every((grader) => gradeFacts(grader, "").status === "fail"),
			"an empty answer must fail",
		);
	});
}

test("selection and order: splits, ids, and the same order for a seed", () => {
	assert.ok(selectTasks(suite, { split: "dev" }).every((task) => task.split === "dev"));
	assert.equal(selectTasks(suite, { split: "all" }).length, suite.tasks.length);
	assert.deepEqual(
		selectTasks(suite, { ids: ["q-002"] }).map((task) => task.id),
		["q-002"],
	);
	assert.throws(() => selectTasks(suite, { ids: ["q-999"] }), /unknown task/);
	const tasks = selectTasks(suite, { split: "all" });
	const ids = (seed) => planTrials(tasks, { runs: 2, seed }).map((trial) => trial.id);
	assert.deepEqual(ids(1), ids(1));
	assert.notDeepEqual(ids(1), ids(2));
	assert.equal(ids(1).length, tasks.length * 2);
	assert.equal(new Set(ids(1)).size, tasks.length * 2);
});

test("fingerprints are stable", () => {
	assert.equal(suiteHash(suite), suiteHash(suite));
	assert.match(harnessHash(), /^[0-9a-f]{64}$/);
});

test("each task's facts hold in the pinned tree", { skip: skipNoRef }, () => {
	const count = suite.tasks.reduce((sum, task) => sum + (task.evidence?.length ?? 0), 0);
	assert.ok(count > 20);
	for (const task of suite.tasks) {
		for (const { path, match } of task.evidence ?? []) {
			const text = execFileSync("git", ["-C", REPO, "show", `${suite.ref}:${path}`], {
				encoding: "utf8",
				maxBuffer: 64 * 1024 * 1024,
			});
			assert.match(text, new RegExp(match), `${task.id}: ${path}`);
		}
	}
});

/** A small repository holding only the paths a task needs, at the pinned ref. */
function checkout(t, paths) {
	const dir = mkdtempSync(join(tmpdir(), "oc-suite-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const archive = join(dir, ".tree.tar");
	execFileSync("git", ["-C", REPO, "archive", "--format=tar", `--output=${archive}`, suite.ref, ...paths]);
	execFileSync("tar", ["-xf", archive, "-C", dir]);
	rmSync(archive);
	const git = (...args) =>
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
			cwd: dir,
			stdio: "pipe",
		});
	git("init", "-q");
	return { dir, git };
}

const applyPatch = (git, patch) => git("apply", join(KIT, patch));

for (const task of suite.tasks.filter((item) => item.reference?.patch)) {
	test(`${task.id}: the check fails before the fix and passes after`, { skip: skipNoRef }, (t) => {
		const { dir, git } = checkout(t, ["packages/common"]);
		if (task.setup) applyPatch(git, task.setup.patch);
		git("add", "-A");
		git("commit", "-q", "-m", "checkout");
		const command = task.graders.find((grader) => grader.type === "command");
		const changed = task.graders.find((grader) => grader.type === "changedPaths");
		const checksDir = join(KIT, "fixtures", "checks");
		const context = { workspace: dir, checksDir, env: process.env };
		assert.equal(gradeCommand(command, context).status, "fail", "the check must fail on the untouched tree");
		assert.equal(gradeChangedPaths(changed, dir).status, "fail", "nothing changed yet");
		applyPatch(git, task.reference.patch);
		const after = gradeCommand(command, context);
		assert.equal(after.status, "pass", after.evidence.output);
		assert.equal(gradeChangedPaths(changed, dir).status, "pass");
	});
}

for (const task of suite.tasks.filter((item) => item.setup?.mode === "uncommitted")) {
	test(`${task.id}: the seeded change applies and shows as a working change`, { skip: skipNoRef }, (t) => {
		const target = readFileSync(join(KIT, task.setup.patch), "utf8").match(/^\+\+\+ b\/(.+)$/m)[1];
		const { dir, git } = checkout(t, [target]);
		git("add", "-A");
		git("commit", "-q", "-m", "checkout");
		applyPatch(git, task.setup.patch);
		const diff = execFileSync("git", ["diff", "--stat"], { cwd: dir, encoding: "utf8" });
		assert.ok(diff.includes(target.split("/").at(-1)), diff);
	});
}

test(
	"a trial over the real pinned tree is one commit, without this kit, with its seeded change",
	{ skip: skipNoRef },
	(t) => {
		const dir = mkdtempSync(join(tmpdir(), "oc-suite-"));
		t.after(() => rmSync(dir, { recursive: true, force: true }));
		const archive = exportTree({ repo: REPO, ref: suite.ref, into: dir });
		const prepare = (task) => {
			const trial = prepareTrial({ archive, task, suiteDir: suite.dir });
			t.after(() => removeTrial(trial));
			return trial;
		};
		const git = (trial, ...args) =>
			execFileSync("git", args, { cwd: trial.workspace, env: trial.env, encoding: "utf8" });

		const review = prepare(suite.tasks.find((task) => task.id === "q-009"));
		assert.equal(git(review, "rev-list", "--count", "HEAD").trim(), "1");
		assert.equal(git(review, "remote").trim(), "");
		assert.ok(!existsSync(join(review.workspace, "scripts", "agent-eval")));
		assert.ok(existsSync(join(review.workspace, "AGENTS.md")), "deployment instructions stay");
		assert.match(git(review, "diff", "--name-only"), /subagents\/budget\.ts/);

		const fix = prepare(suite.tasks.find((task) => task.id === "q-008"));
		assert.equal(git(fix, "status", "--porcelain").trim(), "", "a committed setup leaves a clean tree");
		assert.match(
			readFileSync(join(fix.workspace, "packages/common/src/text.ts"), "utf8"),
			/isHighSurrogate\(text\.charCodeAt\(start\)\)\) start\+\+/,
		);
	},
);
