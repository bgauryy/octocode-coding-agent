import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gradeChangedPaths, gradeChild, gradeCommand, gradeFacts, gradeTrial } from "../lib/grader.mjs";

function repository(t) {
	const dir = mkdtempSync(join(tmpdir(), "oc-grader-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const git = (...args) =>
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
			cwd: dir,
			stdio: "pipe",
		});
	git("init", "-q");
	writeFileSync(join(dir, "kept.txt"), "kept\n");
	writeFileSync(join(dir, "gone.txt"), "gone\n");
	writeFileSync(join(dir, ".gitignore"), "\n");
	git("add", "-A");
	git("commit", "-q", "-m", "init");
	return dir;
}

test("facts: every required regex must match and no forbidden one may", () => {
	const grader = { type: "facts", all: ["budget\\.ts", "\\b160\\b"], none: ["\\bmodel\\.ts"] };
	assert.equal(gradeFacts(grader, "See BUDGET.ts: 160.").status, "pass", "case-insensitive by default");
	const missing = gradeFacts(grader, "See budget.ts: 1600.");
	assert.equal(missing.status, "fail");
	assert.deepEqual(missing.evidence.missing, ["\\b160\\b"]);
	const forbidden = gradeFacts(grader, "budget.ts 160, and model.ts");
	assert.equal(forbidden.status, "fail");
	assert.deepEqual(forbidden.evidence.forbidden, ["\\bmodel\\.ts"]);
	assert.equal(gradeFacts({ all: ["ABC"], flags: "" }, "abc").status, "fail", "flags can make it strict");
});

test("child: a role must have run and made a request", () => {
	const grader = { type: "child", role: "researcher" };
	assert.equal(gradeChild(grader, [{ role: "researcher", requests: 3 }]).status, "pass");
	assert.equal(gradeChild(grader, [{ role: "general", requests: 3 }]).status, "fail");
	assert.equal(gradeChild(grader, [{ role: "researcher", requests: 0 }]).status, "fail");
	assert.equal(gradeChild(grader, []).status, "fail");
	assert.equal(gradeChild({ ...grader, min: 2 }, [{ role: "researcher", requests: 1 }]).status, "fail");
});

test("changedPaths: allows, requires and ignores runtime state", (t) => {
	const dir = repository(t);
	const grader = { type: "changedPaths", allow: ["^a\\.txt$", "^sub/b\\.txt$"], require: ["^a\\.txt$"] };
	assert.equal(gradeChangedPaths(grader, dir).status, "fail", "a required change is absent");
	writeFileSync(join(dir, "a.txt"), "new\n");
	mkdirSync(join(dir, "sub"));
	writeFileSync(join(dir, "sub", "b.txt"), "new\n");
	mkdirSync(join(dir, ".octocode", "code"), { recursive: true });
	writeFileSync(join(dir, ".octocode", "code", "state"), "runtime\n");
	mkdirSync(join(dir, ".octocode"), { recursive: true });
	writeFileSync(join(dir, ".octocode", "state"), "runtime\n");
	assert.equal(gradeChangedPaths(grader, dir).status, "pass");
	writeFileSync(join(dir, "kept.txt"), "edited\n");
	const edited = gradeChangedPaths(grader, dir);
	assert.equal(edited.status, "fail");
	assert.deepEqual(edited.evidence.unexpected, ["kept.txt"]);
	rmSync(join(dir, "kept.txt"));
	assert.deepEqual(gradeChangedPaths(grader, dir).evidence.unexpected, ["kept.txt"], "a deletion is a change");
});

test("changedPaths: a directory that is no repository is a grader error, not a failure", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "oc-grader-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	assert.equal(gradeChangedPaths({ allow: [] }, dir).status, "error");
});

test("command: the exit code decides; a crash or timeout is a grader error", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "oc-grader-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const checks = join(dir, "checks");
	mkdirSync(checks);
	writeFileSync(join(checks, "ok.mjs"), "if (!process.env.EVAL_WORKSPACE) process.exit(9);");
	writeFileSync(join(checks, "bad.mjs"), "process.exit(3);");
	writeFileSync(join(checks, "slow.mjs"), "setTimeout(() => {}, 60000);");
	const run = (cmd, extra = {}) =>
		gradeCommand({ cmd, ...extra }, { workspace: dir, checksDir: checks, env: process.env });
	assert.equal(run(["node", "{{checks}}/ok.mjs"]).status, "pass");
	const bad = run(["node", "{{checks}}/bad.mjs"]);
	assert.equal(bad.status, "fail");
	assert.equal(bad.evidence.exitCode, 3);
	assert.equal(run(["node", "{{checks}}/slow.mjs"], { timeoutSec: 0.2 }).status, "error");
	assert.equal(run(["/no/such/command"]).status, "error");
});

test("gradeTrial: a run that did not finish cannot pass, whatever its answer", () => {
	const task = { graders: [{ type: "facts", all: ["right"] }] };
	for (const trialStatus of ["timeout", "agent-error", "budget-stopped", "infra-error"]) {
		assert.equal(gradeTrial(task, { trialStatus, answer: "right", children: [] }).status, "fail");
	}
	assert.equal(gradeTrial(task, { trialStatus: "completed", answer: "right", children: [] }).status, "pass");
});

test("gradeTrial: a failure skips later graders; an error is never a pass", () => {
	const task = {
		graders: [
			{ type: "child", role: "reviewer" },
			{ type: "facts", all: ["right"] },
		],
	};
	const result = gradeTrial(task, { trialStatus: "completed", answer: "right", children: [] });
	assert.equal(result.status, "fail");
	assert.deepEqual(
		result.verdicts.map((item) => item.status),
		["fail", "skipped"],
	);
	const unknown = gradeTrial(
		{ graders: [{ type: "mystery" }] },
		{ trialStatus: "completed", answer: "", children: [] },
	);
	assert.equal(unknown.status, "error");
	assert.equal(gradeTrial({ graders: [] }, { trialStatus: "completed", answer: "", children: [] }).status, "fail");
});
