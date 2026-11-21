/**
 * One trial: an isolated copy of the pinned tree, an isolated user directory, the agent run headless under a cost
 * watch, and its transcripts collected. Nothing here reads the developer's home unless `--copy-config` names a file.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { combineSummaries, summarizeTranscript } from "./transcript.mjs";

const SCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const KILL_GRACE_MS = 10_000;
const EXIT_GRACE_MS = 2_000;
const GIT_IDENTITY = {
	GIT_AUTHOR_NAME: "eval",
	GIT_AUTHOR_EMAIL: "eval@invalid",
	GIT_COMMITTER_NAME: "eval",
	GIT_COMMITTER_EMAIL: "eval@invalid",
};

const git = (cwd, args, env) =>
	execFileSync("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });

/** The solver's environment, built from an allowlist: a variable reaches it only when named here or in `passEnv`. */
function buildEnv({ root, passEnv = [], source = process.env }) {
	const home = join(root, "home");
	const env = {
		PATH: source.PATH ?? "",
		HOME: home,
		USERPROFILE: home,
		TMPDIR: join(root, "tmp"),
		TMP: join(root, "tmp"),
		TEMP: join(root, "tmp"),
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_CACHE_HOME: join(root, "cache"),
		LANG: "C.UTF-8",
		TZ: "UTC",
		NO_COLOR: "1",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
		GIT_EDITOR: "true",
		...GIT_IDENTITY,
		NPM_CONFIG_USERCONFIG: join(root, "npmrc"),
		NPM_CONFIG_GLOBALCONFIG: join(root, "npmrc-global"),
		OCTOCODE_HOME: join(home, ".octocode", "octocodecode"),
		OCTOCODE_PERMISSION: "full",
		OCTOCODE_OFFLINE: "1",
		OCTOCODE_MODELS_DEV: "0",
		OCTOCODE_SKIP_VERSION_CHECK: "1",
		OCTOCODE_TELEMETRY: "0",
		OCTOCODE_MEMORY_AUTO: "0",
	};
	for (const name of passEnv) if (source[name] !== undefined) env[name] = source[name];
	return env;
}

/** Export the pinned tree once per run; each trial extracts it. */
export function exportTree({ repo, ref, into }) {
	const archive = join(into, "tree.tar");
	git(repo, ["archive", "--format=tar", `--output=${archive}`, ref]);
	const listing = spawnSync("tar", ["-tf", archive], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
	if (listing.status !== 0) throw new Error(`cannot list ${archive}: ${listing.stderr}`);
	if (listing.stdout.split("\n").some((path) => path.startsWith("scripts/agent-eval/"))) {
		throw new Error(`${ref} holds scripts/agent-eval: its tasks and answers would reach the solver`);
	}
	return archive;
}

/**
 * The trial's directories and a fresh single-commit repository holding the tree: no history, no link back to the source
 * repository. A task's setup patch lands in that commit or, with `setup.mode: "uncommitted"`, stays as a working change.
 */
export function prepareTrial({ archive, task, suiteDir, copyConfig = [], passEnv = [] }) {
	// The prefix must not contain "agent-eval": the leak check looks for that text in tool arguments.
	const root = mkdtempSync(join(tmpdir(), "oc-trial-"));
	const workspace = join(root, "workspace");
	const sessions = join(root, "sessions");
	for (const dir of [workspace, sessions, join(root, "tmp"), join(root, "cache"), join(root, "home", ".config")]) {
		mkdirSync(dir, { recursive: true });
	}
	const env = buildEnv({ root, passEnv });
	mkdirSync(env.OCTOCODE_HOME, { recursive: true });
	for (const file of [env.NPM_CONFIG_USERCONFIG, env.NPM_CONFIG_GLOBALCONFIG]) writeFileSync(file, "");
	for (const file of copyConfig) {
		const target = join(env.OCTOCODE_HOME, basename(file));
		copyFileSync(file, target);
		chmodSync(target, 0o600);
	}
	execFileSync("tar", ["-xf", archive, "-C", workspace]);
	const applySetup = () => {
		if (task.setup) git(workspace, ["apply", join(suiteDir, task.setup.patch)], env);
	};
	git(workspace, ["init", "-q", "-b", "main"], env);
	if (task.setup?.mode !== "uncommitted") applySetup();
	git(workspace, ["add", "-A"], env);
	git(workspace, ["commit", "-q", "--no-verify", "-m", "checkout"], env);
	if (task.setup?.mode === "uncommitted") applySetup();
	return { root, workspace, sessions, env };
}

function jsonlFiles(dir) {
	try {
		return readdirSync(dir)
			.filter((name) => name.endsWith(".jsonl"))
			.sort()
			.map((name) => join(dir, name));
	} catch {
		return [];
	}
}

/** Child transcripts live in `<workspace>/.octocode/agent/temp/agents/<name>/session/*.jsonl` (`subagents/handoff/scratch.ts`). */
function childTranscripts(workspace) {
	return [".octocode"].flatMap((state) => {
		const agents = join(workspace, state, "agent", "temp", "agents");
		let names;
		try {
			names = readdirSync(agents).sort();
		} catch {
			return [];
		}
		return names.flatMap((name) => jsonlFiles(join(agents, name, "session")).map((file) => ({ name, file })));
	});
}

const readSummary = (file) => summarizeTranscript(readFileSync(file, "utf8"));

/** Cost so far across the main session and every child. A file mid-write only loses its torn last line. */
function trialCost({ sessions, workspace }) {
	const files = [...jsonlFiles(sessions), ...childTranscripts(workspace).map((child) => child.file)];
	return files.reduce((sum, file) => {
		try {
			return sum + readSummary(file).cost;
		} catch {
			return sum;
		}
	}, 0);
}

function killGroup(pid, signal) {
	try {
		process.kill(-pid, signal);
	} catch {
		// The group is already gone.
	}
}

/**
 * Run the agent until it exits, the timeout passes, or `spentBefore` plus this trial's cost reaches `maxUsd`. The cost is
 * read from the transcripts every `pollMs`, so requests in flight when the limit is reached still complete or are lost
 * to the kill, and may overshoot it.
 */
export function runAgent({
	cli,
	model,
	thinking,
	prompt,
	trial,
	outDir,
	timeoutSec,
	maxUsd,
	spentBefore,
	pollMs = 5000,
}) {
	const args = ["-p", prompt, "--model", model, "--session-dir", trial.sessions, "--trust"];
	if (thinking) args.push("--thinking", thinking);
	const [command, commandArgs] = SCRIPT_EXTENSIONS.has(extname(cli)) ? [process.execPath, [cli, ...args]] : [cli, args];
	const started = Date.now();
	return new Promise((done) => {
		const child = spawn(command, commandArgs, {
			cwd: trial.workspace,
			env: trial.env,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdout = [];
		const stderr = [];
		child.stdout.on("data", (chunk) => stdout.push(chunk));
		child.stderr.on("data", (chunk) => stderr.push(chunk));
		let stopped;
		const stop = (reason) => {
			if (stopped) return;
			stopped = reason;
			killGroup(child.pid, "SIGTERM");
			setTimeout(() => killGroup(child.pid, "SIGKILL"), KILL_GRACE_MS).unref();
		};
		const watch = setInterval(() => {
			if (spentBefore + trialCost(trial) >= maxUsd) stop("budget-stopped");
		}, pollMs);
		const limit = setTimeout(() => stop("timeout"), timeoutSec * 1000);
		const finish = (exitCode, spawnError) => {
			clearInterval(watch);
			clearTimeout(limit);
			// Leftover helpers in the group (MCP servers, background children) must not outlive the trial.
			killGroup(child.pid, "SIGKILL");
			writeFileSync(join(outDir, "stdout.txt"), Buffer.concat(stdout));
			writeFileSync(join(outDir, "stderr.txt"), Buffer.concat(stderr));
			done({ exitCode, stopped, spawnError, durationMs: Date.now() - started });
		};
		child.on("error", (error) => finish(null, error.message));
		// A helper that inherited stdout would hold `close` open, so clear the group shortly after the agent itself exits.
		child.on("exit", () => setTimeout(() => killGroup(child.pid, "SIGKILL"), EXIT_GRACE_MS).unref());
		child.on("close", (code) => finish(code));
	});
}

/** Copy the transcripts into the run folder and summarise them: main, each child, and all together. */
export function collectTrial({ trial, outDir }) {
	const mainDir = join(outDir, "transcripts", "main");
	mkdirSync(mainDir, { recursive: true });
	const mainFiles = jsonlFiles(trial.sessions);
	const mainSummaries = mainFiles.map((file) => {
		copyFileSync(file, join(mainDir, basename(file)));
		return readSummary(file);
	});
	const children = childTranscripts(trial.workspace).map(({ name, file }) => {
		const target = join(outDir, "transcripts", "children", name, basename(file));
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(file, target);
		return { name, ...readSummary(file) };
	});
	const main = combineSummaries(mainSummaries);
	const last = mainSummaries.at(-1);
	return {
		hasTranscript: mainFiles.length > 0,
		answer: last?.finalText ?? "",
		lastStopReason: last?.lastStopReason,
		errorMessage: last?.errorMessage,
		main,
		children,
		total: combineSummaries([...mainSummaries, ...children]),
	};
}

/** Why the run did not count as finished, or `completed`. */
export function trialStatus(run, collected) {
	if (run.stopped) return run.stopped;
	// No request reached a model (a bad CLI path, no credentials, a refused folder): nothing was measured.
	if (run.spawnError || !collected.hasTranscript || collected.total.requests === 0) return "infra-error";
	if (run.exitCode !== 0) return "agent-error";
	if (["error", "aborted"].includes(collected.lastStopReason)) return "agent-error";
	return "completed";
}

/** Keep what the solver left in the tree as evidence; the workspace itself is removed. */
export function saveWorkspaceState({ trial, outDir }) {
	if (!existsSync(join(trial.workspace, ".git"))) return;
	try {
		writeFileSync(join(outDir, "status.txt"), git(trial.workspace, ["status", "--porcelain", "-uall"], trial.env));
		git(trial.workspace, ["add", "-A", "--", ":!.octocode", ":!.octa"], trial.env);
		writeFileSync(join(outDir, "final.diff"), git(trial.workspace, ["diff", "--cached"], trial.env));
		git(trial.workspace, ["reset", "-q"], trial.env);
	} catch (error) {
		writeFileSync(join(outDir, "status.txt"), `could not read the workspace: ${error.message}\n`);
	}
}

export function removeTrial(trial) {
	rmSync(trial.root, { recursive: true, force: true });
}
