// One benchmark run of the coding-agent startup profiler, in TUI or RPC mode.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { waitForExit } from "./profile-build.mjs";
import { bundledDistCliPath, packageDir, srcCliPath } from "./profile-paths.mjs";
import { parseStartupTimings } from "./profile-timings.mjs";

const agentDirEnvName = "OCTOCODE_CODING_AGENT_DIR";
const startupBenchmarkEnvName = "OCTOCODE_STARTUP_BENCHMARK";

function getRuntimeCommand(runtime, mode, profileDir, profileName, cpuProfile, nodeEntryPath) {
	const benchmarkArgs = ["--no-session"];
	if (mode === "rpc") {
		benchmarkArgs.push("--mode", "rpc");
	}

	if (runtime === "bun") {
		const args = [];
		if (cpuProfile) {
			args.push("--cpu-prof", `--cpu-prof-dir=${profileDir}`, `--cpu-prof-name=${profileName}`);
		}
		args.push(srcCliPath, ...benchmarkArgs);
		return {
			executable: "bun",
			args,
		};
	}

	const args = [];
	if (cpuProfile) {
		args.push("--cpu-prof", `--cpu-prof-dir=${profileDir}`, `--cpu-prof-name=${profileName}`);
	}
	args.push(nodeEntryPath, ...benchmarkArgs);
	return {
		executable: process.execPath,
		args,
	};
}

/**
 * An isolated run gets its own agent dir, Octocode home and agent database under `tempRoot`: the database path ignores
 * the agent dir (it follows `OCTOCODE_AGENT_DB`, else the home), so isolating the agent dir alone would still open the
 * user's real database.
 */
export function createBenchmarkEnv(options, tempRoot) {
	const env = { ...process.env, OCTOCODE_TIMING: "1" };
	if (options.agentDir) {
		env[agentDirEnvName] = options.agentDir;
	} else if (tempRoot) {
		const home = join(tempRoot, "home");
		env[agentDirEnvName] = join(tempRoot, "agent");
		env.OCTOCODE_HOME = home;
		env.OCTOCODE_AGENT_DB = join(home, "agent", "workspaces.db");
	}
	if (options.mode === "tui") {
		env[startupBenchmarkEnvName] = "1";
	}
	if (options.offline) {
		env.OCTOCODE_OFFLINE = "1";
		env.OCTOCODE_SKIP_VERSION_CHECK = "1";
	}
	return env;
}

async function runTuiBenchmarkRun({ runtime, runIndex, measuredIndex, options, profileDir }) {
	const runNumber = runIndex + 1;
	const suffix = String(runNumber).padStart(3, "0");
	const profileName = `${options.label}-${suffix}.cpuprofile`;
	const tempRoot = options.isolatedAgentDir ? mkdtempSync(join(tmpdir(), "octocode-startup-benchmark-")) : undefined;
	const isolatedAgentDir = tempRoot ? join(tempRoot, "agent") : undefined;
	if (isolatedAgentDir) {
		mkdirSync(isolatedAgentDir, { recursive: true });
	}

	const command = getRuntimeCommand(runtime, "tui", profileDir, profileName, options.cpuProfile, bundledDistCliPath);
	const child = spawn(command.executable, command.args, {
		cwd: packageDir,
		env: createBenchmarkEnv(options, tempRoot),
		stdio: ["inherit", "inherit", "pipe"],
		shell: process.platform === "win32" && runtime === "bun",
	});

	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});

	const startedAt = performance.now();
	const exitCode = await waitForExit(
		child,
		`Benchmark ${measuredIndex === undefined ? `warmup ${runNumber}` : `run ${measuredIndex}`}`,
	);
	const elapsedMs = performance.now() - startedAt;

	try {
		if (exitCode !== 0) {
			throw new Error(stderr.trim() || `Benchmark child exited with code ${exitCode}`);
		}

		const profilePath = options.cpuProfile ? join(profileDir, profileName) : undefined;
		if (profilePath && !existsSync(profilePath)) {
			throw new Error(`CPU profile was not written: ${profilePath}`);
		}

		return { elapsedMs, profilePath, timings: parseStartupTimings(stderr) };
	} finally {
		if (tempRoot) {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	}
}

function splitJsonLines(buffer, onLine) {
	let remaining = buffer;
	while (true) {
		const newlineIndex = remaining.indexOf("\n");
		if (newlineIndex === -1) {
			return remaining;
		}
		const line = remaining.slice(0, newlineIndex);
		onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
		remaining = remaining.slice(newlineIndex + 1);
	}
}

async function runRpcBenchmarkRun({ runtime, runIndex, measuredIndex, options, profileDir }) {
	const runNumber = runIndex + 1;
	const suffix = String(runNumber).padStart(3, "0");
	const profileName = `${options.label}-${suffix}.cpuprofile`;
	const tempRoot = options.isolatedAgentDir ? mkdtempSync(join(tmpdir(), "octocode-startup-benchmark-")) : undefined;
	const isolatedAgentDir = tempRoot ? join(tempRoot, "agent") : undefined;
	if (isolatedAgentDir) {
		mkdirSync(isolatedAgentDir, { recursive: true });
	}

	const command = getRuntimeCommand(runtime, "rpc", profileDir, profileName, options.cpuProfile, bundledDistCliPath);
	const child = spawn(command.executable, command.args, {
		cwd: packageDir,
		env: createBenchmarkEnv(options, tempRoot),
		stdio: ["pipe", "pipe", "pipe"],
		shell: process.platform === "win32" && runtime === "bun",
	});

	let stdoutBuffer = "";
	let stderr = "";
	let readyElapsedMs;
	let responseError;
	const requestId = `startup-benchmark-${runNumber}`;
	const startedAt = performance.now();

	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdoutBuffer = splitJsonLines(stdoutBuffer + chunk, (line) => {
			if (line.trim() === "") {
				return;
			}
			let parsed;
			try {
				parsed = JSON.parse(line);
			} catch (error) {
				responseError = error instanceof Error ? error.message : String(error);
				return;
			}

			if (parsed?.type !== "response" || parsed.id !== requestId || parsed.command !== "get_state") {
				return;
			}

			if (parsed.success !== true) {
				responseError = typeof parsed.error === "string" ? parsed.error : "get_state failed";
				return;
			}

			if (readyElapsedMs === undefined) {
				readyElapsedMs = performance.now() - startedAt;
				child.stdin.end();
			}
		});
	});

	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});

	child.stdin.setDefaultEncoding("utf8");
	child.stdin.write(`${JSON.stringify({ id: requestId, type: "get_state" })}\n`);

	const exitCode = await waitForExit(
		child,
		`Benchmark ${measuredIndex === undefined ? `warmup ${runNumber}` : `run ${measuredIndex}`}`,
	);

	try {
		if (responseError) {
			throw new Error(responseError);
		}
		if (readyElapsedMs === undefined) {
			throw new Error(stderr.trim() || "RPC benchmark did not receive get_state response");
		}
		if (exitCode !== 0) {
			throw new Error(stderr.trim() || `Benchmark child exited with code ${exitCode}`);
		}

		const profilePath = options.cpuProfile ? join(profileDir, profileName) : undefined;
		if (profilePath && !existsSync(profilePath)) {
			throw new Error(`CPU profile was not written: ${profilePath}`);
		}

		return { elapsedMs: readyElapsedMs, profilePath, timings: parseStartupTimings(stderr) };
	} finally {
		if (tempRoot) {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	}
}

export async function runBenchmarkRun(params) {
	if (params.options.mode === "rpc") {
		return runRpcBenchmarkRun(params);
	}
	return runTuiBenchmarkRun(params);
}
