// Child-process helpers of the coding-agent startup profiler: waiting for exit and the Node build step.

import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { formatMs } from "./profile-timings.mjs";
import { repoRoot } from "./profile-paths.mjs";

export async function waitForExit(child, errorPrefix) {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (signal) {
				reject(new Error(`${errorPrefix} exited from signal ${signal}`));
				return;
			}
			resolve(code ?? 0);
		});
	});
}

/** Builds the workspace libraries and the coding-agent bundle the Node profile runs (`yarn run build:offline`). */
export async function runBuild() {
	process.stdout.write("Building the workspace and the coding-agent bundle...\n");
	const startedAt = performance.now();
	const commands = [{ label: "Build", args: ["run", "build:offline"] }];

	for (const command of commands) {
		const child = spawn("yarn", command.args, {
			cwd: repoRoot,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
			shell: process.platform === "win32",
		});

		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});

		const exitCode = await waitForExit(child, command.label);
		if (exitCode !== 0) {
			if (stdout.trim()) {
				process.stdout.write(`${stdout}${stdout.endsWith("\n") ? "" : "\n"}`);
			}
			if (stderr.trim()) {
				process.stderr.write(`${stderr}${stderr.endsWith("\n") ? "" : "\n"}`);
			}
			throw new Error(`${command.label} failed with exit code ${exitCode}`);
		}
	}

	process.stdout.write(`Build completed in ${formatMs(performance.now() - startedAt)}\n`);
}
