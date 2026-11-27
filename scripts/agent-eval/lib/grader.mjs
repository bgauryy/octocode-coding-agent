/**
 * Deterministic graders. Each returns a verdict: `pass`, `fail`, `error` (the grader itself could not decide) or
 * `skipped` (an earlier check already failed, so a costlier one did not run). An error never counts as a pass.
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

// `.octa` is where a build from before the rename keeps its state, such as the eval baseline.
const IGNORED_CHANGES = [/^\.octocode\//, /^\.octa\//];

const verdict = (type, status, evidence) => ({ type, status, evidence });

export function gradeFacts(grader, answer) {
	const flags = grader.flags ?? "i";
	const missing = (grader.all ?? []).filter((source) => !new RegExp(source, flags).test(answer));
	const forbidden = (grader.none ?? []).filter((source) => new RegExp(source, flags).test(answer));
	if (missing.length === 0 && forbidden.length === 0) return verdict("facts", "pass", {});
	return verdict("facts", "fail", { missing, forbidden });
}

export function gradeChild(grader, children) {
	const matching = children.filter((child) => child.role === grader.role && child.requests > 0);
	const min = grader.min ?? 1;
	const status = matching.length >= min ? "pass" : "fail";
	return verdict("child", status, { role: grader.role, min, found: children.map((child) => child.role) });
}

/** Paths `git status` reports as changed: both sides of a rename, runtime state left out. */
function changedPaths(workspace) {
	const result = spawnSync("git", ["status", "--porcelain", "-uall", "--no-renames", "-z"], {
		cwd: workspace,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.status !== 0) throw new Error(result.stderr || result.error?.message || "git status failed");
	return result.stdout
		.split("\0")
		.filter(Boolean)
		.map((row) => row.slice(3))
		.filter((path) => !IGNORED_CHANGES.some((ignored) => ignored.test(path)));
}

export function gradeChangedPaths(grader, workspace) {
	let paths;
	try {
		paths = changedPaths(workspace);
	} catch (error) {
		return verdict("changedPaths", "error", { message: error.message });
	}
	const allowed = (grader.allow ?? []).map((source) => new RegExp(source));
	const unexpected = paths.filter((path) => !allowed.some((pattern) => pattern.test(path)));
	const absent = (grader.require ?? []).filter((source) => !paths.some((path) => new RegExp(source).test(path)));
	const status = unexpected.length === 0 && absent.length === 0 ? "pass" : "fail";
	return verdict("changedPaths", status, { paths, unexpected, absent });
}

/** A command's exit code decides. It runs after the solver stopped, from files the solver's workspace never held. */
export function gradeCommand(grader, { workspace, checksDir, env }) {
	const [command, ...args] = grader.cmd.map((part) => part.replaceAll("{{checks}}", checksDir));
	const result = spawnSync(command, args, {
		cwd: workspace,
		encoding: "utf8",
		timeout: (grader.timeoutSec ?? 120) * 1000,
		maxBuffer: 16 * 1024 * 1024,
		env: { ...env, EVAL_WORKSPACE: resolve(workspace) },
	});
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-4000);
	if (result.error) return verdict("command", "error", { message: result.error.message, output });
	if (result.signal) return verdict("command", "error", { signal: result.signal, output });
	return verdict("command", result.status === 0 ? "pass" : "fail", { exitCode: result.status, output });
}

/**
 * Grade one finished trial: `{status, verdicts}`. Graders run in the task's order and a failure skips the rest, so list
 * cheap checks first. Only a run that finished normally can pass: a timeout or provider error fails even with a right
 * answer in its partial transcript.
 */
export function gradeTrial(task, { trialStatus, answer, children, workspace, checksDir, env }) {
	if (trialStatus !== "completed") {
		return { status: "fail", verdicts: [verdict("run", "fail", { trialStatus })] };
	}
	const verdicts = [];
	let stopped = false;
	for (const grader of task.graders) {
		if (stopped) {
			verdicts.push(verdict(grader.type, "skipped", {}));
			continue;
		}
		let result;
		if (grader.type === "facts") result = gradeFacts(grader, answer);
		else if (grader.type === "child") result = gradeChild(grader, children);
		else if (grader.type === "changedPaths") result = gradeChangedPaths(grader, workspace);
		else if (grader.type === "command") result = gradeCommand(grader, { workspace, checksDir, env });
		else result = verdict(grader.type, "error", { message: `unknown grader type ${grader.type}` });
		verdicts.push(result);
		if (result.status !== "pass") stopped = true;
	}
	if (verdicts.some((item) => item.status === "error")) return { status: "error", verdicts };
	if (verdicts.length === 0 || verdicts.some((item) => item.status === "fail")) return { status: "fail", verdicts };
	return { status: "pass", verdicts };
}
